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

// itens gerados automaticamente a partir da pasta de origem de cabelo
// (ver scripts/avatarAssetsConfig.mjs/syncAvatarAssets.mjs, roda sozinho
// junto com `npm run dev`). NÃO editar esse import nem o arquivo dele à
// mão, ele é reescrito toda vez que a pasta muda.
//
// GENERATED_HAIR_CATALOG: penteados novos, que ainda não existem abaixo
// à mão (cada um já vem com suas próprias cores, se a pasta de origem
// tiver estilo/cor aninhados).
// GENERATED_HAIR_COLORS_BY_STYLE: cores de um penteado que JÁ existe
// aqui embaixo (casadas pelo nome da pasta de estilo -- "Cabelinho pra
// trás"/"Vorcarinho do Rói" -- ver MANUAL_STYLE_MATCH no script) --
// entram dentro do `colors` do item manual correspondente, em vez de
// criar um item novo na grade principal.
import { GENERATED_HAIR_CATALOG, GENERATED_HAIR_COLORS_BY_STYLE } from "./customizationCatalog.generated";

export const HAIR_CATALOG: HairOption[] = [
  {
    id: "ondulado",
    label: "Cabelinho pra trás",
    file: "cabelo_1.png",
    colors: GENERATED_HAIR_COLORS_BY_STYLE["ondulado"],
  },
  {
    id: "vorcarinho-do-roi",
    label: "Vorcarinho do Rói",
    file: "cabelo_3.png",
    colors: GENERATED_HAIR_COLORS_BY_STYLE["vorcarinho-do-roi"],
  },
  ...GENERATED_HAIR_CATALOG,
];

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
  file: string;
  hex?: string;
  /** Ver AvatarGender acima -- gerado automaticamente (ver
   * scripts/syncSkinAssets.mjs), sempre presente num catálogo recém-
   * sincronizado; opcional aqui só pra não quebrar um catálogo gerado
   * antes dessa mudança (ausente = trata como "masculino", ver
   * SKIN_CATALOG mais abaixo). */
  gender?: AvatarGender;
}

// gerado automaticamente -- ver scripts/syncSkinAssets.mjs, NÃO editar
// esse import nem o arquivo dele à mão.
import { GENERATED_SKIN_CATALOG } from "./skinCatalog.generated";

export const SKIN_CATALOG: SkinOption[] = [...GENERATED_SKIN_CATALOG].sort((a, b) =>
  a.id === "branco" ? -1 : b.id === "branco" ? 1 : 0
);

export const DEFAULT_SKIN_ID = SKIN_CATALOG[0]?.id ?? "branco";

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

// gerado automaticamente -- ver scripts/syncBeardAssets.mjs, NÃO editar
// esse import nem o arquivo dele à mão.
import { GENERATED_BEARD_CATALOG } from "./beardCatalog.generated";

export const BEARD_CATALOG: BeardOption[] = [
  { id: "nenhuma", label: "Nenhuma", bySkin: { [DEFAULT_SKIN_ID]: "barba_nenhuma.png" } },
  ...GENERATED_BEARD_CATALOG,
];

export const DEFAULT_BEARD_ID = BEARD_CATALOG[0].id;

/** Devolve o ID de tom de pele cujo arquivo deve ser usado pra barba: o
 * exato se existir, senão o primeiro disponível no `bySkin` (mesma
 * lógica de resolveOutfitSkinId mais abaixo). */
export function resolveBeardSkinId(beard: BeardOption, skinId: string): string | undefined {
  if (beard.bySkin[skinId]) return skinId;
  return Object.keys(beard.bySkin)[0];
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

// gerado automaticamente -- ver scripts/syncAccessoryAssets.mjs, NÃO
// editar esse import nem o arquivo dele à mão.
import { GENERATED_ACCESSORY_CATALOG } from "./accessoryCatalog.generated";

export const ACCESSORY_CATALOG: AccessoryOption[] = [
  { id: "nenhum", label: "Nenhum", file: "acessorio_nenhum.png" },
  ...GENERATED_ACCESSORY_CATALOG,
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
import { GENERATED_OUTFIT_CATALOG } from "./outfitCatalog.generated";

export const OUTFIT_CATALOG: OutfitOption[] = [
  { id: "nenhum", label: "Nenhum", bySkin: { [DEFAULT_SKIN_ID]: "traje_nenhum.png" } },
  ...GENERATED_OUTFIT_CATALOG,
];

export const DEFAULT_OUTFIT_ID = OUTFIT_CATALOG[0].id;

/** Devolve o ID de tom de pele cujo arquivo deve ser usado pro traje: o
 * exato se existir, senão o primeiro disponível no `bySkin` (undefined
 * só se o traje não tiver NENHUM tom, o que não deveria acontecer). */
export function resolveOutfitSkinId(outfit: OutfitOption, skinId: string): string | undefined {
  if (outfit.bySkin[skinId]) return skinId;
  return Object.keys(outfit.bySkin)[0];
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
