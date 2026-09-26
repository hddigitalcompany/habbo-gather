// Validação compartilhada de campos de item custom (ver
// app/api/items/route.ts e app/api/items/[id]/route.ts) -- num arquivo
// à parte (não dentro de um dos dois route.ts) porque o App Router do
// Next só aceita um conjunto fixo de exports num arquivo route.ts (os
// métodos HTTP + umas poucas config -- ver dynamic/runtime/etc.), então
// uma função auxiliar exportada DALI quebraria o build.

/** Arredonda e limita o offset (px) ao intervalo -300..300 (mesma faixa
 * da constraint em supabase/migrations/0004_room_items_icon_offset.sql)
 * -- qualquer valor ausente/inválido vira 0 (sem deslocamento). */
export function clampItemOffset(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.round(Math.max(-300, Math.min(300, raw)));
}

/** Mesma ideia de clampItemOffset acima, faixa mais estreita (-100..100,
 * mesma constraint em supabase/migrations/0007_room_items_direction_offsets_seat.sql)
 * -- ajuste de assento é sempre um nudge pequeno, nunca precisa da
 * faixa toda do offset de posição. undefined (em vez de 0) quando
 * ausente/inválido -- diferente de offset de posição, "sem ajuste de
 * assento" precisa ficar null no banco (cai no heurístico de sempre,
 * ver resolveSeatOffset em game/furniture.ts), não virar 0/0 à força. */
export function clampSeatOffset(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.max(-100, Math.min(100, raw)));
}

/** Tamanho de footprint (cols/rows, ver FurnitureModelDef.footprintCols
 * em game/furniture.ts) -- inteiro de 1 a 6 (sem "mobi" real ocupando
 * mais que isso; teto baixo de propósito, evita alguém travar a sala
 * inteira sem querer com um número digitado errado). Ausente/inválido
 * vira 1 (comportamento de sempre, só a âncora). */
export function clampFootprintSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.round(Math.max(1, Math.min(6, raw)));
}

/**
 * Assentos EXTRA de um item (ver FurnitureModelDef.extraSeats em
 * game/furniture.ts, coluna extra_seats em supabase/migrations/
 * 0014_room_items_extra_seats.sql) -- pedido do Douglas: "configurar
 * dois avatares no caso em que tenha mais de um assento" (ex: sofá com
 * 2 lugares). Cada entrada é {dCol, dRow, x, y}: dCol/dRow (tile, OFFSET
 * a partir da âncora, não tile absoluto -- continua valendo se o item
 * for arrastado no editor de espaço) + x/y (px, deslocamento FIXO de
 * onde o boneco aparece sentado ali -- sem heurístico nenhum, diferente
 * do assento da âncora, ver resolveSeatOffset/seatSpotAt). Qualquer
 * entrada fora do formato (falta campo, não é número) é descartada em
 * silêncio, nunca quebra o cadastro por causa desse campo opcional --
 * [] se nada sobrar (ou o corpo não mandou um array).
 */
export function cleanExtraSeats(raw: unknown): { dCol: number; dRow: number; x: number; y: number }[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: { dCol: number; dRow: number; x: number; y: number }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const dColRaw = (entry as Record<string, unknown>).dCol;
    const dRowRaw = (entry as Record<string, unknown>).dRow;
    const xRaw = (entry as Record<string, unknown>).x;
    const yRaw = (entry as Record<string, unknown>).y;
    if (
      typeof dColRaw !== "number" ||
      typeof dRowRaw !== "number" ||
      typeof xRaw !== "number" ||
      typeof yRaw !== "number" ||
      !Number.isFinite(dColRaw) ||
      !Number.isFinite(dRowRaw) ||
      !Number.isFinite(xRaw) ||
      !Number.isFinite(yRaw)
    ) {
      continue;
    }
    cleaned.push({
      dCol: Math.round(Math.max(-6, Math.min(6, dColRaw))),
      dRow: Math.round(Math.max(-6, Math.min(6, dRowRaw))),
      x: clampItemOffset(xRaw),
      y: clampItemOffset(yRaw),
    });
  }
  return cleaned;
}

/** Direções que aceitam override em direction_offsets (ver
 * supabase/migrations/0007_room_items_direction_offsets_seat.sql) --
 * "down" fica de fora de propósito (usa offset_x/offset_y direto, ver
 * comentário na migration). */
const OVERRIDABLE_DIRECTIONS = ["left", "right", "up"] as const;

/** Valida/limpa o formato de direction_offsets vindo do corpo da
 * requisição -- só aceita left/right/up, cada um com x/y numéricos
 * (limitados como um offset comum, ver clampItemOffset), qualquer outra
 * chave/formato é ignorado em silêncio (nunca quebra o cadastro por
 * causa desse campo opcional). null explícito = limpa os overrides
 * (volta a reaproveitar offset_x/offset_y nas 3 direções). */
export function cleanDirectionOffsets(raw: unknown): Record<string, { x: number; y: number }> | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return null;
  const cleaned: Record<string, { x: number; y: number }> = {};
  for (const dir of OVERRIDABLE_DIRECTIONS) {
    const entry = (raw as Record<string, unknown>)[dir];
    if (!entry || typeof entry !== "object") continue;
    const x = (entry as Record<string, unknown>).x;
    const y = (entry as Record<string, unknown>).y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    cleaned[dir] = { x: clampItemOffset(x), y: clampItemOffset(y) };
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/** Mesma ideia de cleanDirectionOffsets acima, só que pro ASSENTO (ver
 * seat_direction_offsets em supabase/migrations/
 * 0008_room_items_seat_direction_offsets.sql e o comentário grande em
 * FurnitureModelDef.seatDirectionOffsets, game/furniture.ts) -- também
 * só left/right/up, mas usa a faixa mais estreita do assento
 * (clampSeatOffset, -100..100) em vez da faixa de posição no tile. */
export function cleanSeatDirectionOffsets(raw: unknown): Record<string, { x: number; y: number }> | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return null;
  const cleaned: Record<string, { x: number; y: number }> = {};
  for (const dir of OVERRIDABLE_DIRECTIONS) {
    const entry = (raw as Record<string, unknown>)[dir];
    if (!entry || typeof entry !== "object") continue;
    const x = clampSeatOffset((entry as Record<string, unknown>).x);
    const y = clampSeatOffset((entry as Record<string, unknown>).y);
    if (x === undefined || y === undefined) continue;
    cleaned[dir] = { x, y };
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}
