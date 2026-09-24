import { tileToWorld } from "./grid";

/**
 * "Áreas" da sala -- zonas pintadas no editor de espaço (aba "Área", ver
 * selectAreaTool em MainScene.ts / EditPanel em GameRoom.tsx), MESMA
 * mecânica de pintura tile-a-tile do piso (game/floor.ts): clique/arraste
 * pinta, clique de novo apaga. A diferença é que uma área não é só
 * decoração -- ela muda REGRA (quem ouve áudio de quem, quem é "dono" de
 * uma mesa) pros tiles que cobre.
 *
 * Dois tipos, exatamente como o Douglas pediu:
 * - "mesa-privada": um tile (ou grupo de tiles vizinhos, ver
 *   computeAreaZones) onde, se tiver uma cadeira (móvel sentável, ver
 *   game/furniture.ts) dentro, quem SENTA nela "toma posse" -- vira dono
 *   enquanto ficar sentado (levanta = solta, igual ao Gather). Áudio/
 *   vídeo de quem tá numa mesa privada fica isolado do resto da sala (só
 *   ouve/é ouvido por quem também tá na MESMA mesa) -- ver
 *   areaZoneAt()/checkProximity em GameRoom.tsx.
 * - "sala": zona de áudio/vídeo isolado igual, só que SEM dono/nome --
 *   pra área de reunião compartilhada que não pertence a ninguém.
 *
 * Cada TILE pintado guarda só col/row/type (ver AreaTileDef, mesmo
 * formato do FloorTileDef) -- tiles vizinhos (mesmo lado, não diagonal)
 * do MESMO tipo formam uma "zona" (AreaZone), calculada ao vivo por
 * computeAreaZones toda vez que a área muda (não é salva por zona, só os
 * tiles crus são salvos -- ver GET/POST /room/areas em server/index.js).
 * Isso deixa o Douglas pintar uma mesa de 2x1 ou uma sala de reunião de
 * 3x3 sem precisar "nomear" nada -- a forma pintada já define a zona.
 */
export type AreaType = "mesa-privada" | "sala";

export const AREA_TYPES: { id: AreaType; label: string; color: number }[] = [
  { id: "mesa-privada", label: "Mesa privada", color: 0xffb84d },
  { id: "sala", label: "Sala", color: 0x4da6ff },
];

export function areaTypeMeta(type: AreaType) {
  return AREA_TYPES.find((t) => t.id === type)!;
}

/** Um quadrado da grade pintado com um tipo de área -- posição em TILE (col/row), igual ao piso (game/floor.ts) e aos móveis (game/furniture.ts). */
export interface AreaTileDef {
  col: number;
  row: number;
  type: AreaType;
}

export function areaWorldPos(a: AreaTileDef) {
  return tileToWorld(a.col, a.row);
}

/** Grupo de tiles vizinhos (4 direções, sem diagonal) do MESMO tipo -- ver comentário grande no topo do arquivo. `id` é estável enquanto a FORMA da zona não mudar (derivado do tile mais no canto superior-esquerdo dela), recalculado toda vez que a área muda (ver computeAreaZones). */
export interface AreaZone {
  id: string;
  type: AreaType;
  tiles: { col: number; row: number }[];
}

/** Agrupa os tiles pintados em zonas (componentes conectados por tipo) -- flood fill simples, a grade é pequena (12x7) então não precisa de nada mais esperto. */
export function computeAreaZones(tiles: AreaTileDef[]): AreaZone[] {
  const byKey = new Map<string, AreaTileDef>();
  for (const t of tiles) byKey.set(`${t.col},${t.row}`, t);

  const visited = new Set<string>();
  const zones: AreaZone[] = [];

  for (const start of tiles) {
    const startKey = `${start.col},${start.row}`;
    if (visited.has(startKey)) continue;

    const zoneTiles: { col: number; row: number }[] = [];
    const stack: AreaTileDef[] = [start];
    visited.add(startKey);

    while (stack.length > 0) {
      const cur = stack.pop()!;
      zoneTiles.push({ col: cur.col, row: cur.row });
      const neighbors: [number, number][] = [
        [cur.col + 1, cur.row],
        [cur.col - 1, cur.row],
        [cur.col, cur.row + 1],
        [cur.col, cur.row - 1],
      ];
      for (const [ncol, nrow] of neighbors) {
        const nkey = `${ncol},${nrow}`;
        const neighbor = byKey.get(nkey);
        if (neighbor && neighbor.type === start.type && !visited.has(nkey)) {
          visited.add(nkey);
          stack.push(neighbor);
        }
      }
    }

    zoneTiles.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    const anchor = zoneTiles[0];
    zones.push({ id: `${start.type}-${anchor.col}-${anchor.row}`, type: start.type, tiles: zoneTiles });
  }

  return zones;
}

/** Zona (se houver) que cobre esse tile -- usado tanto pra saber se um jogador tá "dentro" de uma área (isolamento de áudio, ver areaZoneAt em MainScene.ts) quanto pra achar a zona de uma cadeira (posse de mesa privada, ver refreshAreaOwnership). */
export function zoneAtTile(zones: AreaZone[], col: number, row: number): AreaZone | undefined {
  return zones.find((z) => z.tiles.some((t) => t.col === col && t.row === row));
}

/** Retângulo (em tiles) que cobre TODOS os tiles da zona -- usado só pra desenhar a borda/label (ver redrawAreaZoneBorders/updateAreaHoverLabels em MainScene.ts). Numa zona com formato irregular (não um retângulo cheio) isso desenha um contorno um pouco maior que os tiles de verdade -- simplificação aceitável pro uso esperado (mesas/salas retangulares). */
export function zoneBounds(zone: AreaZone) {
  const cols = zone.tiles.map((t) => t.col);
  const rows = zone.tiles.map((t) => t.row);
  return {
    minCol: Math.min(...cols),
    maxCol: Math.max(...cols),
    minRow: Math.min(...rows),
    maxRow: Math.max(...rows),
  };
}
