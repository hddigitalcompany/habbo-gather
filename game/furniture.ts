import { tileToWorld, Direction } from "./grid";

/**
 * Móveis da sala, posicionados em coordenada de TILE (não pixel) pra
 * ficarem sempre alinhados com a grade que o avatar anda. Cada item tem
 * um "tipo" (a peça de mobília) e uma "facing" (pra que lado ela olha na
 * sala) -- o avatar senta sozinho quando PARA totalmente em cima do tile
 * do móvel (não é mais por raio/proximidade enquanto anda perto).
 *
 * Cada tipo de móvel tem uma imagem POR DIREÇÃO (ver FURNITURE_ART),
 * igual ao boneco -- assim a poltrona (e os próximos móveis) aparecem
 * viradas pro lado certo em vez de usar sempre a mesma arte de frente.
 */

export type FurnitureType = "poltrona";

export interface FurnitureDef {
  id: string;
  type: FurnitureType;
  /** posição em tiles (não pixel) -- ver game/grid.ts */
  col: number;
  row: number;
  /** direção que o avatar (e a arte do móvel) fica "olhando" */
  facing: Direction;
  /** ajuste fino (px) pra onde o avatar aparece sentado, em relação ao
   * ponto-âncora do móvel (que é onde o pé/base do móvel toca o chão).
   * Negativo = avatar sobe (senta na altura do assento); ainda é uma
   * estimativa visual, ajustar depois de ver renderizado. */
  seatOffsetY?: number;
}

/**
 * Arte de cada tipo de móvel, um arquivo por direção, em
 * `public/assets/`. Se uma direção não tiver arquivo, cai pra "down"
 * como fallback (ver furnitureArtFile).
 */
export const FURNITURE_ART: Record<FurnitureType, Partial<Record<Direction, string>>> = {
  poltrona: {
    down: "poltrona_frente.png",
    left: "poltrona_lado_esq.png",
    right: "poltrona_lado_dir.png",
    up: "poltrona_costas.png",
  },
};

/** Chave da textura no Phaser pra um móvel numa direção (ex: "poltrona" + "left" -> "furniture-poltrona-left"). */
export function furnitureTextureKey(type: FurnitureType, facing: Direction): string {
  return `furniture-${type}-${facing}`;
}

/** Nome do arquivo em public/assets pra essa peça+direção (com fallback pra "down"). */
export function furnitureArtFile(type: FurnitureType, facing: Direction): string | null {
  const art = FURNITURE_ART[type];
  return art[facing] ?? art.down ?? null;
}

// poltrona de teste, só pra validar o sistema de auto-sentar com arte
// direcional de verdade. Posição definitiva vem depois, junto com o
// resto da mobília da sala.
export const ROOM_FURNITURE: FurnitureDef[] = [
  {
    id: "poltrona-1",
    type: "poltrona",
    col: 9,
    row: 5,
    facing: "down",
    seatOffsetY: -30,
  },
];

export function furnitureWorldPos(f: FurnitureDef) {
  return tileToWorld(f.col, f.row);
}
