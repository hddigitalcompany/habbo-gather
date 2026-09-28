import { tileToWorld } from "./grid";

/**
 * "Áreas" da sala -- zonas NOMEADAS, criadas explicitamente numa lista
 * (ver "Editar espaço" -> aba "Área" em GameRoom.tsx) antes de poder
 * pintar tile nenhum: primeiro cria a área (nome + tipo, vira uma
 * entrada em AreaDef[]), DEPOIS seleciona ela na lista e arrasta os
 * tiles que pertencem a ela (mesma mecânica de pintura tile-a-tile do
 * piso, game/floor.ts -- clique/arraste pinta, clique de novo apaga).
 *
 * IMPORTANTE: tiles vizinhos do MESMO TIPO NÃO se fundem mais sozinhos
 * numa zona (isso foi tentado numa versão anterior e o Douglas corrigiu
 * -- ver histórico) -- um tile só pertence à área que estava
 * SELECIONADA no momento em que foi pintado (AreaTileDef.areaId aponta
 * direto pro id da área, não tem cálculo de adjacência nenhum). Duas
 * áreas do tipo "mesa-privada" podem inclusive ficar coladas lado a lado
 * sem virar uma coisa só.
 *
 * Três tipos (pedido do Douglas: "os nomes renomeie, sala privada /
 * Mesa privada / sala aberta" -- viraram 3 em vez de 2; só
 * "mesa-privada" tem dono, os outros dois só diferem no nome/cor pra
 * organizar o mapa):
 * - "mesa-privada" ("Mesa privada"): tem um botão "Assumir mesa"
 *   (ex-"Tomar posse", renomeado a pedido do Douglas -- ver onClaimArea
 *   em MainScene.ts) que só aparece ao passar o mouse, enquanto NINGUÉM
 *   for dono -- clicar abre uma confirmação "Assumir essa mesa?" (ver
 *   showAreaClaimPrompt), só manda onClaimArea de verdade se
 *   confirmado. Posse PERSISTE no servidor até a área ser apagada (ver
 *   areaOwnerByAreaId em MainScene.ts) -- clicar na PRÓPRIA mesa não
 *   solta mais nada. Clicar na mesa de outra pessoa abre o card dela
 *   (onAreaOwnerClick); o "CEO" (dono da sala, ver isRoomOwner/
 *   setRoomOwner em MainScene.ts) pode "destituir" a mesa de OUTRA
 *   pessoa à força em vez disso (protocolo "force-release-area" em
 *   server/index.js, ver showDestituirPrompt). Áudio/vídeo de quem tá
 *   numa mesa privada fica isolado do resto da sala (só ouve/é ouvido
 *   por quem também tá na MESMA área) -- ver areaZoneAt/checkProximity
 *   em GameRoom.tsx.
 * - "sala-privada" ("Sala privada"): mesma isolação de áudio/vídeo,
 *   sem dono/botão de posse -- pra área de reunião compartilhada que
 *   não pertence a ninguém.
 * - "sala" ("Sala aberta"): mesma isolação de áudio/vídeo também, sem
 *   dono -- mesma mecânica de "sala-privada", só existe como categoria
 *   separada pro Douglas organizar/colorir o mapa diferente (ex:
 *   áreas de passagem/convivência vs. salas de reunião fechadas).
 */
export type AreaType = "mesa-privada" | "sala-privada" | "sala";

// pedido do Douglas: "os nomes renomeie, sala privada / Mesa privada /
// sala aberta" -- 3 tipos na lista agora. "mesa-privada" e "sala"
// mantêm o ID de sempre por baixo (nada salvo/persistido quebra);
// "sala-privada" é um ID novo (nunca existiu antes, sem área antiga
// pra migrar).
export const AREA_TYPES: { id: AreaType; label: string; color: number }[] = [
  { id: "mesa-privada", label: "Mesa privada", color: 0xffb84d },
  { id: "sala-privada", label: "Sala privada", color: 0xb388ff },
  { id: "sala", label: "Sala aberta", color: 0x4da6ff },
];

export function areaTypeMeta(type: AreaType) {
  return AREA_TYPES.find((t) => t.id === type)!;
}

/** Uma área criada na lista (ver comentário grande no topo do arquivo) --
 * `id` gerado na hora de criar (ver createArea em GameRoom.tsx), não
 * muda depois. */
export interface AreaDef {
  id: string;
  name: string;
  type: AreaType;
}

/** Um quadrado da grade pintado, apontando pra área dona dele por ID
 * (não por tipo -- ver comentário grande no topo do arquivo). */
export interface AreaTileDef {
  col: number;
  row: number;
  areaId: string;
}

export function areaWorldPos(t: { col: number; row: number }) {
  return tileToWorld(t.col, t.row);
}

/** Todos os tiles pintados que pertencem a essa área. */
export function tilesForArea(tiles: AreaTileDef[], areaId: string): { col: number; row: number }[] {
  return tiles.filter((t) => t.areaId === areaId).map((t) => ({ col: t.col, row: t.row }));
}

/** Id da área (se houver) dona do tile nessa posição -- usado tanto pra
 * saber se um jogador tá "dentro" de uma área (isolamento de áudio, ver
 * areaZoneAt em MainScene.ts) quanto pra pintura (não empilha dois tiles
 * na mesma posição, ver paintAreaAt). */
export function areaIdAtTile(tiles: AreaTileDef[], col: number, row: number): string | undefined {
  return tiles.find((t) => t.col === col && t.row === row)?.areaId;
}

/** Retângulo (em tiles) que cobre todos os tiles de uma área -- usado só
 * pra desenhar a borda/o hover do nome/botão (ver
 * redrawAreaBorders/updateAreaHoverLabels em MainScene.ts). Numa área com
 * formato irregular isso desenha um contorno um pouco maior que os tiles
 * de verdade -- simplificação aceitável pro uso esperado (mesas/salas
 * retangulares). */
export function areaTileBounds(tiles: { col: number; row: number }[]) {
  const cols = tiles.map((t) => t.col);
  const rows = tiles.map((t) => t.row);
  return {
    minCol: Math.min(...cols),
    maxCol: Math.max(...cols),
    minRow: Math.min(...rows),
    maxRow: Math.max(...rows),
  };
}
