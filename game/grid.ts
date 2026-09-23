/**
 * Sistema de grade (tiles) pra movimento estilo Gather/Habbo: o boneco
 * anda quadrado por quadrado, não em qualquer pixel. Móveis também
 * ficam alinhados nessa grade (ver furniture.ts), assim dá pra checar
 * "o jogador parou exatamente em cima do móvel" comparando tile, sem
 * precisar de raio de proximidade.
 */

export type Direction = "down" | "left" | "right" | "up";

export const TILE = 40;

// mesma área jogável que o bounds em pixel usava antes (40..760, 108..570)
export const GRID_ORIGIN_X = 40;
export const GRID_ORIGIN_Y = 108;
export const GRID_COLS = 18; // colunas 0..18 (19 posições) -> x: 40..760
export const GRID_ROWS = 11; // linhas 0..11 (12 posições)  -> y: 108..548

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
