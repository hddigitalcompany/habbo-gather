import { FurnitureDef } from "./furniture";

/**
 * Gera o texto TypeScript de um item pra colar dentro do array
 * ROOM_FURNITURE (furniture.ts) -- é o "modo dev" do editor de espaço
 * (ver botão "Editar espaço" em GameRoom.tsx): o editor só posiciona
 * visualmente e mostra o código pronto, não salva nada sozinho (sem
 * banco de dados por enquanto).
 *
 * `index` é usado só pra dar um id previsível/legível
 * ("poltrona-novo-1", "vidro-novo-2", ...) -- ajustar na mão depois de
 * colar, se quiser um nome melhor.
 */
function formatFurnitureDef(f: FurnitureDef, index: number): string {
  const lines = [
    "  {",
    `    id: "${f.type}-novo-${index + 1}",`,
    `    type: "${f.type}",`,
    `    col: ${f.col},`,
    `    row: ${f.row},`,
    `    facing: "${f.facing}",`,
  ];
  if (f.seatOffsetY !== undefined) lines.push(`    seatOffsetY: ${f.seatOffsetY},`);
  if (f.seatOffsetX !== undefined) lines.push(`    seatOffsetX: ${f.seatOffsetX},`);
  if (f.baseOffsetY !== undefined) lines.push(`    baseOffsetY: ${f.baseOffsetY},`);
  lines.push("  },");
  return lines.join("\n");
}

/**
 * Gera o bloco de código de TODOS os itens colocados no editor, pronto
 * pra colar dentro de `ROOM_FURNITURE` em game/furniture.ts (junto com
 * os itens que já existem lá).
 */
export function generateFurnitureCode(items: FurnitureDef[]): string {
  if (items.length === 0) {
    return "// nenhum item colocado ainda -- clique num item da paleta e depois num quadrado da sala";
  }
  return items.map((f, i) => formatFurnitureDef(f, i)).join("\n");
}
