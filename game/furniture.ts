import { tileToWorld, Direction, TILE } from "./grid";

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

export type FurnitureType = "poltrona" | "vidro";

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
  /** mesma ideia, no eixo horizontal -- usado principalmente nas poses
   * de lado, pra jogar o boneco um pouco mais "pra frente" (na direção
   * que ele tá olhando) dentro do assento em vez de ficar centralizado
   * exatamente em cima do pé do móvel. */
  seatOffsetX?: number;
  /** exceção à regra de profundidade por fileira (ver DEPTH_* em
   * MainScene.ts): móveis "flat" -- sem altura de verdade, tipo um
   * tapete -- não fazem sentido o boneco "passar por trás" deles, então
   * ficam sempre atrás de tudo, feito decoração colada no chão. Não usar
   * pra móveis com overflow de altura (poltrona etc.) -- esses usam a
   * profundidade dinâmica normal. */
  flat?: boolean;
  /** móvel "de vidro" -- desenhado com transparência (ver GLASS_ALPHA em
   * MainScene.ts), pra quem ficar por trás dele (boneco, outro móvel)
   * continuar visível através, em vez de totalmente escondido. */
  transparent?: boolean;
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
  // "vidro" = categoria DIVISÓRIA DE VIDRO -- painel decorativo que
  // também é uma parede de verdade (ver FURNITURE_BLOCKS_MOVEMENT). Não
  // senta, não tem direção (mesma arte pras 4, cai sempre no fallback
  // "down", ver furnitureArtFile). 2 tiles de altura exatos, largura sem
  // vazar o tile.
  vidro: {
    down: "vidro.png",
  },
};

/**
 * Categoria de cada tipo de móvel -- só documentação/agrupamento, não
 * muda nenhuma lógica sozinha.
 */
export const FURNITURE_CATEGORY: Record<FurnitureType, string> = {
  poltrona: "assento",
  vidro: "divisória de vidro",
};

/**
 * Tipos de móvel cujo TILE (o próprio, onde ele está ancorado) trava a
 * passagem -- o boneco não consegue andar pra cima (ver startStep() em
 * MainScene.ts, que usa isso pra recusar o passo igual já fazia na
 * borda do mapa). O tile de CIMA (onde só a parte que "vaza" pra cima
 * do móvel aparece, por overflow de altura) continua livre normalmente
 * -- só o próprio tile do móvel é que trava.
 */
export const FURNITURE_BLOCKS_MOVEMENT: Record<FurnitureType, boolean> = {
  poltrona: false,
  vidro: true,
};

export function furnitureBlocksMovement(type: FurnitureType): boolean {
  return FURNITURE_BLOCKS_MOVEMENT[type] ?? false;
}

/** Chave da textura no Phaser pra um móvel numa direção (ex: "poltrona" + "left" -> "furniture-poltrona-left"). */
export function furnitureTextureKey(type: FurnitureType, facing: Direction): string {
  return `furniture-${type}-${facing}`;
}

/** Nome do arquivo em public/assets pra essa peça+direção (com fallback pra "down"). */
export function furnitureArtFile(type: FurnitureType, facing: Direction): string | null {
  const art = FURNITURE_ART[type];
  return art[facing] ?? art.down ?? null;
}

// 4 poltronas de teste, uma virada pra cada direção -- pra validar as 4
// artes (frente/lado esq/lado dir/costas) juntas na sala de uma vez.
// Posição definitiva vem depois, junto com o resto da mobília da sala.
//
// O ajuste de encaixe (seatOffsetY/X) é DIFERENTE por direção -- não dá
// mais pra usar um valor único pras 4: de frente/costas o boneco tava
// subindo demais (perto do valor antigo -12), então baixa quase pro
// zero; de lado ele tava baixo demais, então sobe mais que antes, e
// ganha um empurrão horizontal (seatOffsetX) na direção que a poltrona
// olha, pra não ficar sentado bem no meio do "pé" do móvel.
// -14 aqui compensa o AVATAR_FOOT_OFFSET_Y (ver MainScene.ts) -- as
// sprites do boneco agora são desenhadas 14px mais pra baixo dentro do
// próprio container (só isso resolve o "pé não fica centralizado" ao
// caminhar), mas isso empurraria o boneco sentado junto -- subtrai os
// mesmos 14px aqui pra ele continuar encaixado na poltrona do jeito que
// já tinha sido aprovado.
const SEAT_Y_FRENTE_COSTAS = -4 - 14;
const SEAT_Y_LADO = -18 - 14;
const SEAT_X_LADO = 12;

export const ROOM_FURNITURE: FurnitureDef[] = [
  {
    id: "poltrona-1",
    type: "poltrona",
    col: 9,
    row: 6,
    facing: "down",
    seatOffsetY: SEAT_Y_FRENTE_COSTAS,
  },
  {
    id: "poltrona-2",
    type: "poltrona",
    col: 3,
    row: 1,
    facing: "left",
    seatOffsetY: SEAT_Y_LADO,
    seatOffsetX: -SEAT_X_LADO,
  },
  {
    id: "poltrona-3",
    type: "poltrona",
    col: 9,
    row: 1,
    facing: "right",
    seatOffsetY: SEAT_Y_LADO,
    seatOffsetX: SEAT_X_LADO,
  },
  {
    id: "poltrona-4",
    type: "poltrona",
    col: 5,
    row: 2,
    facing: "up",
    seatOffsetY: SEAT_Y_FRENTE_COSTAS,
  },
  // painel de vidro de teste -- item alto (2 tiles de altura exatos) em
  // área livre, pra validar a troca de profundidade (andar por cima
  // dele desce por trás) e a transparência (ver através dele) juntas.
  // Fixado como divisória: o próprio tile trava (FURNITURE_BLOCKS_MOVEMENT),
  // o de cima (onde só a parte de cima vaza) continua livre e transparente normal.
  {
    id: "vidro-teste-1",
    type: "vidro",
    col: 1,
    row: 4,
    facing: "down",
    transparent: true,
  },
  // segundo teste: vidro um tile ABAIXO da poltrona-1, na mesma coluna
  // (reto/alinhado com ela) -- valida a profundidade quando o overflow
  // do vidro (que vaza pra cima, entrando na própria fileira da
  // poltrona) se sobrepõe ao boneco sentado ali.
  {
    id: "vidro-teste-2",
    type: "vidro",
    col: 9,
    row: 7,
    facing: "down",
    transparent: true,
  },
];

/** Retorna o móvel que TRAVA a passagem no tile dado, se houver (ver startStep() em MainScene.ts). */
export function blockingFurnitureAt(col: number, row: number): FurnitureDef | undefined {
  return ROOM_FURNITURE.find(
    (f) => f.col === col && f.row === row && furnitureBlocksMovement(f.type)
  );
}

export function furnitureWorldPos(f: FurnitureDef) {
  // tileToWorld() dá o CENTRO do tile -- é onde o boneco anda ancorado
  // (origin bottom-center dele fica bem no meio do quadrado, ver
  // MainScene). O móvel é diferente: ele precisa ficar "dentro do tile,
  // alinhado embaixo" (o pé/base encostando na borda debaixo do
  // quadrado, não flutuando no meio dele) -- por isso ancora meio tile
  // ABAIXO do centro, na borda inferior. Ele ainda pode ultrapassar o
  // tile por CIMA (altura normalmente > 1 tile), só não pro lado nem
  // pra baixo -- isso é o overflow esperado, como no Habbo.
  const center = tileToWorld(f.col, f.row);
  return { x: center.x, y: center.y + TILE / 2 };
}
