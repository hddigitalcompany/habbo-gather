import { FloorTileDef } from "./floor";

/**
 * Gera o texto TypeScript de UM tile pra colar dentro do array
 * ROOM_FLOOR (floor.ts) -- mesma ideia do furnitureCodegen.ts pros
 * móveis: o editor só posiciona visualmente e mostra o código pronto,
 * não salva nada sozinho.
 */
function formatFloorDef(f: FloorTileDef): string {
  return `  { col: ${f.col}, row: ${f.row}, styleId: "${f.styleId}" },`;
}

/**
 * Gera o bloco de código de TODOS os tiles pintados no editor, pronto
 * pra colar dentro de `ROOM_FLOOR` em game/floor.ts (junto com os tiles
 * que já existem lá, se houver).
 */
export function generateFloorCode(items: FloorTileDef[]): string {
  if (items.length === 0) {
    return "// nenhum piso pintado ainda -- escolha um modelo na paleta e clique (ou arraste) nos quadrados da sala";
  }
  return items.map(formatFloorDef).join("\n");
}
