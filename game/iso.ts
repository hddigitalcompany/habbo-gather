/**
 * Geometria do losango isométrico -- separado de game/grid.ts (que só
 * tem a matemática de projeção col/row -> pixel, sem depender de
 * Phaser) porque isso aqui é usado por MainScene.ts pra desenhar
 * CONTORNO/PREENCHIMENTO de tile: antes (grade quadrada/plana) bastava
 * um fillRect/strokeRect centrado no ponto; agora cada tile é um
 * losango (ver ISO_TILE_WIDTH/ISO_TILE_HEIGHT em grid.ts), então todo
 * lugar que desenhava "1 quadrado de tile" (hover do editor, tinta de
 * área, véu de fora-da-área, grade do editor) passou a usar os pontos
 * daqui com Graphics.fillPoints/strokePoints em vez de fillRect/
 * strokeRect.
 */
import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT } from "./grid";

export interface Point {
  x: number;
  y: number;
}

/**
 * Os 4 cantos do losango de UM tile, centrado em (cx, cy) -- nesta
 * ordem: topo (vértice de trás, mais longe da câmera), direita, baixo
 * (vértice da frente, mais perto da câmera), esquerda. Fechar o
 * polígono (closeShape=true no fillPoints/strokePoints) liga o último
 * ponto de volta ao primeiro.
 */
export function tileDiamondCorners(cx: number, cy: number): Point[] {
  const hw = ISO_TILE_WIDTH / 2;
  const hh = ISO_TILE_HEIGHT / 2;
  return [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
}

/**
 * Os 4 cantos do PARALELOGRAMO (losango maior) formado por um
 * retângulo de tiles minCol..maxCol / minRow..maxRow -- usado pela
 * borda/hitbox de área (redrawAreaBorders/updateAreaHoverLabels em
 * MainScene.ts), que antes desenhava um retângulo reto em cima do
 * bounding-box em pixel (fazia sentido na grade quadrada; na grade
 * losangular o bounding-box de tiles vira um paralelogramo, não um
 * retângulo). `tileToWorld` é passado por fora (em vez de importado
 * daqui) pra este arquivo não duplicar a fórmula de projeção -- quem
 * chama já tem ela disponível (game/grid.ts).
 *
 * min/maxCol/Row aceitam fração -- pra pegar a borda de FORA dos tiles
 * de ponta (não só o centro deles), quem chama passa `minCol - 0.5` /
 * `maxCol + 0.5` etc. (mesma ideia do "+TILE/2 de cada lado" que o
 * retângulo reto de antes fazia em pixel -- aqui vira meio passo de
 * col/row, projetado igual a qualquer outro ponto).
 */
export function tileRangeCorners(
  tileToWorld: (col: number, row: number) => Point,
  minCol: number,
  minRow: number,
  maxCol: number,
  maxRow: number
): Point[] {
  const back = tileToWorld(minCol, minRow); // menor col+row -- vértice de trás (topo na tela)
  const right = tileToWorld(maxCol, minRow);
  const front = tileToWorld(maxCol, maxRow); // maior col+row -- vértice da frente (embaixo na tela)
  const left = tileToWorld(minCol, maxRow);
  return [back, right, front, left];
}
