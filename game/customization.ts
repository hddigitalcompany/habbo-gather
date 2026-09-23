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
 */
export interface SkinOption {
  id: string;
  label: string;
  file: string;
  hex?: string;
}

// gerado automaticamente -- ver scripts/syncSkinAssets.mjs, NÃO editar
// esse import nem o arquivo dele à mão.
import { GENERATED_SKIN_CATALOG } from "./skinCatalog.generated";

export const SKIN_CATALOG: SkinOption[] = [
  { id: "padrao", label: "Padrão", file: "avatar_visual1.png" },
  ...GENERATED_SKIN_CATALOG,
];

export const DEFAULT_SKIN_ID = SKIN_CATALOG[0].id;

/**
 * Categorias do editor de personagem ("Editar meu personagem", ver
 * ProfileCard em GameRoom.tsx). Só "cabelo" tem itens de verdade por
 * enquanto -- as outras ficam com a aba visível e um "em breve" no
 * lugar da grade, prontas pra quando a arte de cada uma chegar, sem
 * precisar mexer no card em si (tamanho fixo, rolagem interna).
 */
export type CustomizationCategoryId =
  | "cabelo"
  | "acessorio"
  | "barba"
  | "camisa"
  | "jaqueta"
  | "calca"
  | "tenis";

export interface CustomizationCategory {
  id: CustomizationCategoryId;
  label: string;
}

export const CUSTOMIZATION_CATEGORIES: CustomizationCategory[] = [
  { id: "cabelo", label: "Cabelo" },
  { id: "acessorio", label: "Acessório" },
  { id: "barba", label: "Barba" },
  { id: "camisa", label: "Camisa" },
  { id: "jaqueta", label: "Jaqueta" },
  { id: "calca", label: "Calça" },
  { id: "tenis", label: "Tênis" },
];
