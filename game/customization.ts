/**
 * Catálogo de opções de customização do personagem -- por enquanto só
 * cabelo (ver MainScene.ts, que carrega cada arquivo como um spritesheet
 * PRÓPRIO -- mesmo layout de frames do "base", ver FRAME_W/FRAME_H/spacing
 * -- e troca de textura ao vivo conforme a escolha, ver setLocalHairId).
 *
 * Cada opção é um PNG em public/assets/ já alinhado à cabeça do avatar
 * base (avatar_visual1.png) nas 15 poses usadas (down/left/right/up x
 * parado+passoA+passoB, + sentado down/left/right -- "up" sentado reusa
 * o frame 9, igual ao resto do sistema de camadas).
 */
/**
 * Variação de COR de um item (ex: "Cabelinho pra trás" em Castanho/
 * Loiro/Preto) -- cada cor é um spritesheet PRÓPRIO (mesmo layout de
 * frames do penteado "base"), gerado automaticamente a partir da pasta
 * de origem (ver scripts/syncAvatarAssets.mjs). Selecionar uma cor troca
 * a textura pro arquivo dela (ver setLocalHairId em MainScene.ts, chamado
 * com o id da COR em vez do id do penteado) -- não é um tint/hex aplicado
 * em cima da mesma arte, é uma arte diferente por cor.
 */
export interface ColorOption {
  id: string;
  label: string;
  file: string;
}

export interface HairOption {
  id: string;
  label: string;
  file: string;
  colors?: ColorOption[];
}

// pedido do Douglas: "rapa tudo que tem de item, vou subir tudo pela
// plataforma" -- tirou os penteados "de fábrica" (pasta local, ver
// scripts/syncAvatarAssets.mjs) do catálogo: só sobra "Nenhum" até ele
// recadastrar tudo pelo Editor de Itens (botão "Criar Avatar" > Cabelo,
// vai pra tabela avatar_items em vez da pasta local, ver
// registerCustomHair mais abaixo). Os arquivos/scripts da pasta local
// CONTINUAM existindo (só pararam de entrar aqui) -- é só reimportar
// GENERATED_HAIR_CATALOG/GENERATED_HAIR_COLORS_BY_STYLE de
// ./customizationCatalog.generated (mesmo esquema de antes) se um dia
// quiser voltar a usá-los.
export const HAIR_CATALOG: HairOption[] = [
  { id: "nenhum", label: "Nenhum", file: "cabelo_nenhum.png" },
];

// "Nenhum" agora é o único item -- fixo nele (era "ondulado", que saiu
// do catálogo junto com o resto "de fábrica" acima). Mesmo padrão que
// BEARD/ACCESSORY/OUTFIT já usavam (DEFAULT_X_ID = CATALOG[0].id).
export const DEFAULT_HAIR_ID = HAIR_CATALOG[0].id;

/**
 * Tom de pele/corpo base (camada "base" do avatar, ver LAYER_TEXTURE_FILE
 * em MainScene.ts) -- igual ao cabelo, cada tom é um spritesheet PRÓPRIO
 * (mesmas 15 poses, mas aqui TODAS diferentes de verdade -- sem repetir
 * passo/direção como o cabelo faz) gerado automaticamente a partir da
 * pasta de origem (ver scripts/syncSkinAssets.mjs). `hex` é só pra
 * desenhar o botão seletor (ver ProfileCard em GameRoom.tsx) -- o
 * Douglas mandou os tons certos pelo chat, não é uma cor tirada da
 * imagem.
 *
 * Não existe mais um tom "Padrão" manual (era o amarelado do avatar
 * base antigo, avatar_visual1.png -- esse arquivo continua existindo só
 * como TEMPLATE de alinhamento pros scripts de sync, ver
 * ensureReferenceTemplates em cada um deles, mas não aparece mais como
 * opção pro jogador). "Branco" é sempre o primeiro/padrão (ver sort
 * abaixo) -- não depende da ordem em que a pasta de origem foi lida.
 */
/** "Sexo" do avatar (pedido do Douglas: botão Masculino/Feminino acima
 * do seletor de tom de pele, ver ProfileCard em GameRoom.tsx) -- hoje só
 * separa qual PASTA de origem cada tom de pele veio (ver
 * AVATAR_SKIN_SRC_ROOT/AVATAR_SKIN_SRC_ROOT_FEMININO em
 * scripts/avatarAssetsConfig.mjs), não afeta cabelo/barba/acessório/
 * traje -- esses continuam com o catálogo único de sempre. */
export type AvatarGender = "masculino" | "feminino";

export interface SkinOption {
  id: string;
  label: string;
  /** Nome de arquivo em public/assets/ (tom "de fábrica", gerado da
   * pasta local) OU URL pública completa do Supabase Storage (tom
   * CUSTOM, ver `custom` abaixo) -- quem desenha precisa diferenciar os
   * dois (ver assetUrl em GameRoom.tsx, mesmo helper que já existia pra
   * arte de móvel custom). */
  file: string;
  hex?: string;
  /** Ver AvatarGender acima -- gerado automaticamente (ver
   * scripts/syncSkinAssets.mjs), sempre presente num catálogo recém-
   * sincronizado; opcional aqui só pra não quebrar um catálogo gerado
   * antes dessa mudança (ausente = trata como "masculino", ver
   * SKIN_CATALOG mais abaixo). */
  gender?: AvatarGender;
  /** true só pros tons CUSTOM cadastrados pelo Editor de Itens (botão
   * "Criar Avatar", ver registerCustomSkins logo abaixo) -- ausente/false
   * pro catálogo "de fábrica" (GENERATED_SKIN_CATALOG). */
  custom?: boolean;
}

// gerado automaticamente -- ver scripts/syncSkinAssets.mjs, NÃO editar
// esse import nem o arquivo dele à mão.
import { GENERATED_SKIN_CATALOG } from "./skinCatalog.generated";

export const SKIN_CATALOG: SkinOption[] = [...GENERATED_SKIN_CATALOG].sort((a, b) =>
  a.id === "branco" ? -1 : b.id === "branco" ? 1 : 0
);

export const DEFAULT_SKIN_ID = SKIN_CATALOG[0]?.id ?? "branco";

/** Sexo de um tom de pele pelo id (ver AvatarGender/SKIN_CATALOG acima)
 * -- "masculino" se não achar (tom desconhecido ou gerado antes do
 * campo `gender` existir). Usado por resolveBeardSkinId/
 * resolveOutfitSkinId logo abaixo pra nunca cair pro tom de OUTRO sexo
 * (ver comentário nos dois -- bug relatado pelo Douglas: "tá bugado com
 * o masculino atrás", a arte de traje/barba de um tom masculino
 * aparecendo atrás de um tom de pele feminino). */
function skinGenderOf(skinId: string): AvatarGender {
  return SKIN_CATALOG.find((s) => s.id === skinId)?.gender ?? "masculino";
}

/**
 * Registra tom(ns) de pele CUSTOM(izado(s)), cadastrado(s) pelo dono da
 * sala no Editor de Itens (botão "Criar Avatar", upload direto -- ver
 * components/ItemEditor.tsx, app/api/avatar-skins e a tabela
 * avatar_skins/Storage do Supabase) -- diferente de GENERATED_SKIN_CATALOG
 * (gerado em BUILD-TIME pela pasta local, ver scripts/syncSkinAssets.mjs),
 * esses chegam em TEMPO DE EXECUÇÃO, buscados assim que a sala carrega
 * (ver fetchCustomAvatarSkins em GameRoom.tsx). RODA JUNTO com a pasta
 * local -- pedido do Douglas ("duplicar sem perder o outro"), não troca
 * nem remove nada que já existia.
 *
 * Empurra direto pra dentro de SKIN_CATALOG (mesmo truque de
 * registerCustomFurnitureModels em game/furniture.ts -- array é tipo
 * referência, então todo lugar que já importa SKIN_CATALOG direto
 * enxerga os tons novos sozinho, só precisa forçar uma re-renderização
 * depois de chamar isso). UPSERT por id -- chamar de novo com o mesmo id
 * substitui em vez de duplicar (mesmo comportamento do móvel, pensando
 * já num "editar tom" futuro, ainda sem UI pra isso).
 */
export function registerCustomSkins(skins: SkinOption[]): string[] {
  const updatedIds: string[] = [];
  for (const skin of skins) {
    const existingIndex = SKIN_CATALOG.findIndex((s) => s.id === skin.id);
    if (existingIndex !== -1) {
      updatedIds.push(skin.id);
      SKIN_CATALOG[existingIndex] = { ...skin, custom: true };
    } else {
      SKIN_CATALOG.push({ ...skin, custom: true });
    }
  }
  return updatedIds;
}

/**
 * Barba (camada "barba") -- só 3 poses de verdade (sem "costas" -- não
 * dá pra ver a barba de trás da cabeça, o frame de "up" fica
 * transparente). Igual ao traje (ver OutfitOption mais abaixo), cada
 * estilo de barba tem uma variação de arte POR TOM DE PELE (`bySkin`,
 * mesma convenção de pasta: subpasta com o MESMO NOME do tom de pele --
 * "Branco"/"Pardo"/"Negro" -- ver scripts/syncBeardAssets.mjs), casada
 * automaticamente com o tom escolhido no avatar (não é mais uma cor
 * manual escolhida à parte). "Nenhuma" é a opção padrão/manual (arquivo
 * transparente, ver public/assets/barba_nenhuma.png, mesmo arquivo pra
 * qualquer tom) -- diferente do cabelo, nem todo mundo tem barba.
 */
export interface BeardOption {
  id: string;
  label: string;
  bySkin: Partial<Record<string, string>>;
}

// pedido do Douglas: "rapa tudo que tem de item, vou subir tudo pela
// plataforma" -- mesma ideia de HAIR_CATALOG acima, tirou as barbas "de
// fábrica" (pasta local, ver scripts/syncBeardAssets.mjs) daqui, só
// sobra "Nenhuma" até ele recadastrar pelo Editor de Itens > Barba
// (tabela avatar_items). Arquivos/script continuam existindo -- é só
// reimportar GENERATED_BEARD_CATALOG de ./beardCatalog.generated (mesmo
// esquema de antes) se quiser voltar a usá-los.
export const BEARD_CATALOG: BeardOption[] = [
  { id: "nenhuma", label: "Nenhuma", bySkin: { [DEFAULT_SKIN_ID]: "barba_nenhuma.png" } },
];

export const DEFAULT_BEARD_ID = BEARD_CATALOG[0].id;

/** Devolve o ID de tom de pele cujo arquivo deve ser usado pra barba: o
 * exato se existir, senão o primeiro disponível no `bySkin` DO MESMO
 * SEXO (ver skinGenderOf acima) -- nunca cai pro tom de OUTRO sexo, já
 * que a barba/traje daquele tom foi desenhada pra um corpo diferente
 * (mesma lógica de resolveOutfitSkinId mais abaixo). undefined se não
 * achar nenhum tom do mesmo sexo -- quem chama trata como "não desenha
 * nada" (ver setLocalBeardId/setLocalSkinId em MainScene.ts). */
export function resolveBeardSkinId(beard: BeardOption, skinId: string): string | undefined {
  if (beard.bySkin[skinId]) return skinId;
  const gender = skinGenderOf(skinId);
  return Object.keys(beard.bySkin).find((id) => skinGenderOf(id) === gender);
}

/** Devolve o arquivo da barba pro tom de pele atual (ver resolveBeardSkinId). */
export function beardFileForSkin(beard: BeardOption, skinId: string): string | undefined {
  const resolved = resolveBeardSkinId(beard, skinId);
  return resolved ? beard.bySkin[resolved] : undefined;
}

/**
 * Acessório (camada "oculos") -- mesmas 3 poses da barba (sem costas),
 * mas AQUI a variação continua sendo uma COR manual escolhida (estilo
 * com cores aninhadas vira `colors`, ver scripts/syncAccessoryAssets.mjs
 * -- diferente da barba, que virou tom de pele automático). "Nenhum" é
 * a opção padrão. O nome da categoria/camada ("acessorio"/"oculos") já
 * existia antes desse catálogo (ver CUSTOMIZATION_CATEGORIES/
 * LAYER_DRAW_ORDER em MainScene.ts) -- por enquanto só óculos, mas
 * qualquer acessório de rosto/cabeça pode entrar na mesma pasta de
 * origem.
 */
export interface AccessoryOption {
  id: string;
  label: string;
  file: string;
  colors?: ColorOption[];
}

// pedido do Douglas: "rapa tudo que tem de item, vou subir tudo pela
// plataforma" -- mesma ideia de HAIR_CATALOG acima, tirou os acessórios
// "de fábrica" (pasta local, ver scripts/syncAccessoryAssets.mjs) daqui,
// só sobra "Nenhum" até ele recadastrar pelo Editor de Itens >
// Acessório (tabela avatar_items). Arquivos/script continuam existindo
// -- é só reimportar GENERATED_ACCESSORY_CATALOG de
// ./accessoryCatalog.generated (mesmo esquema de antes) se quiser voltar
// a usá-los.
export const ACCESSORY_CATALOG: AccessoryOption[] = [
  { id: "nenhum", label: "Nenhum", file: "acessorio_nenhum.png" },
];

export const DEFAULT_ACCESSORY_ID = ACCESSORY_CATALOG[0].id;

/**
 * Traje (camada "traje") -- a roupa inteira do pescoço pra baixo, como
 * UMA peça só por look (não separada em camisa/calça/tênis -- ver
 * scripts/syncOutfitAssets.mjs). Diferente das outras camadas, cada
 * traje não é UM arquivo, é um MAPA de arquivos por tom de pele
 * (`bySkin`, chave = id do SkinOption) -- porque a mão fica exposta e
 * precisa bater com o tom escolhido no avatar. `outfitFileForSkin`
 * resolve qual arquivo usar: o exato do tom atual se existir, senão o
 * primeiro tom disponível (pra nunca ficar sem desenhar nada) --
 * `resolveOutfitSkinId` devolve só o ID resolvido, usado pra montar a
 * texture key (ver outfitTextureKey em MainScene.ts).
 */
export interface OutfitOption {
  id: string;
  label: string;
  bySkin: Partial<Record<string, string>>;
}

// gerado automaticamente -- ver scripts/syncOutfitAssets.mjs, NÃO editar
// esse import nem o arquivo dele à mão.
//
// pedido do Douglas: "rapa tudo que tem de item, vou subir tudo pela
// plataforma" -- mesma ideia de HAIR_CATALOG acima, tirou os trajes "de
// fábrica" (pasta local, ver scripts/syncOutfitAssets.mjs) daqui, só
// sobra "Nenhum" até ele recadastrar pelo Editor de Itens > Traje
// (tabela avatar_items). Arquivo/script continuam existindo -- é só
// reimportar GENERATED_OUTFIT_CATALOG de ./outfitCatalog.generated
// (mesmo esquema de antes) se quiser voltar a usá-los.
export const OUTFIT_CATALOG: OutfitOption[] = [
  { id: "nenhum", label: "Nenhum", bySkin: { [DEFAULT_SKIN_ID]: "traje_nenhum.png" } },
];

export const DEFAULT_OUTFIT_ID = OUTFIT_CATALOG[0].id;

/** Devolve o ID de tom de pele cujo arquivo deve ser usado pro traje: o
 * exato se existir, senão o primeiro disponível no `bySkin` DO MESMO
 * SEXO (ver skinGenderOf/resolveBeardSkinId acima) -- nunca cai pro tom
 * de OUTRO sexo (a roupa foi desenhada pra um corpo diferente, ficava
 * sobreposta errado -- bug relatado pelo Douglas). undefined se não
 * achar nenhum tom do mesmo sexo (hoje só acontece nos tons femininos,
 * que ainda não têm traje próprio -- ver bySkin dos trajes gerados por
 * scripts/syncOutfitAssets.mjs, só cobre pastas de tom MASCULINO por
 * enquanto); quem chama trata como "não desenha nada" (ver
 * setLocalOutfitId/setLocalSkinId em MainScene.ts). */
export function resolveOutfitSkinId(outfit: OutfitOption, skinId: string): string | undefined {
  if (outfit.bySkin[skinId]) return skinId;
  const gender = skinGenderOf(skinId);
  return Object.keys(outfit.bySkin).find((id) => skinGenderOf(id) === gender);
}

/** Devolve o arquivo do traje pro tom de pele atual (ver resolveOutfitSkinId). */
export function outfitFileForSkin(outfit: OutfitOption, skinId: string): string | undefined {
  const resolved = resolveOutfitSkinId(outfit, skinId);
  return resolved ? outfit.bySkin[resolved] : undefined;
}

/**
 * Categorias do editor de personagem ("Editar meu personagem", ver
 * ProfileCard em GameRoom.tsx). Cabelo, tom de pele, barba, acessório e
 * traje já têm itens de verdade (ou estrutura pronta pra receber, no
 * caso do traje) -- prontas sem precisar mexer no card em si (tamanho
 * fixo, rolagem interna).
 */
export type CustomizationCategoryId =
  | "cabelo"
  | "acessorio"
  | "barba"
  | "traje";

export interface CustomizationCategory {
  id: CustomizationCategoryId;
  label: string;
}

export const CUSTOMIZATION_CATEGORIES: CustomizationCategory[] = [
  { id: "cabelo", label: "Cabelo" },
  { id: "acessorio", label: "Acessório" },
  { id: "barba", label: "Barba" },
  { id: "traje", label: "Traje" },
];

/**
 * Empurra item(ns) CUSTOM(izado(s)) direto pra dentro de um catálogo
 * (mesmo truque de registerCustomSkins acima e
 * registerCustomFurnitureModels em game/furniture.ts -- array é tipo
 * referência, então todo lugar que já importa o catálogo direto enxerga
 * os itens novos sozinho). UPSERT por id: chamar de novo com o mesmo id
 * substitui em vez de duplicar. Usado por registerCustomHair/
 * Accessories/Beards/Outfits logo abaixo (ver fetchAndRegisterCustomAvatarItems
 * em GameRoom.tsx, que monta o BeardOption/OutfitOption já com `bySkin`
 * pronto -- um id por tom de pele selecionado no Editor de Itens, todos
 * apontando pra MESMA folha, ver comentário lá).
 */
function upsertCatalogById<T extends { id: string }>(catalog: T[], items: T[]): void {
  for (const item of items) {
    const existingIndex = catalog.findIndex((c) => c.id === item.id);
    if (existingIndex !== -1) catalog[existingIndex] = item;
    else catalog.push(item);
  }
}

/**
 * Cabelo CUSTOM, cadastrado pelo dono da sala no Editor de Itens (botão
 * "Criar Avatar" > categoria "Cabelo" -- ver components/ItemEditor.tsx,
 * app/api/avatar-items e a tabela avatar_items do Supabase). RODA JUNTO
 * com a pasta local (mesmo esquema de registerCustomSkins acima), não
 * troca nada que já existia.
 */
export function registerCustomHair(items: HairOption[]): void {
  upsertCatalogById(HAIR_CATALOG, items);
}

/** Acessório CUSTOM -- ver registerCustomHair acima. */
export function registerCustomAccessories(items: AccessoryOption[]): void {
  upsertCatalogById(ACCESSORY_CATALOG, items);
}

/**
 * Barba CUSTOM -- ver registerCustomHair acima. Diferente de
 * cabelo/acessório, cada barba já chega com `bySkin` PRONTO (montado em
 * GameRoom.tsx a partir dos tons de pele escolhidos no Editor de Itens,
 * ver skin_ids na tabela avatar_items) -- pode cobrir mais de um tom
 * apontando pra MESMA folha (pedido do Douglas: "podendo selecionar
 * todos").
 */
export function registerCustomBeards(items: BeardOption[]): void {
  upsertCatalogById(BEARD_CATALOG, items);
}

/** Traje CUSTOM -- mesma ideia de registerCustomBeards acima. */
export function registerCustomOutfits(items: OutfitOption[]): void {
  upsertCatalogById(OUTFIT_CATALOG, items);
}
