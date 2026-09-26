/**
 * Sistema de grade (tiles) pra movimento estilo Gather/Habbo: o boneco
 * anda quadrado por quadrado, não em qualquer pixel. Móveis também
 * ficam alinhados nessa grade (ver furniture.ts), assim dá pra checar
 * "o jogador parou exatamente em cima do móvel" comparando tile, sem
 * precisar de raio de proximidade.
 *
 * ISOMÉTRICO (pedido do Douglas: "se a gente fizesse em perspectiva
 * igual do habbo, em diagonal?" -> "confirme esse angulo e pode meter
 * marcha! ta decidido"): cada tile virou um LOSANGO (proporção 2:1,
 * largura = 2x a altura -- o mesmo ângulo clássico do Habbo, ~26.57°,
 * ver ISO_TILE_WIDTH/ISO_TILE_HEIGHT abaixo) em vez de um quadrado.
 * col/row continuam sendo a MESMA grade lógica de sempre (linha/coluna
 * inteira, movimento/colisão/posse de área tudo baseado nisso, sem
 * mudar) -- só a fórmula que converte col/row pra pixel na tela mudou.
 * Antes (quadrado, plano): x = origem + col*TILE, y = origem + row*TILE.
 * Agora (losango, diagonal): cada passo em COL desloca a tela pra
 * direita-baixo, cada passo em ROW desloca pra esquerda-baixo -- então
 * x depende da DIFERENÇA (col-row) e y depende da SOMA (col+row). Esse
 * é o motivo de duas coisas darem "de graça" nessa fórmula, sem
 * precisar de nenhum ajuste extra: (1) profundidade -- como y só
 * depende da SOMA col+row, ordenar por y (ver avatarDepthForY em
 * MainScene.ts) já ordena certinho por "distância da câmera" sozinho;
 * (2) tudo que já usava tileToWorld/worldToTile (movimento, clique,
 * posse de área, piso) continua funcionando sem mexer em mais nada além
 * daqui -- só quem desenha FORMA (quadrado -> losango, ver
 * game/iso.ts) precisou de ajuste.
 *
 * Import pra quem for desenhar o contorno/preenchimento de um tile:
 * ver tileDiamondCorners em game/iso.ts (não redeclarado aqui pra não
 * criar dependência de Phaser neste arquivo, que fica só com a
 * matemática pura de grid, sem nada de motor gráfico).
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
// ficou fluido. A resolução em si NÃO muda com a virada pro isométrico
// (só o formato/posição do tile dentro dela, ver acima).
export const GAME_WIDTH = 1200;
export const GAME_HEIGHT = 900;

// Tamanho do LOSANGO de 1 tile, ponta a ponta -- proporção 2:1 fixada
// com o Douglas (largura = 2x altura, ângulo ~26.57°, igual ao Habbo
// clássico). 96x48 escolhido por ser múltiplo redondo de 16 (facilita
// desenhar em cima -- 6 "blocos" de 16px de largura por 3 de altura) e
// por caber com folga nos 12x7 tiles da grade dentro dos 1200x900 de
// resolução interna (ver GRID_ORIGIN_X/Y abaixo, calculados em cima
// desse tamanho). Esses dois números são a REFERÊNCIA que a arte nova
// (piso, móvel, o gabarito que o Douglas vai pixelar por cima) precisa
// respeitar -- mudar aqui descola tile da arte já desenhada.
export const ISO_TILE_WIDTH = 96;
export const ISO_TILE_HEIGHT = 48;

// TILE antigo (quadrado, 90px) fica só de referência histórica nos
// comentários de quem ainda cita "1 tile" como unidade de deslocamento
// vertical solto (ex: SEAT_Y_* em furniture.ts, calibrado à mão) -- não
// é mais usado pra desenhar formato de tile nenhum (isso agora é
// ISO_TILE_WIDTH/HEIGHT + tileDiamondCorners em game/iso.ts).

// Origem (pixel do CENTRO do tile col=0,row=0) escolhida pra grade
// 12x7 inteira caber nos 1200x900 com folga: sobra ~144px de cada lado
// (esquerda/direita) e ~220px em cima (espaço pra parede, que no
// isométrico "sobe" a partir do fundo da sala) / ~224px embaixo
// (espaço pra UI/primeiro plano) -- ver a conta completa no comentário
// do commit. São só constantes -- o Douglas pode reajustar ao vivo
// depois de ver a arte nova de verdade, sem precisar mexer em mais
// nada (tudo deriva daqui).
export const GRID_ORIGIN_X = 480;
export const GRID_ORIGIN_Y = 220;
export const GRID_COLS = 12; // colunas 0..12 (13 posições)
export const GRID_ROWS = 7; // linhas 0..7 (8 posições)

export function tileToWorld(col: number, row: number) {
  return {
    x: GRID_ORIGIN_X + (col - row) * (ISO_TILE_WIDTH / 2),
    y: GRID_ORIGIN_Y + (col + row) * (ISO_TILE_HEIGHT / 2),
  };
}

export function worldToTile(x: number, y: number) {
  // inverso de tileToWorld: dx = (col-row)*(W/2) e dy = (col+row)*(H/2)
  // -- resolvendo o sistema, col = (a+b)/2 e row = (b-a)/2, onde
  // a = col-row (derivado de dx) e b = col+row (derivado de dy).
  const a = (x - GRID_ORIGIN_X) / (ISO_TILE_WIDTH / 2);
  const b = (y - GRID_ORIGIN_Y) / (ISO_TILE_HEIGHT / 2);
  return {
    col: Math.round((a + b) / 2),
    row: Math.round((b - a) / 2),
  };
}

export function clampTile(col: number, row: number) {
  return {
    col: Math.max(0, Math.min(GRID_COLS, col)),
    row: Math.max(0, Math.min(GRID_ROWS, row)),
  };
}
