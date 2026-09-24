/**
 * Sistema de grade (tiles) pra movimento estilo Gather/Habbo: o boneco
 * anda quadrado por quadrado, não em qualquer pixel. Móveis também
 * ficam alinhados nessa grade (ver furniture.ts), assim dá pra checar
 * "o jogador parou exatamente em cima do móvel" comparando tile, sem
 * precisar de raio de proximidade.
 */

export type Direction = "down" | "left" | "right" | "up";

// Resolução INTERNA do jogo (ver game/config.ts, que importa essas duas
// constantes em vez de repetir 1200/900 espalhado) -- aumentada de
// 800x600 pra 1200x900 (pedido do Douglas: o canvas fixo de 800x600
// esticado pra tela real borrava tudo, principalmente o avatar, ver
// comentário de AVATAR_SCALE em MainScene.ts). Continua 4:3, só que com
// mais pixel de verdade pra trabalhar -- cada elemento (avatar, piso,
// móvel de fábrica) usa mais da resolução ORIGINAL da arte em vez de
// jogar ela fora encolhendo demais. Chegou a ser testado em 2x (1600x
// 1200), mas o Douglas sentiu peso real de performance (arrastar/andar
// engasgando) -- 1.5x é o meio-termo: ainda ajuda bastante a nitidez
// (4x pixel total seria pesado demais; 2.25x é bem mais leve pra GPU) e
// ficou fluido. TILE/GRID_ORIGIN abaixo também escalaram junto, pra
// manter a MESMA proporção visual de sempre (não muda layout nenhum, só
// a nitidez). GRID_COLS/GRID_ROWS (quantidade de quadrados) são outra
// conversa -- não mexem aqui.
export const GAME_WIDTH = 1200;
export const GAME_HEIGHT = 900;

// TILE era 40px, depois 60px -- muito pequeno perto da mobília nova
// (poltrona tem uns 150-175px de largura): o "quadradinho" (base/
// footprint de 1 tile) que o avatar anda e onde o móvel se ancora
// precisa ser um pedaço mais generoso do chão, senão fica difícil de
// ler onde cada coisa realmente "está". Móvel/boneco continuam podendo
// ultrapassar visualmente a própria casinha (principalmente pra cima,
// por causa da altura) -- isso é normal, é como funciona no Habbo -- só
// a base em si que precisava ficar maior. Escalado de 60->90 (1.5x)
// junto com GAME_WIDTH/GAME_HEIGHT acima (ver comentário lá).
export const TILE = 90;

// mesma área jogável em PROPORÇÃO que antes (era 40..760/108..528 numa
// tela de 800x600 -- 5%..95% de largura, 18%..88% de altura --, agora
// 60..1140/162..792 numa tela de 1200x900, exatamente a mesma faixa),
// só que com mais pixel de verdade por trás.
export const GRID_ORIGIN_X = 60;
export const GRID_ORIGIN_Y = 162;
export const GRID_COLS = 12; // colunas 0..12 (13 posições) -> x: 60..1140
export const GRID_ROWS = 7; // linhas 0..7 (8 posições)     -> y: 162..792

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
