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
export interface HairOption {
  id: string;
  label: string;
  file: string;
}

export const HAIR_CATALOG: HairOption[] = [
  { id: "ondulado", label: "Ondulado", file: "cabelo_1.png" },
  { id: "para-tras", label: "Para trás", file: "cabelo_2.png" },
];

export const DEFAULT_HAIR_ID = HAIR_CATALOG[0].id;
