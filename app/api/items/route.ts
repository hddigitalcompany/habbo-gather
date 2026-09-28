// Cadastra um item de móvel CUSTOM (Editor de Itens, ver
// components/ItemEditor.tsx) -- só o admin da plataforma pode. A IMAGEM em si
// já foi enviada direto do navegador pro Supabase Storage (bucket
// "room-items", ver supabase/migrations/0002_room_items.sql) ANTES
// dessa chamada -- aqui só grava os metadados (nome/categoria/URLs)
// depois de conferir de novo que quem pediu é owner (defesa em
// profundidade, mesmo padrão de app/api/room/members).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";
import {
  clampFootprintSize,
  clampItemOffset,
  clampSeatOffset,
  cleanDirectionDisplayWidth,
  cleanDirectionOffsets,
  cleanExtraSeats,
  cleanFootprintByDirection,
  cleanSeatDirectionOffsets,
} from "@/lib/supabase/itemFields";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["poltrona", "divisoria", "sofa", "mesa", "planta", "computador"];
// "cornerTop"/"cornerBottom" (pedido do Douglas: "nas paredes adicione
// mais duas posicoes, quina de cima, quina de baixo") só existem de
// verdade em item de parede (categoria "divisoria", ver
// WALL_DIRECTION_FIELDS em ItemEditor.tsx) -- ficam aqui na lista GERAL
// (valendo pra qualquer categoria) pelo mesmo motivo de down/left/right/up
// sempre terem valido pra tudo: mais simples que bifurcar a validação por
// categoria, e um mobi comum nunca vai ter arquivo de verdade mandado
// pra essas 2 chaves (o formulário só mostra esses campos em "Criar
// Parede").
const ALLOWED_DIRECTIONS = ["down", "left", "right", "up", "cornerTop", "cornerBottom"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode cadastrar item" }, { status: 403 });
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
  // isso não entra na validação obrigatória acima. Mesma faixa 20-1200
  // da constraint no banco (teto subido de 600 pra 1200 em
  // supabase/migrations/0020_room_items_display_width_max.sql, pedido
  // do Douglas trabalhando nas paredes -- ver DISPLAY_WIDTH_MAX em
  // ItemEditor.tsx).
  const rawDisplayWidth = body?.display_width;
  const displayWidth =
    typeof rawDisplayWidth === "number" && Number.isFinite(rawDisplayWidth) && rawDisplayWidth >= 20 && rawDisplayWidth <= 1200
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
  // tamanho POR DIREÇÃO (pedido do Douglas: "se eu mudar de um ele muda
  // de todas as vistas? nao tem como isolar?") -- ver
  // supabase/migrations/0021_room_items_direction_display_width.sql e o
  // comentário grande em FurnitureModelDef.directionDisplayWidth,
  // game/furniture.ts. Mesmo esquema de direction_offsets acima, só que
  // pro tamanho (displayWidth) em vez da posição.
  const directionDisplayWidth = cleanDirectionDisplayWidth(body?.direction_display_width);
  const sittable = typeof body?.sittable === "boolean" ? body.sittable : null;
  const seatOffsetX = clampSeatOffset(body?.seat_offset_x) ?? null;
  const seatOffsetY = clampSeatOffset(body?.seat_offset_y) ?? null;
  // ajuste do assento POR DIREÇÃO (ver supabase/migrations/
  // 0011_room_items_seat_direction_offsets.sql) -- mesmo esquema de
  // direction_offsets acima, só que pro assento.
  const seatDirectionOffsets = cleanSeatDirectionOffsets(body?.seat_direction_offsets);
  // tamanho do footprint (pedido do Douglas: "tenho mobis que ocupam
  // mais tiles doq um ou dois, entao preciso selecionar pra que nao se
  // suba em um item") -- ver supabase/migrations/0013_room_items_footprint.sql
  // e o comentário grande em FurnitureModelDef.footprintCols,
  // game/furniture.ts. 1/1 (padrão) = comportamento de sempre.
  const footprintCols = clampFootprintSize(body?.footprint_cols);
  const footprintRows = clampFootprintSize(body?.footprint_rows);
  // footprint desenhado à mão, por direção (pedido do Douglas: "quero
  // selecionar os tiles que ele ocupa, CLICANDO... pra CADA POSICAO,
  // pois o movel gira e muda o bloqueio pela perspectiva") -- ver
  // supabase/migrations/0023_room_items_footprint_by_direction.sql e o
  // comentário grande em cleanFootprintByDirection, lib/supabase/
  // itemFields.ts. null (padrão) = nenhuma direção customizada ainda,
  // cai no retângulo footprintCols x footprintRows acima.
  const footprintByDirection = cleanFootprintByDirection(body?.footprint_by_direction);
  // "Sobrepor" (pedido do Douglas: notebook em cima da mesa, sem travar
  // a posição de nenhum dos dois) -- ver supabase/migrations/
  // 0022_room_items_stack.sql e o comentário grande em
  // FurnitureModelDef.stackable/stackSurfaceOffsetY, game/furniture.ts.
  // stackable: falso (padrão) = tile ocupado bloqueia igual sempre
  // bloqueou. stackSurfaceOffsetY: mesma faixa de offset comum
  // (clampItemOffset), 0 = sem superfície configurada.
  const stackable = typeof body?.stackable === "boolean" ? body.stackable : false;
  const stackSurfaceOffsetY = clampItemOffset(body?.stack_surface_offset_y);
  // assentos EXTRA (pedido do Douglas: "configurar dois avatares no
  // caso em que tenha mais de um assento") -- ver supabase/migrations/
  // 0014_room_items_extra_seats.sql e o comentário grande em
  // cleanExtraSeats, lib/supabase/itemFields.ts. [] (padrão) = só a
  // âncora, comportamento de sempre.
  const extraSeats = cleanExtraSeats(body?.extra_seats);

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
      direction_display_width: directionDisplayWidth,
      sittable,
      seat_offset_x: seatOffsetX,
      seat_offset_y: seatOffsetY,
      seat_direction_offsets: seatDirectionOffsets,
      footprint_cols: footprintCols,
      footprint_rows: footprintRows,
      footprint_by_direction: footprintByDirection,
      stackable,
      stack_surface_offset_y: stackSurfaceOffsetY,
      extra_seats: extraSeats,
      created_by: callerId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
