"use client";

// "Editor de Itens" -- pedido do Douglas: cadastrar móvel novo direto
// pela tela (upload de imagem), sem precisar organizar pasta local nem
// rodar `npm run sync-assets`, e sem ficar salvo só no computador dele
// -- guardado no Supabase (Storage + tabela room_items, ver
// supabase/migrations/0002_room_items.sql). Só aparece pro DONO da
// sala (ver isOwner/roomRole em GameRoom.tsx, mesmo gate do painel de
// membros).
//
// Upload vai DIRETO do navegador pro Storage (usa o token da própria
// pessoa -- a policy do bucket confere "é owner?" no banco, ver a
// migration) -- só os METADADOS (nome/categoria/URLs já prontas) vão
// pro nosso servidor (POST /api/items, PATCH /api/items/[id]), que
// confere de novo antes de gravar.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CUSTOM_ITEM_TARGET_WIDTH } from "@/game/furniture";
import { TILE } from "@/game/grid";
import { FRAME_W, FRAME_H, AVATAR_SCALE, AVATAR_FOOT_OFFSET_Y } from "@/game/MainScene";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  SKIN_CATALOG,
  DEFAULT_SKIN_ID,
  OUTFIT_CATALOG,
  DEFAULT_OUTFIT_ID,
  outfitFileForSkin,
  AvatarGender,
} from "@/game/customization";

type CategoryId = "poltrona" | "divisoria" | "sofa" | "mesa" | "planta" | "computador";
type DirectionKey = "down" | "left" | "right" | "up";

// múltiplo de folga acima do tamanho que o item aparece no jogo (ver
// CUSTOM_ITEM_TARGET_WIDTH em game/furniture.ts) -- pedido do Douglas:
// gera no ChatGPT, monta no Canva, redimensiona pro tamanho final e só
// depois sobe aqui. Isso custava um tanto de qualidade nesse
// redimensionamento manual (e ida-e-volta pra eu ajudar a acertar o
// tamanho), e além disso ele notou que de LONGE (zoom afastado) o móvel
// borra mesmo de perto tendo qualidade -- isso é o efeito clássico de
// encolher demais uma textura no WebGL sem ela ter uma versão
// intermediária: quanto maior a diferença entre o tamanho do arquivo e o
// tamanho exibido, mais a GPU "erra a média" dos pixels ao amostrar pra
// baixo, e borra. Por isso a imagem AGORA é redimensionada aqui no
// navegador (resizeImageForUpload, logo abaixo) pra um teto de ~3x o
// tamanho final -- folga o suficiente pra ficar nítido em qualquer
// zoom (a mesma técnica de "arte em alta, exibida menor" que sites/apps
// bons usam pra tela Retina), sem sobrar tanta diferença que borre. A
// pessoa não precisa mais encolher NADA à mão -- sobe do jeito que
// gerou/montou, em qualquer resolução, e esse teto só corta o excesso.
const UPLOAD_SUPERSAMPLE = 3;

// pedido do Douglas: as imagens que ele gera não vêm num padrão de
// proporção (uma poltrona pode sair "quadrada", outra "alongada"), então
// o mesmo alvo de largura por CATEGORIA (CUSTOM_ITEM_TARGET_WIDTH) dava
// resultado de tamanho bem diferente de item pra item -- precisa ajustar
// cada um à mão, olhando o resultado. displayWidth (abaixo) é esse
// ajuste, mostrado ao vivo no preview grande (ver item-stage) antes de
// cadastrar -- persistido por ITEM (não por categoria, ver
// display_width em supabase/migrations/0003_room_items_display_width.sql
// e o uso em addFurnitureSprite, MainScene.ts). Min/max/step escalados
// 1.5x junto com a resolução interna do jogo (mesma proporção de antes).
const DISPLAY_WIDTH_MIN = 60;
const DISPLAY_WIDTH_MAX = 600;
const DISPLAY_WIDTH_STEP = 8;

// mesmo teto -300..300 da constraint no banco (ver
// supabase/migrations/0004_room_items_icon_offset.sql).
const OFFSET_LIMIT = 300;

// tamanho alvo (px, na TELA -- não no jogo) do botão do catálogo (ver
// .palette-btn em app/globals.css) -- usado só pra calcular o teto de
// upload do ÍCONE (mesma ideia do UPLOAD_SUPERSAMPLE acima, aplicado a
// um alvo bem menor que o dos uploads de direção).
const ICON_BUTTON_SIZE = 48;

// fator só pra deixar o card GRANDE o suficiente pra enxergar bem
// (pedido do Douglas: "preciso disso num card maior, com a imagem
// maior") -- multiplica avatar, item E tile pelo MESMO número, então a
// PROPORÇÃO entre os três continua idêntica à do jogo de verdade, só
// maior na tela.
const PREVIEW_SCALE = 2.5;

// altura do "boneco real" no preview (pedido do Douglas: "quero boneco
// real ali dentro em perspectiva certa, e o quadrado também", ver
// item-stage-avatar abaixo) -- FRAME_H/AVATAR_SCALE vêm de
// game/MainScene.ts (exportados só pra isso, ver comentário lá) em vez
// de duplicados à mão aqui: single source of truth, sem risco de
// desalinhar numa próxima mudança de escala do jogo (quase aconteceu
// antes com um AVATAR_REF_HEIGHT calculado à mão que esse preview
// substituiu).
const AVATAR_DISPLAY_H = FRAME_H * AVATAR_SCALE * PREVIEW_SCALE;
const AVATAR_DISPLAY_W = FRAME_W * AVATAR_SCALE * PREVIEW_SCALE;
// distância (px, na tela) do pé do boneco até a borda de BAIXO do tile
// -- o boneco ancora no CENTRO do tile (+ AVATAR_FOOT_OFFSET_Y pra
// baixo, só visual, ver comentário em MainScene.ts), o móvel ancora na
// borda de BAIXO (ver furnitureWorldPos, game/furniture.ts) -- são
// pontos DIFERENTES do mesmo quadrado, por isso o boneco "flutua" um
// pouco acima da base do tile no preview -- é assim no jogo de verdade
// também.
const AVATAR_FOOT_FROM_TILE_BOTTOM = (TILE / 2 - AVATAR_FOOT_OFFSET_Y) * PREVIEW_SCALE;
const TILE_SIZE_PX = TILE * PREVIEW_SCALE;
// margem abaixo da base do tile -- espaço pra arrastar o item pra baixo
// (offsetY positivo) e pro quadrado continuar visível inteiro.
const STAGE_BASELINE_PAD = 70;
const STAGE_HEIGHT = Math.ceil(STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM + AVATAR_DISPLAY_H + 24);

// "boneco de referência" pro preview -- SEMPRE o penteado/tom/traje
// PADRÃO (não é o boneco de verdade de ninguém, é só uma régua visual),
// igual o resto do editor já fazia com a silhueta antiga. Traje
// PRECISA ser um de verdade (não "Nenhum"/DEFAULT_OUTFIT_ID, que é um
// arquivo transparente): desde que a camada base virou só cabeça (ver
// scripts/syncSkinAssets.mjs), o boneco de referência ficaria sem corpo
// nenhum com o traje padrão.
const REFERENCE_HAIR = HAIR_CATALOG.find((h) => h.id === DEFAULT_HAIR_ID) ?? HAIR_CATALOG[0];
const REFERENCE_SKIN = SKIN_CATALOG.find((s) => s.id === DEFAULT_SKIN_ID) ?? SKIN_CATALOG[0];
const REFERENCE_OUTFIT = OUTFIT_CATALOG.find((o) => o.id !== DEFAULT_OUTFIT_ID) ?? OUTFIT_CATALOG[0];
const REFERENCE_OUTFIT_FILE = REFERENCE_OUTFIT ? outfitFileForSkin(REFERENCE_OUTFIT, DEFAULT_SKIN_ID) : undefined;

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "poltrona", label: "Poltrona" },
  { id: "divisoria", label: "Divisória" },
  { id: "sofa", label: "Sofá" },
  { id: "mesa", label: "Mesa" },
  { id: "planta", label: "Planta" },
  { id: "computador", label: "Computador" },
];

// palpite inicial de "Tem interação?" a partir da categoria escolhida
// (mesmo critério de sempre -- ver isSittableFurnitureType em
// game/furniture.ts) -- só o ponto de partida no formulário de item
// NOVO, o Douglas pode mudar à mão (ver seletor "Tem interação?").
const DEFAULT_SITTABLE_BY_CATEGORY: Record<CategoryId, boolean> = {
  poltrona: true,
  sofa: true,
  divisoria: false,
  mesa: false,
  planta: false,
  computador: false,
};

// "down/left/right/up" = mesma convenção de direção do resto do jogo
// (ver game/grid.ts) -- rótulo em português só pro formulário.
const DIRECTION_FIELDS: { key: DirectionKey; label: string; required: boolean }[] = [
  { key: "down", label: "Frente", required: true },
  { key: "left", label: "Lado esquerdo", required: false },
  { key: "right", label: "Lado direito", required: false },
  { key: "up", label: "Costas", required: false },
];

type CustomItemRow = {
  id: string;
  label: string;
  category: CategoryId;
  art: Partial<Record<DirectionKey, string>>;
  icon_url: string | null;
  display_width: number | null;
  offset_x: number | null;
  offset_y: number | null;
  direction_offsets: Partial<Record<Exclude<DirectionKey, "down">, { x: number; y: number }>> | null;
  sittable: boolean | null;
  seat_offset_x: number | null;
  seat_offset_y: number | null;
};

// mesma faixa -100..100 da constraint em supabase/migrations/
// 0007_room_items_direction_offsets_seat.sql -- ajuste de assento é
// sempre um nudge pequeno, não precisa da faixa toda do offset de
// posição (OFFSET_LIMIT acima).
const SEAT_OFFSET_LIMIT = 100;

/**
 * Encolhe (só encolhe, nunca aumenta) a imagem pra no máximo maxWidth
 * de largura ANTES de subir pro Storage -- ver UPLOAD_SUPERSAMPLE acima
 * pro porquê. Usa createImageBitmap + canvas (2D, com suavização "high")
 * em vez de mandar o arquivo cru: mais barato que mandar o arquivo
 * gigante e o navegador aguenta tranquilo (é só um redimensionamento,
 * roda na hora, sem travar a tela). Se alguma etapa falhar (formato
 * exótico, navegador antigo) devolve o arquivo ORIGINAL sem esse corte
 * -- upload continua funcionando, só sem o benefício do teto de tamanho.
 */
async function resizeImageForUpload(file: File, maxWidth: number): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= maxWidth) {
      bitmap.close?.();
      return file;
    }
    const scale = maxWidth / bitmap.width;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
  } catch (e) {
    console.warn("Não deu pra redimensionar a imagem antes de subir, mandando original", e);
    return file;
  }
}

function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "item"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type CustomSkinRow = {
  id: string;
  label: string;
  gender: AvatarGender;
  sheet_url: string;
  hex: string | null;
};

type CustomAvatarItemRow = {
  id: string;
  category: "cabelo" | "acessorio" | "barba" | "traje";
  gender: AvatarGender;
  label: string;
  skin_ids: string[] | null;
  sheet_url: string;
};

// qual direção (ver DIRECTION_FIELDS acima) cada um dos 15 quadros da
// folha usa -- MESMA ordem/esquema de FRAME_SLOTS/SLOTS_BY_DIRECTION em
// scripts/syncSkinAssets.mjs (duplicado aqui de propósito: é o FORMATO
// do arquivo que o jogo espera, não muda, e importar um script .mjs de
// Node dentro de um componente React não rola). A cabeça de cada direção
// é reaproveitada nos 3-4 quadros dela (parado/passoA/passoB/sentado) --
// só "up" (costas) não tem quadro de sentado, mesma observação de sempre
// (reusa o quadro 9 direto em MainScene.ts).
const SKIN_SHEET_SLOT_DIRECTIONS: DirectionKey[] = [
  "down", "down", "down",
  "left", "left", "left",
  "right", "right", "right",
  "up", "up", "up",
  "down", "left", "right",
];
const SKIN_SHEET_COLS = 8;
const SKIN_SHEET_SPACING = 2;

// "avatar" (tom de pele -- pedido do Douglas: "esse 'tom' é a cabeça")
// vira a primeira categoria do fluxo, irmã de cabelo/acessório/barba/
// traje -- MESMO formulário, botões acima ("sexo/avatar-cabelo-etc/cor")
// -- ver pedido do Douglas: "ordem de seleção, tudo em botões: Masculino/
// feminino, avatar/cabelo/acessório/barba/traje". Continua indo pra
// tabela avatar_skins (não avatar_items -- ver comentário na migration
// 0006_avatar_items.sql) por ser a definição de um TOM, não algo que
// "aplica pra" um tom.
type AvatarCreatorCategory = "avatar" | "avatar_padrao" | "cabelo" | "acessorio" | "barba" | "traje";

const AVATAR_CREATOR_CATEGORIES: { id: AvatarCreatorCategory; label: string }[] = [
  { id: "avatar", label: "Avatar" },
  { id: "avatar_padrao", label: "Avatar Padrão" },
  { id: "cabelo", label: "Cabelo" },
  { id: "acessorio", label: "Acessório" },
  { id: "barba", label: "Barba" },
  { id: "traje", label: "Traje" },
];

// "Avatar Padrão" (pedido do Douglas: "cria uma opcao ao lado de avatar,
// que só pode ter UMA em cada um deles... esse avatar eu vou subir:
// cabeca e traje apenas, o traje na vdd vai ser o corpo limpo... esse
// padrao voce coloca ele inteiro montado no editor quando eu for criar
// outros... ai eu uso ele exatamente de referencia sempre") -- ATÉ
// AGORA o boneco de referência do editor (ver referenceSkin abaixo) era
// só o tom de pele CRU, que por convenção é só a CABEÇA (ver comentário
// em supabase/migrations/0005_avatar_skins.sql) -- então editar
// cabelo/traje/etc contra ele mostrava uma cabeça flutuando, sem corpo
// nenhum de referência. "Avatar Padrão" resolve isso: UM tom de pele
// (cabeça) + UM traje (corpo limpo, sem roupa de verdade) marcados como
// "o padrão" daquele sexo -- só 1 por sexo (upsert por gender na tabela
// nova, ver app/api/avatar-default-reference), meio ortogonal ao
// catálogo normal de tons/trajes (não aparece nos seletores de jogo,
// serve só de referência fixa aqui no editor). Empilha os dois (traje
// embaixo, base/cabeça em cima -- mesma ordem de LAYER_DRAW_ORDER em
// MainScene.ts) no lugar do referenceSkin sozinho pras outras 4
// categorias (cabelo/acessório/barba/traje), ver defaultReference mais
// abaixo.
type DefaultReferenceRow = { gender: AvatarGender; head_sheet_url: string; body_sheet_url: string };

// barba/acessório só têm 3 poses de verdade (sem "costas" -- não dá pra
// ver de trás da cabeça mesmo, ver scripts/syncBeardAssets.mjs/
// syncAccessoryAssets.mjs) -- essas duas categorias escondem o upload
// de "Costas" e deixam o quadro de "up" transparente na folha final.
const THREE_POSE_CATEGORIES = new Set<AvatarCreatorCategory>(["barba", "acessorio"]);

// categorias cuja arte precisa combinar com o TOM DE PELE escolhido (a
// mão/pescoço ficam expostos -- ver bySkin em game/customization.ts).
// Cabelo/acessório não têm bySkin (mesma arte serve em qualquer tom),
// então não mostram o seletor "aplica pra qual tom" abaixo.
const BY_SKIN_CATEGORIES = new Set<AvatarCreatorCategory>(["barba", "traje"]);

type SheetSlot = DirectionKey | "blank";

const FOUR_DIR_SHEET_SLOTS: SheetSlot[] = SKIN_SHEET_SLOT_DIRECTIONS;
// mesmo layout de FRAME_SLOTS em scripts/syncBeardAssets.mjs/
// syncAccessoryAssets.mjs -- "up" (índices 9-11) fica em branco.
const THREE_DIR_SHEET_SLOTS: SheetSlot[] = [
  "down", "down", "down",
  "left", "left", "left",
  "right", "right", "right",
  "blank", "blank", "blank",
  "down", "left", "right",
];

// primeiro quadro (índice 0-based na folha 8x2) de cada direção -- usado
// só pra mostrar o boneco de referência na POSE certa no editor de
// posição (ver frameOffsetXPx/frameOffsetYPx mais abaixo), mesmos
// índices de SKIN_SHEET_SLOT_DIRECTIONS acima.
const DIRECTION_FIRST_FRAME_INDEX: Record<DirectionKey, number> = { down: 0, left: 3, right: 6, up: 9 };

// pose SENTADO por direção (mesmo índice de frame que SENTADO_FRAMES em
// game/MainScene.ts -- não dá pra importar de lá porque é um const
// privado do módulo, não exportado, então replica aqui como o resto
// desse arquivo já faz com DIRECTION_FIRST_FRAME_INDEX acima). "up" não
// tem arte sentado-de-costas própria ainda, cai na mesma pose em pé
// virado pra trás (frame 9), igual o jogo faz.
const SEAT_FRAME_INDEX: Record<DirectionKey, number> = { down: 12, left: 13, right: 14, up: 9 };

// posição/tamanho de UMA foto de direção dentro do quadro 200x260 --
// pedido do Douglas: "preciso posicionar e redimensionar" -- ajustado
// arrastando/com slider no editor (ver handleArtPointerDown mais
// abaixo). offsetX/offsetY em px de JOGO (mesma unidade do offset do
// mobi), scale MULTIPLICA o "contido" automático (1 = exatamente
// fit:"contain" centralizado, igual ao comportamento de antes).
type DirectionPlacement = { offsetX: number; offsetY: number; scale: number };
const DEFAULT_PLACEMENT: DirectionPlacement = { offsetX: 0, offsetY: 0, scale: 1 };
const PLACEMENT_OFFSET_LIMIT = 150;

// nomes canônicos de tom (pedido do Douglas: "branco pardo negro") --
// só pra categoria "Avatar" (criar um TOM novo): diferente das outras 4
// categorias (que escolhem quais tons JÁ EXISTENTES a peça cobre, ver
// BY_SKIN_CATEGORIES acima e genderSkins mais abaixo), aqui a pessoa tá
// DEFININDO o tom, não aplicando numa lista -- por isso fixo em 3
// botões (não vem do catálogo), com a cor de botão já sugerida (mesmo
// hex que SKIN_HEX_BY_NAME em scripts/syncSkinAssets.mjs usa).
const AVATAR_TONE_NAMES: { label: string; hex: string }[] = [
  { label: "Branco", hex: "#fde6b5" },
  { label: "Pardo", hex: "#d1a276" },
  { label: "Negro", hex: "#765e48" },
];

/**
 * Resolve a URL de uma arte de camada de avatar -- local (public/assets/)
 * ou CUSTOM (URL completa do Supabase Storage, ver SkinOption.file em
 * game/customization.ts). Mesmo helper que GameRoom.tsx já tem
 * (furnitureAssetUrl), duplicado aqui de propósito -- GameRoom já
 * importa ItemEditor, importar de volta criaria ciclo.
 */
function avatarAssetUrl(file: string): string {
  return file.startsWith("http") ? file : `/assets/${file}`;
}

/**
 * Monta a folha de sprites (8x2, 200x260 por quadro -- mesmo formato de
 * public/assets/avatar_<tom>.png, ver scripts/syncSkinAssets.mjs) DIRETO
 * NO NAVEGADOR pra QUALQUER camada de avatar (tom de pele, cabelo,
 * acessório, barba, traje) a partir das fotos por direção, cada uma com
 * seu PRÓPRIO posicionamento (ver DirectionPlacement acima -- pedido do
 * Douglas: "preciso posicionar e redimensionar"). Sem posicionamento
 * ajustado pra uma direção, cai no "contido" centralizado de sempre
 * (mesma ideia do `fit:"contain"` que o pipeline local usa via sharp).
 * `slots` decide o layout das 15 posições (ver FOUR_DIR_SHEET_SLOTS/
 * THREE_DIR_SHEET_SLOTS acima) -- "blank" fica transparente (barba/
 * acessório não têm arte de costas).
 */
async function composeAvatarArtSheet(
  filesByDirection: Partial<Record<DirectionKey, File>>,
  placements: Partial<Record<DirectionKey, DirectionPlacement>>,
  slots: SheetSlot[]
): Promise<Blob> {
  const neededDirs = Array.from(new Set(slots.filter((s): s is DirectionKey => s !== "blank")));
  const bitmaps: Partial<Record<DirectionKey, ImageBitmap>> = {};
  for (const dir of neededDirs) {
    const file = filesByDirection[dir];
    if (file) bitmaps[dir] = await createImageBitmap(file);
  }

  const canvas = document.createElement("canvas");
  canvas.width = SKIN_SHEET_COLS * (FRAME_W + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  canvas.height = 2 * (FRAME_H + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("navegador sem suporte a canvas 2D");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  slots.forEach((slot, i) => {
    if (slot === "blank") return;
    const bitmap = bitmaps[slot];
    if (!bitmap) return;
    const placement = placements[slot] ?? DEFAULT_PLACEMENT;
    const col = i % SKIN_SHEET_COLS;
    const row = Math.floor(i / SKIN_SHEET_COLS);
    const cellX = col * (FRAME_W + SKIN_SHEET_SPACING);
    const cellY = row * (FRAME_H + SKIN_SHEET_SPACING);
    const baseScale = Math.min(FRAME_W / bitmap.width, FRAME_H / bitmap.height);
    const scale = baseScale * placement.scale;
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const centerX = cellX + FRAME_W / 2 + placement.offsetX;
    const centerY = cellY + FRAME_H / 2 + placement.offsetY;
    ctx.drawImage(bitmap, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
  });
  for (const bitmap of Object.values(bitmaps)) bitmap?.close?.();

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("erro ao montar a folha de sprites");
  return blob;
}

/**
 * Botão "Criar Avatar" do Editor de Itens (pedido do Douglas: "quero
 * subir os personagens DENTRO da plataforma"). Fluxo em 4 passos, tudo
 * em botões (pedido do Douglas: "ordem de seleção, tudo em botões"):
 * 1) sexo (masculino/feminino), 2) categoria (avatar/cabelo/acessório/
 * barba/traje), 3) pra categoria com bySkin (barba/traje), pra qual(is)
 * tom(ns) de pele já cadastrado(s) isso vale (pedido: "selecionar pra
 * qual cor vai... podendo selecionar todos") -- pra "avatar" em vez
 * disso escolhe QUAL tom novo tá criando (Branco/Pardo/Negro); cabelo/
 * acessório pulam esse passo (não dependem de tom, ver
 * BY_SKIN_CATEGORIES acima); 4) fotos por direção + editor de posição/
 * tamanho (arrastar + slider, pedido do Douglas: "preciso posicionar e
 * redimensionar"), reaproveitando o boneco de referência JÁ na pose da
 * direção escolhida.
 *
 * "Avatar" continua indo pra tabela avatar_skins (POST /api/avatar-skins,
 * já existia); as outras 4 categorias vão pra tabela nova avatar_items
 * (POST /api/avatar-items, ver supabase/migrations/0006_avatar_items.sql
 * -- PRECISA rodar essa migration antes de usar). Mesmo esquema de
 * upload direto pro Storage que o resto do Editor de Itens já usa. Sem
 * editar/apagar ainda (nenhuma das duas APIs tem PATCH/DELETE -- só
 * criar, fica pra depois se o Douglas pedir).
 */
function AvatarCreatorPanel({ accessToken, onChanged }: { accessToken: string; onChanged: () => void }) {
  const [category, setCategory] = useState<AvatarCreatorCategory>("avatar");
  const [gender, setGender] = useState<AvatarGender>("masculino");
  const [label, setLabel] = useState("");
  const [hex, setHex] = useState(AVATAR_TONE_NAMES[0].hex);
  const [selectedSkinIds, setSelectedSkinIds] = useState<string[]>([]);
  // nome "raw" de propósito -- ver files/setFiles computados mais abaixo
  // (indireção pra "Avatar Padrão" reusar a mesma UI com 2 pares
  // separados de arquivo/posição, um pra cabeça e outro pro traje).
  const [rawFiles, setRawFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [rawPlacements, setRawPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>({});
  const [activeDirection, setActiveDirection] = useState<DirectionKey>("down");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skins, setSkins] = useState<CustomSkinRow[] | null>(null);
  const [avatarItems, setAvatarItems] = useState<CustomAvatarItemRow[] | null>(null);
  // "Avatar Padrão" (ver DefaultReferenceRow/comentário acima) -- duas
  // fotos por direção SEPARADAS (cabeça e traje/corpo limpo), cada uma
  // com o próprio estado de arquivo/posição, chaveadas por
  // padraoPart. defaultReference guarda o que JÁ está salvo (1 por
  // sexo), buscado à parte de skins/avatarItems porque não é um item
  // "normal" (não aparece em nenhum seletor de jogo).
  const [padraoPart, setPadraoPart] = useState<"cabeca" | "traje">("cabeca");
  const [padraoHeadFiles, setPadraoHeadFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [padraoHeadPlacements, setPadraoHeadPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>(
    {}
  );
  const [padraoBodyFiles, setPadraoBodyFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [padraoBodyPlacements, setPadraoBodyPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>(
    {}
  );
  const [defaultReference, setDefaultReference] = useState<Record<AvatarGender, DefaultReferenceRow | null>>({
    masculino: null,
    feminino: null,
  });
  const fileInputRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const isAvatarPadrao = category === "avatar_padrao";
  const isThreePose = THREE_POSE_CATEGORIES.has(category);
  const activeDirectionFields = isThreePose ? DIRECTION_FIELDS.filter((f) => f.key !== "up") : DIRECTION_FIELDS;
  const activeSlots = isThreePose ? THREE_DIR_SHEET_SLOTS : FOUR_DIR_SHEET_SLOTS;
  const usesBySkin = BY_SKIN_CATEGORIES.has(category);
  // tons já cadastrados (pasta local + "Avatar" acima) do SEXO
  // escolhido -- é a partir daqui que barba/traje escolhem "pra qual
  // tom vale" (ver comentário no tipo AvatarCreatorCategory acima).
  const genderSkins = SKIN_CATALOG.filter((s) => (s.gender ?? "masculino") === gender);

  // "Avatar Padrão" usa os MESMOS campos de upload/prévia/arraste que
  // as outras categorias (files/placements), só que apontando pro par
  // certo (cabeça ou traje) em vez do estado único -- assim não precisa
  // duplicar toda a UI de baixo, só trocar pra onde ela lê/escreve.
  const files = isAvatarPadrao ? (padraoPart === "cabeca" ? padraoHeadFiles : padraoBodyFiles) : rawFiles;
  const setFiles = isAvatarPadrao ? (padraoPart === "cabeca" ? setPadraoHeadFiles : setPadraoBodyFiles) : setRawFiles;
  const placements = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? padraoHeadPlacements
      : padraoBodyPlacements
    : rawPlacements;
  const setPlacements = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? setPadraoHeadPlacements
      : setPadraoBodyPlacements
    : setRawPlacements;

  async function loadSkins() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("avatar_skins")
      .select("id, label, gender, sheet_url, hex");
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setSkins((data ?? []) as CustomSkinRow[]);
  }

  async function loadAvatarItems() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // sem `error` aqui de propósito: a tabela só existe depois que o
    // Douglas rodar 0006_avatar_items.sql -- até lá, essa consulta falha
    // (tabela não existe) e a lista fica vazia em silêncio, sem travar o
    // resto do painel (ver mesmo cuidado em fetchAndRegisterCustomAvatarItems,
    // GameRoom.tsx).
    const { data } = await supabase
      .from("avatar_items")
      .select("id, category, gender, label, skin_ids, sheet_url");
    setAvatarItems((data ?? []) as CustomAvatarItemRow[]);
  }

  // "Avatar Padrão" (ver DefaultReferenceRow acima) -- tabela própria,
  // só 1 linha por sexo, sem PATCH/DELETE ainda (mesmo estágio de
  // skins/avatarItems -- o POST já faz upsert por gender, ver
  // app/api/avatar-default-reference). Ausente/tabela não criada ainda
  // = fica null em silêncio (mesmo cuidado de loadAvatarItems acima),
  // as outras categorias então caem no referenceSkin cru de sempre.
  async function loadDefaultReference() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("avatar_default_reference").select("gender, head_sheet_url, body_sheet_url");
    const next: Record<AvatarGender, DefaultReferenceRow | null> = { masculino: null, feminino: null };
    for (const row of (data ?? []) as DefaultReferenceRow[]) {
      if (row.gender === "masculino" || row.gender === "feminino") next[row.gender] = row;
    }
    setDefaultReference(next);
  }

  useEffect(() => {
    loadSkins();
    loadAvatarItems();
    loadDefaultReference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preview da foto ATIVA (aba de direção escolhida) -- se essa direção
  // ainda não tem foto própria, cai na de "frente" só pra mostrar (mesma
  // prévia rápida de sempre), mas SEM deixar arrastar (ver hasOwnFile no
  // JSX) -- não faz sentido ajustar posição de uma direção que nem tem
  // arte própria ainda.
  const hasOwnFile = Boolean(files[activeDirection]);
  const activeFile = files[activeDirection] ?? files.down;
  const activePlacement = hasOwnFile ? placements[activeDirection] ?? DEFAULT_PLACEMENT : DEFAULT_PLACEMENT;

  const [activeArtUrl, setActiveArtUrl] = useState<string | null>(null);
  const activeArtUrlRef = useRef<string | null>(null);
  activeArtUrlRef.current = activeArtUrl;

  useEffect(() => {
    setActiveArtUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return activeFile ? URL.createObjectURL(activeFile) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  useEffect(() => {
    return () => {
      if (activeArtUrlRef.current) URL.revokeObjectURL(activeArtUrlRef.current);
    };
  }, []);

  function resetCreatorForm() {
    setLabel("");
    setHex(AVATAR_TONE_NAMES[0].hex);
    setSelectedSkinIds([]);
    setRawFiles({});
    setRawPlacements({});
    setPadraoHeadFiles({});
    setPadraoHeadPlacements({});
    setPadraoBodyFiles({});
    setPadraoBodyPlacements({});
    setPadraoPart("cabeca");
    setActiveDirection("down");
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  }

  function handleCategoryChange(next: AvatarCreatorCategory) {
    setCategory(next);
    resetCreatorForm();
  }

  function handleGenderChange(next: AvatarGender) {
    setGender(next);
    setSelectedSkinIds([]);
  }

  // arrastar a foto ativa em cima do boneco de referência (mesmo esquema
  // de handleItemPointerDown do mobi, mais abaixo) -- offsetX/offsetY em
  // px de JOGO, convertidos do delta de tela pelo PREVIEW_SCALE.
  function handleArtPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const dir = activeDirection;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const start = placements[dir] ?? DEFAULT_PLACEMENT;
    const startOffsetX = start.offsetX;
    const startOffsetY = start.offsetY;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      setPlacements((prev) => ({
        ...prev,
        [dir]: {
          ...(prev[dir] ?? DEFAULT_PLACEMENT),
          offsetX: clamp(Math.round(startOffsetX + dx), -PLACEMENT_OFFSET_LIMIT, PLACEMENT_OFFSET_LIMIT),
          offsetY: clamp(Math.round(startOffsetY + dy), -PLACEMENT_OFFSET_LIMIT, PLACEMENT_OFFSET_LIMIT),
        },
      }));
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  // "Avatar Padrão" salva DIFERENTE do resto: 2 folhas (cabeça + traje,
  // ver padraoHeadFiles/padraoBodyFiles acima) numa tabela própria com
  // upsert por gender (só 1 por sexo, ver app/api/avatar-default-reference)
  // -- sem nome/tom pra escolher, então nem usa trimmedLabel/usesBySkin
  // do fluxo normal abaixo.
  async function handleAvatarPadraoSubmit() {
    if (!padraoHeadFiles.down) {
      setError("A foto de frente da CABEÇA é obrigatória.");
      return;
    }
    if (!padraoBodyFiles.down) {
      setError("A foto de frente do TRAJE (corpo limpo) é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    try {
      const headBlob = await composeAvatarArtSheet(padraoHeadFiles, padraoHeadPlacements, FOUR_DIR_SHEET_SLOTS);
      const bodyBlob = await composeAvatarArtSheet(padraoBodyFiles, padraoBodyPlacements, FOUR_DIR_SHEET_SLOTS);
      const stamp = Date.now();
      const headPath = `avatar-default-reference/${gender}-cabeca-${stamp}.png`;
      const bodyPath = `avatar-default-reference/${gender}-traje-${stamp}.png`;
      const { error: headUploadError } = await supabase.storage
        .from("room-items")
        .upload(headPath, headBlob, { upsert: false, contentType: "image/png" });
      if (headUploadError) throw headUploadError;
      const { error: bodyUploadError } = await supabase.storage
        .from("room-items")
        .upload(bodyPath, bodyBlob, { upsert: false, contentType: "image/png" });
      if (bodyUploadError) throw bodyUploadError;
      const { data: headUrlData } = supabase.storage.from("room-items").getPublicUrl(headPath);
      const { data: bodyUrlData } = supabase.storage.from("room-items").getPublicUrl(bodyPath);
      const res = await fetch("/api/avatar-default-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          gender,
          headSheetUrl: headUrlData.publicUrl,
          bodySheetUrl: bodyUrlData.publicUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar avatar padrão");
      await loadDefaultReference();
      resetCreatorForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao salvar");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAvatarCreatorSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isAvatarPadrao) {
      await handleAvatarPadraoSubmit();
      return;
    }
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError(category === "avatar" ? "Escolha um tom (Branco/Pardo/Negro)." : "Dá um nome pro item.");
      return;
    }
    if (!files.down) {
      setError("A imagem de frente é obrigatória.");
      return;
    }
    if (usesBySkin && selectedSkinIds.length === 0) {
      setError("Selecione pra qual tom de pele isso vale.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    try {
      const sheetBlob = await composeAvatarArtSheet(files, placements, activeSlots);
      const slug = slugify(trimmedLabel);
      const pathPrefix = category === "avatar" ? "avatar-skins" : "avatar-items";
      const path = `${pathPrefix}/${category}-${gender}-${slug}-${Date.now()}.png`;
      const { error: uploadError } = await supabase.storage.from("room-items").upload(path, sheetBlob, {
        upsert: false,
        contentType: "image/png",
      });
      if (uploadError) throw uploadError;
      const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);

      if (category === "avatar") {
        const res = await fetch("/api/avatar-skins", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ label: trimmedLabel, gender, sheetUrl: publicUrlData.publicUrl, hex }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar tom de pele");
        await loadSkins();
      } else {
        const res = await fetch("/api/avatar-items", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            category,
            gender,
            label: trimmedLabel,
            skinIds: selectedSkinIds,
            sheetUrl: publicUrlData.publicUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar item");
        await loadAvatarItems();
      }

      resetCreatorForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao salvar");
    } finally {
      setSubmitting(false);
    }
  }

  // boneco de referência do editor de posição -- sexo-ciente (pega o
  // primeiro tom cadastrado do sexo escolhido, não sempre o masculino
  // padrão como o resto do editor faz pro móvel) e NA POSE da direção
  // ativa (ver DIRECTION_FIRST_FRAME_INDEX acima) -- pedido do Douglas:
  // "editor de posicionamento dos itens... em relação ao avatar". CRU
  // de propósito (só o tom de pele -- SEM cabelo/traje padrão em cima,
  // pedido do Douglas: "nessa aba o avatar tem que estar cru, pra
  // adicionar os itens") -- cabelo/traje/barba/acessório "de fábrica"
  // só confundiriam a posição de quem tá sendo cadastrado agora,
  // inclusive quando a categoria É cabelo/traje (arte de referência
  // diferente da que tá subindo, sobreposta/atrás sem sentido nenhum).
  // sem NENHUM tom cadastrado ainda pro sexo escolhido (pedido do
  // Douglas: "cadê o tile na rotação, tô sem referência pra subir
  // avatar" -- ficava sem boneco NENHUM nesse caso, só a foto subida
  // sozinha, sem nada atrás pra servir de referência de posição/
  // tamanho) -- cai num tom de QUALQUER sexo só pra não deixar o
  // preview vazio (proporção do corpo pode não bater exatamente, mas
  // ainda dá um boneco de verdade pra alinhar a foto por cima). Aviso
  // embaixo (ver referenceSkinIsFallback) quando isso acontece.
  // pedido do Douglas: "a cabeça selecionada deveria aparecer no editor,
  // na posição que eu setei ela, pra dai sim eu salvar o restante a
  // partir dela, e que fique travado nela" -- em categoria bySkin
  // (barba/traje), o boneco de referência tem que ser o(s) TOM(NS) que
  // a pessoa marcou nos chips acima (ver tone-chip mais abaixo), não
  // qualquer um do mesmo sexo -- senão a posição alinhada no editor
  // (contra um corpo) pode não bater com o corpo de verdade que a peça
  // vai vestir. Só cai no "qualquer um do sexo" (ou de outro sexo, ver
  // referenceSkinIsFallback) quando ainda não marcou nenhum tom, ou a
  // categoria nem usa bySkin (cabelo/acessório, onde não existe seleção
  // de tom pra começo de conversa).
  const selectedReferenceSkin =
    usesBySkin && selectedSkinIds.length > 0 ? SKIN_CATALOG.find((s) => s.id === selectedSkinIds[0]) : undefined;
  // "Avatar Padrão" do sexo (ver DefaultReferenceRow acima) -- só entra
  // pra categorias que NÃO são avatar/avatar_padrao (essas continuam
  // cruas de propósito, ver comentário grande acima). Pedido do
  // Douglas: "esse padrao voce coloca ele inteiro montado no editor
  // quando eu for criar outros... eu uso ele exatamente de referencia
  // sempre, pra tudo em avatares".
  const genderDefaultReference = !isAvatarPadrao && category !== "avatar" ? defaultReference[gender] : null;
  const referenceSkin = selectedReferenceSkin ?? genderSkins[0] ?? SKIN_CATALOG[0];
  const referenceSkinIsFallback =
    Boolean(referenceSkin) && !selectedReferenceSkin && !genderDefaultReference && genderSkins.length === 0;
  // URL da CABEÇA mostrada no boneco: tom explicitamente selecionado (ver
  // selectedReferenceSkin acima) vence sempre que existir; senão, o
  // Avatar Padrão do sexo (mais estável/consistente que "qualquer tom
  // cadastrado"); senão cai no referenceSkin de sempre.
  const referenceHeadUrl = selectedReferenceSkin
    ? avatarAssetUrl(selectedReferenceSkin.file)
    : genderDefaultReference
      ? avatarAssetUrl(genderDefaultReference.head_sheet_url)
      : referenceSkin
        ? avatarAssetUrl(referenceSkin.file)
        : undefined;
  // corpo/traje "limpo" do Avatar Padrão, desenhado ATRÁS da cabeça
  // (mesma ordem de LAYER_DRAW_ORDER em MainScene.ts: traje antes de
  // base) -- independe de qual cabeça/tom tá sendo mostrada em cima.
  const referenceBodyUrl = genderDefaultReference ? avatarAssetUrl(genderDefaultReference.body_sheet_url) : undefined;
  const activeFrameIndex = DIRECTION_FIRST_FRAME_INDEX[activeDirection];
  const frameCol = activeFrameIndex % SKIN_SHEET_COLS;
  const frameRow = Math.floor(activeFrameIndex / SKIN_SHEET_COLS);
  const frameOffsetXPx = frameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const frameOffsetYPx = frameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  const activeDirectionLabel = activeDirectionFields.find((f) => f.key === activeDirection)?.label ?? activeDirection;

  return (
    <>
      <div className="gender-switch">
        <button
          type="button"
          className={gender === "masculino" ? "gender-btn selected" : "gender-btn"}
          onClick={() => handleGenderChange("masculino")}
        >
          Masculino
        </button>
        <button
          type="button"
          className={gender === "feminino" ? "gender-btn selected" : "gender-btn"}
          onClick={() => handleGenderChange("feminino")}
        >
          Feminino
        </button>
      </div>

      <div className="edit-section-tabs">
        {AVATAR_CREATOR_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={category === c.id ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => handleCategoryChange(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className="settings-hint">
        Só a foto de "Frente" é obrigatória -- sem as outras, o jogo reaproveita a de frente virada nas outras
        direções (prévia rápida até você subir o resto). Arraste a foto em cima do boneco pra posicionar, e use o
        slider pra ajustar o tamanho -- cada direção guarda o próprio ajuste.
      </p>

      <form className="items-panel-form" onSubmit={handleAvatarCreatorSubmit}>
        {isAvatarPadrao ? (
          <>
            {/* "Avatar Padrão": sem nome/tom pra escolher (só 1 por
                sexo, ver DefaultReferenceRow acima) -- em vez disso,
                escolhe qual das 2 partes tá editando agora (cabeça ou
                traje/corpo limpo), cada uma com seu próprio conjunto de
                fotos por direção (ver padraoPart/files computado
                acima). */}
            <div className="gender-switch">
              <button
                type="button"
                className={padraoPart === "cabeca" ? "gender-btn selected" : "gender-btn"}
                onClick={() => setPadraoPart("cabeca")}
              >
                Cabeça {padraoHeadFiles.down ? "✓" : ""}
              </button>
              <button
                type="button"
                className={padraoPart === "traje" ? "gender-btn selected" : "gender-btn"}
                onClick={() => setPadraoPart("traje")}
              >
                Traje (corpo limpo) {padraoBodyFiles.down ? "✓" : ""}
              </button>
            </div>
            <p className="settings-hint">
              Sobe as duas partes (cabeça e traje/corpo limpo) e clica em Cadastrar UMA vez só no final -- as fotos
              ficam guardadas ao trocar de aba aqui em cima.
              {defaultReference[gender] ? " Já existe um Avatar Padrão " + gender + "; cadastrar de novo substitui." : ""}
            </p>
          </>
        ) : category === "avatar" ? (
          <div className="tone-select">
            {AVATAR_TONE_NAMES.map((tone) => (
              <button
                key={tone.label}
                type="button"
                className={label === tone.label ? "tone-chip selected" : "tone-chip"}
                onClick={() => {
                  setLabel(tone.label);
                  setHex(tone.hex);
                }}
              >
                <span className="tone-chip-swatch" style={{ background: tone.hex }} />
                {tone.label}
              </button>
            ))}
          </div>
        ) : (
          <input
            className="items-panel-input"
            type="text"
            placeholder="Nome do item"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}

        {category === "avatar" && (
          <label className="items-panel-upload-field">
            <span>Cor do botão (opcional)</span>
            <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} />
          </label>
        )}

        {usesBySkin && (
          <div className="items-panel-upload-field">
            <span>Aplica pra qual tom de pele</span>
            {genderSkins.length === 0 ? (
              <p className="settings-hint">
                Nenhum tom de pele "{gender}" cadastrado ainda -- cadastre um em "Avatar" primeiro.
              </p>
            ) : (
              <>
                <div className="tone-select">
                  {genderSkins.map((skin) => (
                    <button
                      key={skin.id}
                      type="button"
                      className={selectedSkinIds.includes(skin.id) ? "tone-chip selected" : "tone-chip"}
                      onClick={() =>
                        setSelectedSkinIds((prev) =>
                          prev.includes(skin.id) ? prev.filter((id) => id !== skin.id) : [...prev, skin.id]
                        )
                      }
                    >
                      <span className="tone-chip-swatch" style={{ background: skin.hex ?? "#8a7ca8" }} />
                      {skin.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() =>
                    setSelectedSkinIds(
                      selectedSkinIds.length === genderSkins.length ? [] : genderSkins.map((s) => s.id)
                    )
                  }
                >
                  {selectedSkinIds.length === genderSkins.length ? "Limpar seleção" : "Selecionar todos"}
                </button>
              </>
            )}
          </div>
        )}

        <div className="items-panel-uploads">
          {activeDirectionFields.map((field) => (
            <label key={field.key} className="items-panel-upload-field">
              <span>
                {field.label}
                {field.key === "down" ? " *" : ""}
              </span>
              <input
                ref={(el) => {
                  fileInputRefs.current[field.key] = el;
                }}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setFiles((prev) => ({ ...prev, [field.key]: file }));
                  if (file) setActiveDirection(field.key);
                }}
              />
            </label>
          ))}
        </div>

        {/* editor de posição/tamanho -- pedido do Douglas: "preciso
            posicionar e redimensionar" -- abas de direção (só as que a
            categoria usa, ver activeDirectionFields) trocam qual foto
            tá sendo ajustada; o boneco de referência muda de POSE
            junto (ver frameOffsetXPx/frameOffsetYPx acima). */}
        <div className="edit-section-tabs">
          {activeDirectionFields.map((field) => (
            <button
              key={field.key}
              type="button"
              className={activeDirection === field.key ? "edit-section-tab selected" : "edit-section-tab"}
              onClick={() => setActiveDirection(field.key)}
            >
              {field.label}
            </button>
          ))}
        </div>

        {referenceSkinIsFallback && (
          <p className="settings-hint">
            Ainda não tem nenhum tom de pele "{gender}" cadastrado -- o boneco abaixo é de OUTRO sexo, só pra não
            deixar o preview vazio (o corpo pode não bater exatamente). Cadastre um tom de pele "{gender}" em
            "Avatar" primeiro pra ter a referência certa.
          </p>
        )}

        {/* confirma QUAL tom o boneco abaixo representa -- pedido do
            Douglas: "a cabeça selecionada deveria aparecer no editor...
            travado nela". Só aparece quando dá pra escolher mais de 1
            tom (usesBySkin) -- se marcou vários, o boneco mostra o
            PRIMEIRO da lista (selectedSkinIds[0]), então avisa qual é,
            já que os outros tons marcados podem ter proporção um pouco
            diferente (cada um foi alinhado/subido separado). */}
        {usesBySkin && selectedReferenceSkin && (
          <p className="settings-hint">
            Boneco de referência abaixo: <strong>{selectedReferenceSkin.label}</strong>
            {selectedSkinIds.length > 1
              ? ` (o 1º dos ${selectedSkinIds.length} tons marcados -- os outros podem ter o corpo levemente diferente, cada um foi cadastrado à parte)`
              : ""}
            .
          </p>
        )}

        {/* Avatar Padrão do sexo entrando como referência (pedido do
            Douglas: "esse padrao voce coloca ele inteiro montado no
            editor quando eu for criar outros... uso ele exatamente de
            referencia sempre, pra tudo em avatares"). Só avisa sobre o
            CORPO aqui -- a cabeça já tem seu próprio aviso acima quando
            vem de um tom selecionado. */}
        {referenceBodyUrl && (
          <p className="settings-hint">
            Corpo/traje do boneco abaixo: <strong>Avatar Padrão {gender}</strong> (cadastrado em "Avatar Padrão").
          </p>
        )}

        <div className="item-size-card">
          <div className="item-stage" style={{ height: STAGE_HEIGHT }}>
            <div
              className="item-stage-avatar"
              style={{
                bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                width: FRAME_W,
                height: FRAME_H,
              }}
              title="Boneco de referência -- pose da direção escolhida acima"
            >
              <div
                className="item-stage-avatar-crop"
                style={{
                  transform: `translate(-${frameOffsetXPx}px, -${frameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                }}
              >
                {/* corpo/traje do Avatar Padrão primeiro (embaixo), depois
                    a cabeça -- mesma ordem de LAYER_DRAW_ORDER em
                    MainScene.ts ("traje" antes de "base"). Sem Avatar
                    Padrão cadastrado ainda pro sexo, só mostra a cabeça
                    crua de sempre (referenceHeadUrl cai pro referenceSkin). */}
                {referenceBodyUrl && (
                  <img className="item-stage-avatar-layer" src={referenceBodyUrl} alt="" />
                )}
                {referenceHeadUrl && (
                  <img className="item-stage-avatar-layer" src={referenceHeadUrl} alt="" />
                )}
              </div>
            </div>

            {/* tile de referência embaixo do boneco (pedido do Douglas:
                "o tile continua nao aparecendo" -- faltava aqui, só o
                editor de mobi tinha, ver item-stage-tile no form
                principal mais abaixo). Mesmo tamanho/âncora ali. */}
            <div
              className="item-stage-tile"
              style={{ bottom: STAGE_BASELINE_PAD, width: TILE_SIZE_PX, height: TILE_SIZE_PX }}
            />

            {activeArtUrl ? (
              <div
                className={hasOwnFile ? "avatar-art-drag-box" : "avatar-art-drag-box avatar-art-drag-box-ghost"}
                style={{
                  width: FRAME_W * PREVIEW_SCALE,
                  height: FRAME_H * PREVIEW_SCALE,
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  transform: `translate(calc(-50% + ${activePlacement.offsetX * PREVIEW_SCALE}px), ${activePlacement.offsetY * PREVIEW_SCALE}px) scale(${activePlacement.scale})`,
                }}
                onPointerDown={hasOwnFile ? handleArtPointerDown : undefined}
                title={hasOwnFile ? "Arraste pra posicionar" : "Foto de frente reaproveitada -- suba a foto própria pra ajustar"}
              >
                <img className="avatar-art-drag-img" src={activeArtUrl} alt="Preview" />
              </div>
            ) : (
              <p className="edit-hint item-size-empty">Escolha a foto de "{activeDirectionLabel}" pra ver o preview aqui.</p>
            )}
          </div>

          <div className="settings-slider-row">
            <span className="settings-slider-name">Tamanho ({activeDirectionLabel})</span>
            <input
              type="range"
              min={0.3}
              max={2.5}
              step={0.05}
              disabled={!hasOwnFile}
              value={activePlacement.scale}
              onChange={(e) =>
                setPlacements((prev) => ({
                  ...prev,
                  [activeDirection]: { ...(prev[activeDirection] ?? DEFAULT_PLACEMENT), scale: Number(e.target.value) },
                }))
              }
            />
            <span className="settings-slider-value">{Math.round(activePlacement.scale * 100)}%</span>
          </div>

          <div className="item-stage-offset-row">
            <span>
              posição ({activeDirectionLabel}) -- x: {activePlacement.offsetX}px · y: {activePlacement.offsetY}px
            </span>
            {hasOwnFile && (activePlacement.offsetX !== 0 || activePlacement.offsetY !== 0 || activePlacement.scale !== 1) && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => setPlacements((prev) => ({ ...prev, [activeDirection]: DEFAULT_PLACEMENT }))}
              >
                Resetar posição/tamanho
              </button>
            )}
          </div>
        </div>

        {error && <p className="items-panel-error">{error}</p>}

        <div className="items-panel-submit-row">
          <button type="submit" className="items-panel-submit" disabled={submitting}>
            {submitting ? "Enviando..." : "Cadastrar"}
          </button>
        </div>
      </form>

      <section className="items-panel-section">
        {category === "avatar" ? (
          <>
            <h3>Tons cadastrados ({skins?.length ?? 0})</h3>
            {!skins ? (
              <p className="items-panel-loading">Carregando...</p>
            ) : skins.length === 0 ? (
              <p className="items-panel-loading">Nenhum tom custom ainda.</p>
            ) : (
              <ul className="items-panel-list">
                {skins.map((skin) => (
                  <li key={skin.id} className="items-panel-row">
                    <span className="skin-swatch" style={{ background: skin.hex ?? "#8a7ca8" }} />
                    <span className="items-panel-name">
                      {skin.label} <span className="items-panel-category">({skin.gender})</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          (() => {
            const rows = (avatarItems ?? []).filter((it) => it.category === category);
            return (
              <>
                <h3>
                  {AVATAR_CREATOR_CATEGORIES.find((c) => c.id === category)?.label} cadastrados ({rows.length})
                </h3>
                {!avatarItems ? (
                  <p className="items-panel-loading">Carregando...</p>
                ) : rows.length === 0 ? (
                  <p className="items-panel-loading">
                    Nenhum ainda -- se a tabela não existir ainda, peça pro Douglas rodar
                    supabase/migrations/0006_avatar_items.sql.
                  </p>
                ) : (
                  <ul className="items-panel-list">
                    {rows.map((item) => (
                      <li key={item.id} className="items-panel-row">
                        <span className="items-panel-name">
                          {item.label} <span className="items-panel-category">({item.gender})</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()
        )}
      </section>
    </>
  );
}

export default function ItemEditor({
  accessToken,
  onClose,
  onItemsChanged,
}: {
  accessToken: string;
  onClose: () => void;
  onItemsChanged: () => void;
}) {
  // "Criar Mobi" (de sempre) / "Criar Avatar" (pedido do Douglas: "la
  // encima quero dois botoes criar mobi/criar avatar") -- dois modos
  // dentro do MESMO painel, não duas telas separadas. "Criar Avatar" usa
  // um componente à parte (AvatarCreatorPanel, ver acima) com seu próprio
  // formulário/estado, já que os campos são bem diferentes (sexo,
  // categoria, folha composta no navegador) do de móvel.
  const [mode, setMode] = useState<"mobi" | "avatar">("mobi");
  const [items, setItems] = useState<CustomItemRow[] | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<CategoryId>("poltrona");
  const [files, setFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});
  const iconInputRef = useRef<HTMLInputElement | null>(null);

  // "Editar" (pedido do Douglas: "quero editar os já cadastrados") --
  // null = formulário em modo "cadastrar item novo" (de sempre). Um id
  // aqui = editando ESSE item: o formulário é reusado (mesmos campos),
  // só troca o botão final e o destino do submit (PATCH em vez de
  // POST, ver handleSubmit). existingArt/existingIconUrl guardam as
  // URLs que JÁ estavam salvas -- mostradas como preview/miniatura
  // mesmo sem reenviar arquivo novo (só troca o que for re-upload).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingArt, setExistingArt] = useState<Partial<Record<DirectionKey, string>>>({});

  // tamanho de exibição ajustado à mão (ver DISPLAY_WIDTH_MIN/MAX/
  // PREVIEW_SCALE acima) -- começa no alvo padrão da categoria escolhida
  // e reseta pro alvo da categoria nova toda vez que ela muda (ver
  // handleCategoryChange), já que categorias diferentes têm escala bem
  // diferente (planta é bem menor que sofá) -- só quando NÃO tá editando
  // (editar um item existente não deve jogar fora o tamanho já ajustado
  // dele só por trocar a categoria).
  const [displayWidth, setDisplayWidth] = useState<number>(CUSTOM_ITEM_TARGET_WIDTH.poltrona);
  // posição do item DENTRO do tile (pedido do Douglas: "delimitar ali no
  // editor a posição do mobi no tile") -- ajustado arrastando o item em
  // cima do quadrado/boneco de referência no preview (ver
  // handleItemDragStart), 0/0 = padrão (âncora na borda de baixo do
  // tile, sem deslocamento). Mesmo campo persistido em offsetX/offsetY
  // de FurnitureModelDef (ver game/furniture.ts).
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  // override de offsetX/offsetY por direção (pedido do Douglas: "editar
  // todos os lados do mobi") -- left/right/up só, "down" usa offsetX/
  // offsetY acima direto (ver comentário em FurnitureModelDef.directionOffsets,
  // game/furniture.ts). Qual direção tá sendo ajustada agora no preview
  // -- ver activeMobiDirection/DIRECTION_FIELDS.
  const [directionOffsets, setDirectionOffsets] = useState<
    Partial<Record<Exclude<DirectionKey, "down">, { x: number; y: number }>>
  >({});
  const [activeMobiDirection, setActiveMobiDirection] = useState<DirectionKey>("down");

  // "Tem interação?" (pedido do Douglas: "se vai ter interação, e qual
  // interação -- por enquanto só temos sentar") -- desacopla "senta" da
  // CATEGORIA (antes só poltrona/sofá sentavam, sem escolha, ver
  // isSittableFurnitureType em game/furniture.ts). Começa pré-marcado
  // pelo palpite de categoria (poltrona/sofá = sentável), mas dá pra
  // mudar -- ver handleCategoryChange, que só reajusta esse palpite
  // quando NÃO tá editando (mesma regra do displayWidth acima).
  const [sittable, setSittable] = useState(() => DEFAULT_SITTABLE_BY_CATEGORY.poltrona);
  // ajuste PADRÃO (não por direção -- isso continua sendo o "Assento" do
  // editor de espaço) de onde o boneco senta -- só importa quando
  // sittable=true, ver seat-marker arrastável no preview.
  const [seatOffsetX, setSeatOffsetX] = useState(0);
  const [seatOffsetY, setSeatOffsetY] = useState(0);

  // URL (blob local, nunca sobe pra lugar nenhum) da imagem de FRENTE
  // escolhida, só pra mostrar no preview grande -- revogada
  // (URL.revokeObjectURL) toda vez que troca ou o componente desmonta,
  // pra não vazar memória.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = previewUrl;

  // ícone PRÓPRIO do catálogo (pedido do Douglas: "escolher o favicon
  // que aparece no catálogo") -- upload SEPARADO das 4 fotos de
  // direção, opcional: sem ele, o catálogo cai no fallback de sempre
  // (foto de frente, ver catalogEntryIconFile em GameRoom.tsx).
  // iconCleared = pediu pra tirar o ícone custom que já existia (ao
  // salvar, manda icon_url:null pro servidor) -- diferente de "não mexi
  // em nada" (nesse caso o PATCH nem manda o campo, mantém o que já tava
  // salvo).
  const [existingIconUrl, setExistingIconUrl] = useState<string | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconCleared, setIconCleared] = useState(false);
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null);
  const iconPreviewUrlRef = useRef<string | null>(null);
  iconPreviewUrlRef.current = iconPreviewUrl;

  function handleCategoryChange(next: CategoryId) {
    setCategory(next);
    if (!editingId) {
      setDisplayWidth(CUSTOM_ITEM_TARGET_WIDTH[next]);
      setSittable(DEFAULT_SITTABLE_BY_CATEGORY[next]);
    }
  }

  function handleDownFileChange(file: File | undefined) {
    setFiles((prev) => ({ ...prev, down: file }));
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function handleIconFileChange(file: File | undefined) {
    setIconFile(file ?? null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function removeIcon() {
    setIconFile(null);
    setIconCleared(true);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  // limpa as últimas URLs de preview ao desmontar (ex: fechou o editor)
  // -- sem isso o blob fica preso na memória do navegador até a aba
  // fechar.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (iconPreviewUrlRef.current) URL.revokeObjectURL(iconPreviewUrlRef.current);
    };
  }, []);

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function loadItems() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("room_items")
      .select(
        "id, label, category, art, icon_url, display_width, offset_x, offset_y, direction_offsets, sittable, seat_offset_x, seat_offset_y"
      );
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setItems((data ?? []) as CustomItemRow[]);
  }

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Limpa o formulário inteiro de volta pro modo "cadastrar item novo". */
  function resetForm() {
    setEditingId(null);
    setLabel("");
    setCategory("poltrona");
    setFiles({});
    setExistingArt({});
    setDisplayWidth(CUSTOM_ITEM_TARGET_WIDTH.poltrona);
    setOffsetX(0);
    setOffsetY(0);
    setDirectionOffsets({});
    setActiveMobiDirection("down");
    setSittable(DEFAULT_SITTABLE_BY_CATEGORY.poltrona);
    setSeatOffsetX(0);
    setSeatOffsetY(0);
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setExistingIconUrl(null);
    setIconFile(null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  /** Botão "Editar" na lista de cadastrados -- carrega o item inteiro de
   * volta no formulário (mesmo formulário do cadastro, ver comentário em
   * editingId acima), pronto pra ajustar e salvar. */
  function startEditItem(item: CustomItemRow) {
    setEditingId(item.id);
    setLabel(item.label);
    setCategory(item.category);
    setFiles({});
    setExistingArt(item.art ?? {});
    setDisplayWidth(item.display_width ?? CUSTOM_ITEM_TARGET_WIDTH[item.category]);
    setOffsetX(clamp(item.offset_x ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT));
    setOffsetY(clamp(item.offset_y ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT));
    setDirectionOffsets(item.direction_offsets ?? {});
    setActiveMobiDirection("down");
    setSittable(item.sittable ?? DEFAULT_SITTABLE_BY_CATEGORY[item.category]);
    setSeatOffsetX(clamp(item.seat_offset_x ?? 0, -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
    setSeatOffsetY(clamp(item.seat_offset_y ?? 0, -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setExistingIconUrl(item.icon_url ?? null);
    setIconFile(null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setError(null);
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  // imagem mostrada no preview grande -- pra "down" continua usando o
  // blob dedicado de sempre (previewUrl, ver handleDownFileChange);
  // pras outras 3 direções (pedido do Douglas: "editar todos os lados
  // do mobi"), um blob PRÓPRIO da direção ativa (ver activeMobiBlobUrl
  // logo abaixo, mesmo esquema que AvatarCreatorPanel já usa pra
  // isso). Sem arquivo novo escolhido, cai na URL já salva daquela
  // direção (existingArt).
  const activeMobiFile = activeMobiDirection === "down" ? undefined : files[activeMobiDirection];
  const [activeMobiBlobUrl, setActiveMobiBlobUrl] = useState<string | null>(null);
  const activeMobiBlobUrlRef = useRef<string | null>(null);
  activeMobiBlobUrlRef.current = activeMobiBlobUrl;

  useEffect(() => {
    setActiveMobiBlobUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return activeMobiFile ? URL.createObjectURL(activeMobiFile) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMobiFile]);

  useEffect(() => {
    return () => {
      if (activeMobiBlobUrlRef.current) URL.revokeObjectURL(activeMobiBlobUrlRef.current);
    };
  }, []);

  const stageArtSrc =
    activeMobiDirection === "down"
      ? previewUrl ?? existingArt.down ?? null
      : activeMobiBlobUrl ?? existingArt[activeMobiDirection] ?? null;
  const stageIconSrc = iconPreviewUrl ?? (!iconCleared ? existingIconUrl : null);

  // offset em uso pela direção ATIVA -- "down" lê offsetX/offsetY
  // direto, as outras 3 caem no PRÓPRIO override (directionOffsets) ou,
  // sem um ainda, no mesmo valor de "down" (mesma prévia do que vai
  // acontecer no jogo, ver addFurnitureSprite em MainScene.ts).
  const activeMobiOffset =
    activeMobiDirection === "down" ? { x: offsetX, y: offsetY } : directionOffsets[activeMobiDirection] ?? { x: offsetX, y: offsetY };

  // boneco de referência NA POSE da direção ativa (mesmo esquema do
  // "Criar Avatar", ver DIRECTION_FIRST_FRAME_INDEX/frameOffsetXPx em
  // AvatarCreatorPanel acima).
  const activeMobiFrameIndex = DIRECTION_FIRST_FRAME_INDEX[activeMobiDirection];
  const mobiFrameCol = activeMobiFrameIndex % SKIN_SHEET_COLS;
  const mobiFrameRow = Math.floor(activeMobiFrameIndex / SKIN_SHEET_COLS);
  const mobiFrameOffsetXPx = mobiFrameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const mobiFrameOffsetYPx = mobiFrameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  // mesma ideia, mas pra pose SENTADO da direção ativa (usado no boneco
  // arrastável do marcador de assento logo abaixo, no lugar da bolinha
  // antiga -- pedido do Douglas).
  const activeSeatFrameIndex = SEAT_FRAME_INDEX[activeMobiDirection];
  const seatFrameCol = activeSeatFrameIndex % SKIN_SHEET_COLS;
  const seatFrameRow = Math.floor(activeSeatFrameIndex / SKIN_SHEET_COLS);
  const seatFrameOffsetXPx = seatFrameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const seatFrameOffsetYPx = seatFrameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  // --- arrastar o item em cima do quadrado/boneco de referência
  // (pedido do Douglas: "delimitar ali no editor a posição do mobi no
  // tile", depois "editar todos os lados do mobi") -- pointer capture
  // no próprio elemento arrastado, assim o arraste continua
  // funcionando mesmo se o cursor sair da área do preview no meio do
  // gesto. Converte pixel de TELA (delta do mouse) pra pixel de JOGO
  // dividindo por PREVIEW_SCALE -- offsetX/offsetY são sempre em px de
  // jogo (mesma unidade salva no banco/usada em MainScene.ts), não em
  // px de tela. Escreve em offsetX/offsetY quando a direção ativa é
  // "down", senão no override daquela direção (directionOffsets).
  function handleItemPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    e.preventDefault();
    const dir = activeMobiDirection;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startOffsetX = activeMobiOffset.x;
    const startOffsetY = activeMobiOffset.y;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      const nextX = clamp(Math.round(startOffsetX + dx), -OFFSET_LIMIT, OFFSET_LIMIT);
      const nextY = clamp(Math.round(startOffsetY + dy), -OFFSET_LIMIT, OFFSET_LIMIT);
      if (dir === "down") {
        setOffsetX(nextX);
        setOffsetY(nextY);
      } else {
        setDirectionOffsets((prev) => ({ ...prev, [dir]: { x: nextX, y: nextY } }));
      }
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  // --- arrastar o MARCADOR de onde o boneco senta (pedido do Douglas:
  // "editar também a posição sentado lá dentro") -- só aparece quando
  // sittable=true (ver seletor "Tem interação?"). Um ajuste só, vale
  // nas 4 direções (o fino por direção continua sendo o "Assento" do
  // editor de espaço, ver resolveSeatOffset em game/furniture.ts).
  function handleSeatMarkerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = seatOffsetX;
    const startY = seatOffsetY;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      setSeatOffsetX(clamp(Math.round(startX + dx), -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
      setSeatOffsetY(clamp(Math.round(startY + dy), -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError("Dá um nome pro item.");
      return;
    }
    if (!editingId && !files.down) {
      setError("A imagem de frente é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    try {
      const slug = slugify(label);
      // teto de resolução com folga (ver UPLOAD_SUPERSAMPLE acima) -- a
      // partir do tamanho de exibição ESCOLHIDO no preview
      // (displayWidth), não do alvo genérico da categoria: as direções
      // usam o mesmo teto (a peça tem proporções parecidas de qualquer
      // ângulo).
      const maxUploadWidth = displayWidth * UPLOAD_SUPERSAMPLE;
      const art: Record<string, string> = {};
      for (const field of DIRECTION_FIELDS) {
        const rawFile = files[field.key];
        if (!rawFile) continue; // editando: direção não reenviada mantém a URL antiga (merge no servidor)
        const file = await resizeImageForUpload(rawFile, maxUploadWidth);
        const ext = file.name.split(".").pop() || "png";
        const path = `${category}/${slug}-${Date.now()}-${field.key}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, file, {
          upsert: false,
          contentType: file.type || "image/png",
        });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        art[field.key] = publicUrlData.publicUrl;
      }

      // ícone próprio (opcional) -- mesmo esquema de upload das
      // direções, teto bem menor (ver ICON_BUTTON_SIZE acima, o botão do
      // catálogo é pequeno).
      let iconUrl: string | null | undefined;
      if (iconFile) {
        const resized = await resizeImageForUpload(iconFile, ICON_BUTTON_SIZE * UPLOAD_SUPERSAMPLE);
        const ext = resized.name.split(".").pop() || "png";
        const path = `${category}/${slug}-${Date.now()}-icon.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, resized, {
          upsert: false,
          contentType: resized.type || "image/png",
        });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        iconUrl = publicUrlData.publicUrl;
      } else if (iconCleared) {
        iconUrl = null;
      }
      // undefined = não mexeu no ícone -- só entra no corpo da
      // requisição quando tem valor de verdade (novo upload) ou null
      // explícito (removeu), pra não pisar num ícone que já existia sem
      // querer num PATCH que nem tocou nesse campo.

      const payload: Record<string, unknown> = {
        label: label.trim(),
        category,
        art,
        display_width: displayWidth,
        offset_x: offsetX,
        offset_y: offsetY,
        // ajuste por direção + interação/assento (pedido do Douglas:
        // "editar todos os lados do mobi" e "editar também a posição
        // sentado lá dentro, com uma seleção, se vai ter interação") --
        // ver cleanDirectionOffsets/clampSeatOffset em
        // lib/supabase/itemFields.ts. directionOffsets vazio (sem
        // nenhuma direção ajustada) manda null de propósito, limpando
        // qualquer override antigo ao invés de deixar lixo pra trás.
        direction_offsets: Object.keys(directionOffsets).length > 0 ? directionOffsets : null,
        sittable,
        seat_offset_x: sittable ? seatOffsetX : null,
        seat_offset_y: sittable ? seatOffsetY : null,
      };
      if (iconUrl !== undefined) payload.icon_url = iconUrl;

      const res = await fetch(editingId ? `/api/items/${editingId}` : "/api/items", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar item");

      resetForm();
      await loadItems();
      onItemsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao salvar item");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar item");
      if (editingId === id) resetForm();
      await loadItems();
      onItemsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao apagar item");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="items-panel-backdrop" onClick={onClose}>
      <div className="items-panel items-panel-editor" onClick={(e) => e.stopPropagation()}>
        <div className="items-panel-header">
          <h2>{mode === "avatar" ? "Editor de itens" : editingId ? "Editar item" : "Editor de itens"}</h2>
          <button type="button" className="items-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="edit-section-tabs">
          <button
            type="button"
            className={mode === "mobi" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("mobi")}
          >
            Criar Mobi
          </button>
          <button
            type="button"
            className={mode === "avatar" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("avatar")}
          >
            Criar Avatar
          </button>
        </div>

        {mode === "avatar" && <AvatarCreatorPanel accessToken={accessToken} onChanged={onItemsChanged} />}

        {mode === "mobi" && (
        <>
        <form className="items-panel-form" onSubmit={handleSubmit}>
          <input
            className="items-panel-input"
            type="text"
            placeholder="Nome do item"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select className="items-panel-input" value={category} onChange={(e) => handleCategoryChange(e.target.value as CategoryId)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <p className="settings-hint">
            Pode subir a imagem na qualidade original (do ChatGPT/Canva, sem redimensionar à mão) -- ajuste o tamanho de exibição no preview abaixo, o jogo encolhe sozinho pro tamanho certo.
            {editingId ? " Só reenvie a foto da direção que quiser TROCAR -- as outras continuam com a arte já salva." : ""}
          </p>

          <div className="items-panel-uploads">
            {DIRECTION_FIELDS.map((field) => {
              const existingSrc = existingArt[field.key];
              return (
                <label key={field.key} className="items-panel-upload-field">
                  <span>
                    {field.label}
                    {field.required && !editingId ? " *" : ""}
                  </span>
                  {existingSrc && (
                    <img className="items-panel-upload-existing" src={existingSrc} alt={`${field.label} atual`} />
                  )}
                  <input
                    ref={(el) => {
                      fileInputRefs.current[field.key] = el;
                    }}
                    type="file"
                    accept="image/png,image/webp,image/jpeg"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? undefined;
                      if (field.key === "down") handleDownFileChange(file);
                      else setFiles((prev) => ({ ...prev, [field.key]: file }));
                      // pula o preview pra direção que acabou de
                      // receber arquivo -- assim dá pra ajustar a
                      // posição dela na hora, sem precisar clicar na
                      // aba manualmente.
                      if (file) setActiveMobiDirection(field.key);
                    }}
                  />
                </label>
              );
            })}
          </div>

          {/* Ícone próprio do catálogo (pedido do Douglas: "escolher o
              favicon que aparece no catálogo") -- opcional, separado das
              4 fotos de direção acima. Sem ele, o botão da grade do
              catálogo usa a foto de frente (ver catalogEntryIconFile em
              GameRoom.tsx). */}
          <label className="items-panel-upload-field">
            <span>Ícone do catálogo (opcional)</span>
            {stageIconSrc && <img className="items-panel-upload-existing" src={stageIconSrc} alt="Ícone atual" />}
            <input
              ref={iconInputRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              onChange={(e) => handleIconFileChange(e.target.files?.[0] ?? undefined)}
            />
          </label>
          {stageIconSrc && (
            <button type="button" className="clear-btn" onClick={removeIcon}>
              Remover ícone (usar a foto de frente)
            </button>
          )}

          {/* "Tem interação?" (pedido do Douglas: "editar também a
              posição sentado lá dentro, com uma seleção, se vai ter
              interação, e qual interação 'por enquanto só temos
              sentar'") -- decidido AQUI, não mais preso à categoria
              (poltrona/sofá): DEFAULT_SITTABLE_BY_CATEGORY só decide o
              valor inicial ao trocar de categoria/criar um item novo,
              o dono pode sempre ligar/desligar (ver
              isFurnitureSittable em game/furniture.ts). */}
          <p className="settings-hint">Tem interação? (o que acontece quando alguém clica no item na sala)</p>
          <div className="gender-switch">
            <button
              type="button"
              className={!sittable ? "gender-btn selected" : "gender-btn"}
              onClick={() => setSittable(false)}
            >
              Nenhuma
            </button>
            <button
              type="button"
              className={sittable ? "gender-btn selected" : "gender-btn"}
              onClick={() => setSittable(true)}
            >
              Sentar
            </button>
          </div>

          {/* Preview grande (pedido do Douglas: "preciso disso num card
              maior, com a imagem maior", "quero boneco real ali dentro
              em perspectiva certa, e o quadrado também", "delimitar ali
              no editor a posição do mobi no tile", depois "editar todos
              os lados do mobi") -- mostra o item de verdade em cima de
              um QUADRADO do tamanho real do tile e um BONECO de
              referência (arte de verdade do jogo, não mais uma
              silhueta em CSS), na MESMA proporção/âncora do jogo (ver
              AVATAR_FOOT_FROM_TILE_BOTTOM acima -- boneco ancora no
              CENTRO do tile, móvel ancora na BORDA DE BAIXO, por isso
              não ficam na mesma "linha"). As abas de direção abaixo
              trocam qual foto tá sendo ajustada (o boneco muda de
              POSE junto) -- arrasta o item (clicar e arrastar em cima
              dele) pra ajustar a posição DAQUELA direção; "baixo" usa
              offsetX/offsetY direto, as outras 3 caem num override
              próprio (directionOffsets) só quando ajustadas -- sem
              ajuste, reaproveitam a mesma posição de "baixo" (mesmo
              fallback que addFurnitureSprite usa no jogo). */}
          <div className="edit-section-tabs">
            {DIRECTION_FIELDS.map((field) => (
              <button
                key={field.key}
                type="button"
                className={activeMobiDirection === field.key ? "edit-section-tab selected" : "edit-section-tab"}
                onClick={() => setActiveMobiDirection(field.key)}
              >
                {field.label}
              </button>
            ))}
          </div>

          <div className="item-size-card">
            <div className="item-stage" style={{ height: STAGE_HEIGHT }}>
              <div
                className="item-stage-avatar"
                style={{
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  width: FRAME_W,
                  height: FRAME_H,
                }}
                title="Boneco de referência (penteado/traje padrão) -- o TAMANHO/ÂNCORA é que batem com o jogo de verdade"
              >
                <div
                  className="item-stage-avatar-crop"
                  style={{
                    transform: `translate(-${mobiFrameOffsetXPx}px, -${mobiFrameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                  }}
                >
                  {REFERENCE_OUTFIT_FILE && (
                    <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_OUTFIT_FILE}`} alt="" />
                  )}
                  {REFERENCE_SKIN && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_SKIN.file}`} alt="" />}
                  {REFERENCE_HAIR && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_HAIR.file}`} alt="" />}
                </div>
              </div>

              {/* boneco SENTADO arrastável (só quando "Sentar" tá
                  ligado acima) -- arrasta o próprio boneco (já na pose
                  sentado da direção ativa) pra ajustar o ponto padrão;
                  o fino por direção continua no "Assento" do editor de
                  espaço (resolveSeatOffset em game/furniture.ts), esse
                  aqui só define o PADRÃO usado antes de qualquer ajuste
                  ao vivo. Mesmo referencial de item-stage-item-img
                  logo abaixo -- ancorado no mesmo "bottom" que os pés
                  do boneco em pé (STAGE_BASELINE_PAD +
                  AVATAR_FOOT_FROM_TILE_BOTTOM), só deslocado pelo
                  seatOffsetX/Y atual (mesma conta que a bolinha antiga
                  fazia). Pedido do Douglas: trocar a bolinha abstrata
                  por um boneco de verdade, bem mais intuitivo de
                  posicionar. */}
              {sittable && (
                <div
                  className="item-stage-seat-avatar"
                  style={{
                    bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM - seatOffsetY * PREVIEW_SCALE,
                    width: FRAME_W,
                    height: FRAME_H,
                    transform: `translate(calc(-50% + ${seatOffsetX * PREVIEW_SCALE}px), 0)`,
                  }}
                  onPointerDown={handleSeatMarkerPointerDown}
                  title="Arraste o boneco sentado pra ajustar onde ele senta"
                >
                  <div
                    className="item-stage-avatar-crop"
                    style={{
                      transform: `translate(-${seatFrameOffsetXPx}px, -${seatFrameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                    }}
                  >
                    {REFERENCE_OUTFIT_FILE && (
                      <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_OUTFIT_FILE}`} alt="" />
                    )}
                    {REFERENCE_SKIN && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_SKIN.file}`} alt="" />}
                    {REFERENCE_HAIR && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_HAIR.file}`} alt="" />}
                  </div>
                </div>
              )}

              <div
                className="item-stage-tile"
                style={{ bottom: STAGE_BASELINE_PAD, width: TILE_SIZE_PX, height: TILE_SIZE_PX }}
              />

              {stageArtSrc ? (
                <img
                  className="item-stage-item-img"
                  src={stageArtSrc}
                  alt="Preview do item"
                  onPointerDown={handleItemPointerDown}
                  style={{
                    width: displayWidth * PREVIEW_SCALE,
                    bottom: STAGE_BASELINE_PAD - activeMobiOffset.y * PREVIEW_SCALE,
                    transform: `translate(calc(-50% + ${activeMobiOffset.x * PREVIEW_SCALE}px), 0)`,
                  }}
                  title="Arraste pra ajustar a posição no tile"
                />
              ) : (
                <p className="edit-hint item-size-empty">
                  Escolha a imagem de "{DIRECTION_FIELDS.find((f) => f.key === activeMobiDirection)?.label}" pra ver o preview aqui.
                </p>
              )}
            </div>

            <div className="settings-slider-row">
              <span className="settings-slider-name">Tamanho no jogo</span>
              <input
                type="range"
                min={DISPLAY_WIDTH_MIN}
                max={DISPLAY_WIDTH_MAX}
                step={DISPLAY_WIDTH_STEP}
                value={displayWidth}
                onChange={(e) => setDisplayWidth(Number(e.target.value))}
              />
              <span className="settings-slider-value">{displayWidth}px</span>
            </div>

            <div className="item-stage-offset-row">
              <span>
                posição no tile ({DIRECTION_FIELDS.find((f) => f.key === activeMobiDirection)?.label}) -- x: {activeMobiOffset.x}px · y: {activeMobiOffset.y}px
              </span>
              {(activeMobiOffset.x !== 0 || activeMobiOffset.y !== 0) && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => {
                    if (activeMobiDirection === "down") {
                      setOffsetX(0);
                      setOffsetY(0);
                    } else {
                      setDirectionOffsets((prev) => {
                        const next = { ...prev };
                        delete next[activeMobiDirection as Exclude<DirectionKey, "down">];
                        return next;
                      });
                    }
                  }}
                >
                  Redefinir posição
                </button>
              )}
            </div>

            {sittable && (
              <div className="item-stage-offset-row">
                <span>
                  posição sentado -- x: {seatOffsetX}px · y: {seatOffsetY}px
                </span>
                {(seatOffsetX !== 0 || seatOffsetY !== 0) && (
                  <button
                    type="button"
                    className="clear-btn"
                    onClick={() => {
                      setSeatOffsetX(0);
                      setSeatOffsetY(0);
                    }}
                  >
                    Redefinir assento
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <p className="items-panel-error">{error}</p>}

          <div className="items-panel-submit-row">
            <button type="submit" className="items-panel-submit" disabled={submitting}>
              {submitting ? "Enviando..." : editingId ? "Salvar alterações" : "Cadastrar item"}
            </button>
            {editingId && (
              <button type="button" className="clear-btn" onClick={resetForm} disabled={submitting}>
                Cancelar edição
              </button>
            )}
          </div>
        </form>

        <section className="items-panel-section">
          <h3>Itens cadastrados ({items?.length ?? 0})</h3>
          {!items ? (
            <p className="items-panel-loading">Carregando...</p>
          ) : items.length === 0 ? (
            <p className="items-panel-loading">Nenhum item custom ainda.</p>
          ) : (
            <ul className="items-panel-list">
              {items.map((item) => (
                <li key={item.id} className="items-panel-row">
                  {(item.icon_url ?? item.art.down) && (
                    <img className="items-panel-thumb" src={item.icon_url ?? item.art.down} alt={item.label} />
                  )}
                  <span className="items-panel-name">
                    {item.label} <span className="items-panel-category">({CATEGORIES.find((c) => c.id === item.category)?.label ?? item.category})</span>
                  </span>
                  <button type="button" disabled={busyId === item.id} onClick={() => startEditItem(item)}>
                    Editar
                  </button>
                  <button type="button" disabled={busyId === item.id} onClick={() => handleDelete(item.id)}>
                    Excluir
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        </>
        )}
      </div>
    </div>
  );
}
