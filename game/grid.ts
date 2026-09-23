/**
 * Sistema de grade (tiles) pra movimento estilo Gather/Habbo: o boneco
 * anda quadrado por quadrado, não em qualquer pixel. Móveis também
 * ficam alinhados nessa grade (ver furniture.ts), assim dá pra checar
 * "o jogador parou exatamente em cima do móvel" comparando tile, sem
 * precisar de raio de proximidade.
 */

export type Direction = "down" | "left" | "right" | "up";

// TILE era 40px -- muito pequeno perto da mobília nova (poltrona tem uns
// 150-175px de largura): o "quadradinho" (base/footprint de 1 tile) que
// o avatar anda e onde o móvel se ancora precisa ser um pedaço mais
// generoso do chão, senão fica difícil de ler onde cada coisa realmente
// "está". Móvel/boneco continuam podendo ultrapassar visualmente a
// própria casinha (principalmente pra cima, por causa da altura) --
// isso é normal, é como funciona no Habbo -- só a base em si que
// precisava ficar maior.
export const TILE = 60;

// mesma área jogável em pixel que antes (40..760, 108..528ish), só que
// com tiles maiores -> menos quadrados, cada um maior.
export const GRID_ORIGIN_X = 40;
export const GRID_ORIGIN_Y = 108;
export const GRID_COLS = 12; // colunas 0..12 (13 posições) -> x: 40..760
export const GRID_ROWS = 7; // linhas 0..7 (8 posições)     -> y: 108..528

export function tileToWorld(col: number, row: number) {
  return { x: GRID_ORIGIN_X + col * TILE, y: GRID_ORIGIN_Y + row * TILE };
}

export function worldToTile(x: number, y: number) {
  return {
    col: Math.round((x - GRID_ORIGIN_X) / TILE),
    row: Math.round((y - GRID_ORIGIN_Y) / TILE),
  };
}

export function clampTile(col: number, row: number) {
  return {
    col: Math.max(0, Math.min(GRID_COLS, col)),
    row: Math.max(0, Math.min(GRID_ROWS, row)),
  };
}
