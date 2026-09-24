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
