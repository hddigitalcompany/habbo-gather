import { tileToWorld } from "./grid";

/**
 * Móveis da sala, posicionados em coordenada de TILE (não pixel) pra
 * ficarem sempre alinhados com a grade que o avatar anda. Cada item tem
 * um "tipo" — hoje só existe "chair", que faz o avatar sentar sozinho
 * quando ele PARA totalmente em cima do tile do móvel (não é mais por
 * raio/proximidade enquanto anda perto).
 */

export type FurnitureType = "chair";

export interface FurnitureDef {
  id: string;
  type: FurnitureType;
  /** posição em tiles (não pixel) -- ver game/grid.ts */
  col: number;
  row: number;
  /** direção que o avatar fica "olhando" quando usa esse móvel */
  facing: "down" | "left" | "right" | "up";
  /** chave da textura carregada no preload() */
  textureKey: string;
  /** ajuste fino (px) pra onde o avatar aparece sentado, em relação ao
   * ponto-âncora do móvel (que é onde o pé/base do móvel toca o chão) */
  seatOffsetY?: number;
}

// cadeira de teste, só pra validar o sistema de auto-sentar. Posição/arte
// definitiva vem depois, junto com o resto da mobília da sala.
export const ROOM_FURNITURE: FurnitureDef[] = [
  {
    id: "cadeira-teste",
    type: "chair",
    col: 14,
    row: 8,
    facing: "down",
    textureKey: "chair",
    seatOffsetY: 6,
  },
];

export function furnitureWorldPos(f: FurnitureDef) {
  return tileToWorld(f.col, f.row);
}
