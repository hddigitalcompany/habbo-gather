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
 * Variação de COR de um item (ex: "Cabelinho pra trás" em preto,
 * castanho, loiro...) -- por enquanto é só um espaço reservado: as
 * artes/tons de verdade ainda não existem, o Douglas vai mandar depois
 * item por item. Até lá, `colors` fica vazio/ausente em cada opção do
 * catálogo, e o editor (ver ProfileCard em GameRoom.tsx) já sabe
 * mostrar essa lista quando ela existir, sem precisar mexer em mais
 * nada.
 */
export interface ColorOption {
  id: string;
  label: string;
  hex: string;
}

export interface HairOption {
  id: string;
  label: string;
  file: string;
  colors?: ColorOption[];
}

// itens gerados automaticamente a partir de assets-source/cabelo/ -- ver
// scripts/syncAvatarAssets.mjs (roda sozinho junto com `npm run dev`).
// NÃO editar esse import nem o arquivo dele à mão, ele é reescrito toda
// vez que a pasta muda.
import { GENERATED_HAIR_CATALOG } from "./customizationCatalog.generated";

export const HAIR_CATALOG: HairOption[] = [
  { id: "ondulado", label: "Cabelinho pra trás", file: "cabelo_1.png" },
  { id: "vorcarinho-do-roi", label: "Vorcarinho do Rói", file: "cabelo_3.png" },
  ...GENERATED_HAIR_CATALOG,
];

export const DEFAULT_HAIR_ID = HAIR_CATALOG[0].id;

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
