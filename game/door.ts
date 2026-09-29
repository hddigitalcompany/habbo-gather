import { WallSide, wallEdgeFloorPoints, wallEdgeLengthPx, wallDepthForSegment, wallWorldAnchor } from "./wall";
import { Point } from "./iso";

/**
 * Porta -- pedido do Douglas: "vamos criar uma nova categoria 'porta'...
 * porque ela precisa abrir de diferentes formas: por proximidade, como
 * se fosse uma porta automatica [e] o dono da area em questao pode
 * bloquear ela, fechar, pra que ninguem entre". Categoria SEPARADA de
 * parede (mesmo morando na mesma ARESTA da grade, ver DoorSide abaixo)
 * porque uma parede "padrão" é sempre a mesma coisa parada -- uma porta
 * tem ESTADO (aberta/fechada) que muda sozinho (avatar por perto) ou por
 * decisão de alguém (dono da área trava), coisa que parede nunca teve.
 *
 * Geometria da aresta: REAPROVEITA WallSide/wallEdgeFloorPoints/
 * wallDepthForSegment de game/wall.ts direto (mesma grade, mesmas 2
 * arestas nomeadas por tile -- ver comentário grande no topo de
 * wall.ts) em vez de duplicar essa matemática aqui -- só que uma porta
 * nunca faz sentido "no centro do tile" (variantes "center"/"centerRow"
 * de WallSide, pensadas pra pilastra solta) nem faz esquina/emenda como
 * parede corrida, então DoorSide fica restrito às 2 variantes de
 * fronteira mesmo (colPlus/rowPlus) -- uma porta sempre separa 2 tiles.
 */
export type DoorSide = Extract<WallSide, "colPlus" | "rowPlus">;

/** Só existem portas de correr por enquanto (pedido do Douglas: "por
 * enquanto, só terá porta de correr"), em 2 variantes -- a diferença
 * entre elas é só de ARTE (quantas folhas aparecem deslizando na
 * imagem "aberta"), sem nenhuma lógica de código diferente entre as
 * duas (ver DoorCatalogEntry.art abaixo: sempre 1 imagem "fechada" + 1
 * "aberta" por lado, não importa quantas folhas apareçam desenhadas
 * nelas) -- "kind" aqui é só pra ORGANIZAR o catálogo/formulário
 * "Criar Porta", igual FloorCategory em game/floor.ts. */
export type DoorKind = "correr-1-folha" | "correr-2-folhas";

export const DOOR_KINDS: { id: DoorKind; label: string }[] = [
  { id: "correr-1-folha", label: "De correr (1 folha)" },
  { id: "correr-2-folhas", label: "De correr (2 folhas)" },
];

/** Qual dos 2 lados da parede essa arte mostra -- mesma ideia de
 * FurnitureFacing "left"/"right" (ver game/furniture.ts: uma peça de
 * móvel tem arte "de frente"/"de lado esquerdo"/"de lado direito");
 * aqui só existem os 2 valores mesmo (uma porta não tem "de cima"/
 * "de baixo" pra escolher, só dá pra vê-la de um lado da parede ou do
 * outro). Pedido do Douglas: "eu subirei a arte. frente esq, frente
 * dir, mesma coisa" -- mesmo par de variante que o resto do jogo já
 * usa, escolhida ANTES de posicionar (ver DOOR_FACING_ROTATE_ORDER
 * abaixo), mesma mecânica de girar um móvel antes de colocar
 * (FURNITURE_ROTATE_ORDER em furniture.ts). */
export type DoorFacing = "left" | "right";

export const DOOR_FACING_ROTATE_ORDER: DoorFacing[] = ["left", "right"];

/** Par de imagem (aberta/fechada) pra UM lado (DoorFacing) de UM estilo
 * de porta -- "duas posições apenas" (pedido do Douglas), sem quadro
 * intermediário de animação: a transição entre as duas é um tween de
 * troca simples (ver refreshDoorState em MainScene.ts), não uma
 * sequência de frames. */
export interface DoorArtSet {
  closed: string;
  open: string;
}

export interface DoorCatalogEntry {
  /** uuid da linha em room_door_items (Supabase) -- porta sempre é
   * custom, sem estilo de fábrica hoje (Douglas ainda vai subir a
   * primeira arte, ver comentário grande no topo do arquivo). */
  id: string;
  label: string;
  kind: DoorKind;
  /** arte por lado -- "right" pode ficar ausente (cai pro "left", mesmo
   * fallback de FURNITURE_ART em furniture.ts) até existir a versão
   * espelhada de verdade. */
  art: Partial<Record<DoorFacing, DoorArtSet>>;
  /** Largura de exibição (px) -- pedido do Douglas: "quero editar a
   * dimensao dos arquivos que subo nelas tambem, com tile e ta; igual
   * os mobis normais" (mesma ideia de FurnitureModelDef.displayWidth).
   * undefined/null = comportamento de sempre (encaixa exatamente na
   * aresta, ver doorEdgeLengthPx em addDoorSprite, MainScene.ts) --
   * todo modelo cadastrado ANTES desse campo existir continua assim,
   * sem precisar reeditar nada. Preenchido = usa esse valor no lugar; a
   * ALTURA de cada imagem continua calculada pela proporção NATIVA
   * dela (setDisplaySize só trava a largura), igual já funcionava. Um
   * valor só pra porta inteira (não por lado esq/dir): os 2 lados são a
   * MESMA porta física vista de ângulos opostos, não faz sentido o vão
   * parecer mais largo de um lado que do outro. */
  displayWidth?: number;
  custom?: boolean;
}

export const DOOR_CATALOG: DoorCatalogEntry[] = [];

export function doorEntryById(id: string): DoorCatalogEntry | undefined {
  return DOOR_CATALOG.find((e) => e.id === id);
}

/** Registra modelo(s) de porta CUSTOMIZADO(s) -- mesma ideia de
 * registerCustomWallModels/registerCustomFloorModels (upsert por id,
 * empurra direto pra dentro de DOOR_CATALOG, array por referência). */
export function registerCustomDoorModels(entries: DoorCatalogEntry[]): string[] {
  const updatedIds: string[] = [];
  for (const entry of entries) {
    const existingIndex = DOOR_CATALOG.findIndex((e) => e.id === entry.id);
    const withFlag: DoorCatalogEntry = { ...entry, custom: true };
    if (existingIndex !== -1) {
      updatedIds.push(entry.id);
      DOOR_CATALOG[existingIndex] = withFlag;
    } else {
      DOOR_CATALOG.push(withFlag);
    }
  }
  return updatedIds;
}

/** Chave de textura Phaser pra UM estado (aberta/fechada) de UM lado de
 * um estilo de porta -- 4 texturas possíveis por estilo no total (2
 * lados x 2 estados), carregadas sob demanda (ver addDoorSprite em
 * MainScene.ts), mesma ideia de furnitureVariantTextureKey. */
export function doorTextureKey(styleId: string, facing: DoorFacing, open: boolean): string {
  return `door-${styleId}-${facing}-${open ? "open" : "closed"}`;
}

/** Um segmento de porta pintado numa aresta da grade -- mesma forma de
 * WallSegmentDef, só que numa Map SEPARADA (draftDoor, não draftWall,
 * ver MainScene.ts), então uma aresta pode ter no máximo 1 parede E no
 * máximo 1 porta seria redundante/sem sentido visual -- paintDoorAt/
 * paintWallAt se recusam a pintar uma em cima da outra na mesma
 * aresta (ver comentário lá). `facing` é escolhido ANTES de posicionar
 * (like móvel, ver DOOR_FACING_ROTATE_ORDER acima), fica gravado no
 * segmento pra sempre mostrar a arte certa depois. SEM campo `areaId`
 * de propósito -- qual área "mesa-privada" (se alguma) essa porta
 * guarda é sempre CALCULADO na hora (ver doorGuardedAreaId, tanto a
 * cópia cliente em MainScene.ts quanto a do servidor em
 * server/index.js), olhando os 2 tiles vizinhos da aresta -- assim uma
 * porta continua guardando a área certa mesmo se a área for redesenhada
 * depois de colocada, sem precisar re-salvar a porta. Sem área nenhuma
 * dos 2 lados, a porta funciona igual (abre por proximidade), só que
 * ninguém consegue travá-la manualmente. */
export interface DoorSegmentDef {
  col: number;
  row: number;
  side: DoorSide;
  styleId: string;
  facing: DoorFacing;
}

export function doorSegmentId(col: number, row: number, side: DoorSide): string {
  return `${col}_${row}_${side}`;
}

/** Dado 2 tiles ADJACENTES (1 passo de distância, sem diagonal -- os
 * únicos passos que o jogo já permite, ver computeWalkPath/startStep em
 * MainScene.ts), acha a aresta (col,row,side) que os separa -- usado
 * pra saber se uma porta FECHADA bloqueia essa travessia específica
 * (ver isMovementBlockedAt em MainScene.ts: diferente de parede
 * colPlus/rowPlus, que nunca trava passagem, uma porta trava quando
 * fechada -- é o ESTADO dela que decide, não a variante). Null se os 2
 * tiles não forem vizinhos de verdade (não deveria acontecer nos
 * chamadores de hoje, sempre 1 passo ortogonal). */
export function doorEdgeBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number
): { col: number; row: number; side: DoorSide } | null {
  if (toCol === fromCol + 1 && toRow === fromRow) return { col: fromCol, row: fromRow, side: "colPlus" };
  if (toCol === fromCol - 1 && toRow === fromRow) return { col: toCol, row: toRow, side: "colPlus" };
  if (toRow === fromRow + 1 && toCol === fromCol) return { col: fromCol, row: fromRow, side: "rowPlus" };
  if (toRow === fromRow - 1 && toCol === fromCol) return { col: toCol, row: toRow, side: "rowPlus" };
  return null;
}

/** Geometria/profundidade da porta -- literalmente as mesmas funções de
 * parede (a aresta é a MESMA aresta da grade, ver comentário grande no
 * topo do arquivo), só reexportadas com o tipo DoorSide (mais estreito
 * que WallSide) pra quem importar game/door.ts não precisar saber que
 * por baixo é a mesma conta de wall.ts. */
export function doorEdgeFloorPoints(col: number, row: number, side: DoorSide): { a: Point; b: Point } {
  return wallEdgeFloorPoints(col, row, side);
}
export function doorEdgeLengthPx(col: number, row: number, side: DoorSide): number {
  return wallEdgeLengthPx(col, row, side);
}
export function doorWorldAnchor(seg: { col: number; row: number; side: DoorSide }): Point {
  // wallWorldAnchor pede um WallSegmentDef inteiro (com styleId) só por
  // causa do TIPO -- por baixo (ver wall.ts) ela só lê col/row/side,
  // nunca styleId, então um placeholder aqui é seguro (nunca alcança
  // nenhum código que olhe pra ele).
  return wallWorldAnchor({ ...seg, styleId: "" });
}
export function doorDepthForSegment(
  seg: { col: number; row: number; side: DoorSide },
  furnitureDepthForTile: (col: number, row: number) => number
): number {
  // mesmo placeholder de doorWorldAnchor acima -- wallDepthForSegment
  // também só lê col/row/side (ver wall.ts), nunca styleId.
  return wallDepthForSegment({ ...seg, styleId: "" }, furnitureDepthForTile);
}
