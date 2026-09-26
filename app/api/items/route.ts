// Cadastra um item de móvel CUSTOM (Editor de Itens, ver
// components/ItemEditor.tsx) -- só o dono da sala pode. A IMAGEM em si
// já foi enviada direto do navegador pro Supabase Storage (bucket
// "room-items", ver supabase/migrations/0002_room_items.sql) ANTES
// dessa chamada -- aqui só grava os metadados (nome/categoria/URLs)
// depois de conferir de novo que quem pediu é owner (defesa em
// profundidade, mesmo padrão de app/api/room/members).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";
import { clampItemOffset, clampSeatOffset, cleanDirectionOffsets, cleanSeatDirectionOffsets } from "@/lib/supabase/itemFields";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["poltrona", "divisoria", "sofa", "mesa", "planta", "computador"];
const ALLOWED_DIRECTIONS = ["down", "left", "right", "up"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar item" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const art = body?.art && typeof body.art === "object" ? (body.art as Record<string, unknown>) : null;
  // tamanho ajustado à mão no preview do Editor de Itens (ver
  // ItemEditor.tsx/displayWidth e a coluna display_width em
  // supabase/migrations/0003_room_items_display_width.sql) -- opcional
  // (undefined/inválido cai no fallback por categoria, ver
  // CUSTOM_ITEM_TARGET_WIDTH/addFurnitureSprite em MainScene.ts), por
  // isso não entra na validação obrigatória acima. Mesma faixa 20-600
  // da constraint no banco.
  const rawDisplayWidth = body?.display_width;
  const displayWidth =
    typeof rawDisplayWidth === "number" && Number.isFinite(rawDisplayWidth) && rawDisplayWidth >= 20 && rawDisplayWidth <= 600
      ? Math.round(rawDisplayWidth)
      : null;
  // ícone próprio do catálogo (pedido do Douglas: "escolher o favicon
  // que aparece no catálogo") + posição dentro do tile (arrastado no
  // preview do Editor de Itens) -- ver icon_url/offset_x/offset_y em
  // supabase/migrations/0004_room_items_icon_offset.sql. Os dois são
  // opcionais: sem ícone cai no fallback de sempre (foto de frente, ver
  // catalogEntryIconFile em GameRoom.tsx), offset ausente/inválido vira
  // 0 (sem deslocamento, comportamento de sempre) -- mesma faixa -300..300
  // da constraint no banco.
  const iconUrl = typeof body?.icon_url === "string" && body.icon_url ? body.icon_url : null;
  const offsetX = clampItemOffset(body?.offset_x);
  const offsetY = clampItemOffset(body?.offset_y);
  // ajuste por direção (pedido do Douglas: "editar todos os lados do
  // mobi") + interação/assento (pedido: "se vai ter interação... e a
  // posição sentado") -- ver supabase/migrations/
  // 0007_room_items_direction_offsets_seat.sql e o comentário de cada
  // helper em lib/supabase/itemFields.ts.
  const directionOffsets = cleanDirectionOffsets(body?.direction_offsets);
  const sittable = typeof body?.sittable === "boolean" ? body.sittable : null;
  const seatOffsetX = clampSeatOffset(body?.seat_offset_x) ?? null;
  const seatOffsetY = clampSeatOffset(body?.seat_offset_y) ?? null;
  // ajuste do assento POR DIREÇÃO (ver supabase/migrations/
  // 0011_room_items_seat_direction_offsets.sql) -- mesmo esquema de
  // direction_offsets acima, só que pro assento.
  const seatDirectionOffsets = cleanSeatDirectionOffsets(body?.seat_direction_offsets);

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }
  if (!art || typeof art.down !== "string" || !art.down) {
    return NextResponse.json({ error: "imagem de frente é obrigatória" }, { status: 400 });
  }
  const cleanArt: Record<string, string> = {};
  for (const dir of ALLOWED_DIRECTIONS) {
    const value = art[dir];
    if (typeof value === "string" && value) cleanArt[dir] = value;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("room_items")
    .insert({
      label,
      category,
      art: cleanArt,
      display_width: displayWidth,
      icon_url: iconUrl,
      offset_x: offsetX,
      offset_y: offsetY,
      direction_offsets: directionOffsets,
      sittable,
      seat_offset_x: seatOffsetX,
      seat_offset_y: seatOffsetY,
      seat_direction_offsets: seatDirectionOffsets,
      created_by: callerId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
