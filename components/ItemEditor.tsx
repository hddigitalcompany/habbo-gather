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
import { HAIR_CATALOG, DEFAULT_HAIR_ID, SKIN_CATALOG, DEFAULT_SKIN_ID, OUTFIT_CATALOG, DEFAULT_OUTFIT_ID, outfitFileForSkin } from "@/game/customization";

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
};

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

export default function ItemEditor({
  accessToken,
  onClose,
  onItemsChanged,
}: {
  accessToken: string;
  onClose: () => void;
  onItemsChanged: () => void;
}) {
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
    if (!editingId) setDisplayWidth(CUSTOM_ITEM_TARGET_WIDTH[next]);
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
      .select("id, label, category, art, icon_url, display_width, offset_x, offset_y");
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

  // imagem de FRENTE mostrada no preview grande: arquivo novo escolhido
  // (previewUrl, blob) tem prioridade -- senão, editando um item que já
  // tem imagem, cai na URL já salva.
  const stageArtSrc = previewUrl ?? existingArt.down ?? null;
  const stageIconSrc = iconPreviewUrl ?? (!iconCleared ? existingIconUrl : null);

  // --- arrastar o item em cima do quadrado/boneco de referência
  // (pedido do Douglas: "delimitar ali no editor a posição do mobi no
  // tile") -- pointer capture no próprio elemento arrastado, assim o
  // arraste continua funcionando mesmo se o cursor sair da área do
  // preview no meio do gesto. Converte pixel de TELA (delta do mouse)
  // pra pixel de JOGO dividindo por PREVIEW_SCALE -- offsetX/offsetY são
  // sempre em px de jogo (mesma unidade salva no banco/usada em
  // MainScene.ts), não em px de tela.
  function handleItemPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startOffsetX = offsetX;
    const startOffsetY = offsetY;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      setOffsetX(clamp(Math.round(startOffsetX + dx), -OFFSET_LIMIT, OFFSET_LIMIT));
      setOffsetY(clamp(Math.round(startOffsetY + dy), -OFFSET_LIMIT, OFFSET_LIMIT));
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
          <h2>{editingId ? "Editar item" : "Editor de itens"}</h2>
          <button type="button" className="items-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

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

          {/* Preview grande (pedido do Douglas: "preciso disso num card
              maior, com a imagem maior", "quero boneco real ali dentro
              em perspectiva certa, e o quadrado também", "delimitar ali
              no editor a posição do mobi no tile") -- mostra o item de
              verdade em cima de um QUADRADO do tamanho real do tile e um
              BONECO de referência (arte de verdade do jogo, não mais uma
              silhueta em CSS), na MESMA proporção/âncora do jogo (ver
              AVATAR_FOOT_FROM_TILE_BOTTOM acima -- boneco ancora no
              CENTRO do tile, móvel ancora na BORDA DE BAIXO, por isso
              não ficam na mesma "linha"). Arrasta o item (clicar e
              arrastar em cima dele) pra ajustar offsetX/offsetY -- o
              slider de tamanho continua do lado. */}
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
                  style={{ transform: `scale(${AVATAR_SCALE * PREVIEW_SCALE})` }}
                >
                  {REFERENCE_OUTFIT_FILE && (
                    <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_OUTFIT_FILE}`} alt="" />
                  )}
                  {REFERENCE_SKIN && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_SKIN.file}`} alt="" />}
                  {REFERENCE_HAIR && <img className="item-stage-avatar-layer" src={`/assets/${REFERENCE_HAIR.file}`} alt="" />}
                </div>
              </div>

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
                    bottom: STAGE_BASELINE_PAD - offsetY * PREVIEW_SCALE,
                    transform: `translate(calc(-50% + ${offsetX * PREVIEW_SCALE}px), 0)`,
                  }}
                  title="Arraste pra ajustar a posição no tile"
                />
              ) : (
                <p className="edit-hint item-size-empty">Escolha a imagem de frente pra ver o preview aqui.</p>
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
                posição no tile -- x: {offsetX}px · y: {offsetY}px
              </span>
              {(offsetX !== 0 || offsetY !== 0) && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => {
                    setOffsetX(0);
                    setOffsetY(0);
                  }}
                >
                  Redefinir posição
                </button>
              )}
            </div>
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
      </div>
    </div>
  );
}
