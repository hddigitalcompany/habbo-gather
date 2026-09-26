// Cadastra um modelo de PISO customizado (Editor de Itens, aba "Criar
// Piso", ver components/ItemEditor.tsx) -- só o dono da sala pode.
// Mesmo esquema de app/api/items/route.ts (móvel), bem mais simples:
// piso não tem direção/footprint/assento/interação.
//
// Dois "kind" (ver supabase/migrations/0016_room_floor_items_pattern.sql
// e FloorCatalogEntry em game/floor.ts): "image" (de sempre -- uma
// imagem PLANA, já subiu pro Storage ANTES dessa chamada, direto do
// navegador, ver handleFloorSubmit em ItemEditor.tsx) ou "pattern"
// (pedido do Douglas: "criamos ali dentro uma forma de preenchimento de
// linhas... nao precise ser imagem mesmo" -- sem arquivo nenhum, só
// largura da ripa + 2 cores, desenhado por código, ver
// createFloorPatternGraphics em game/MainScene.ts).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["porcelanato", "laminado", "natural"];
const ALLOWED_KINDS = ["image", "pattern"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar piso" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const kind = typeof body?.kind === "string" && ALLOWED_KINDS.includes(body.kind) ? body.kind : "image";

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }

  const insert: Record<string, unknown> = { label, category, kind, created_by: callerId };

  if (kind === "pattern") {
    const plankWidthPx = typeof body?.plank_width_px === "number" && Number.isFinite(body.plank_width_px) ? Math.round(body.plank_width_px) : NaN;
    const colorA = typeof body?.color_a === "string" ? body.color_a : "";
    const colorB = typeof body?.color_b === "string" ? body.color_b : "";
    if (!Number.isFinite(plankWidthPx) || plankWidthPx < 4 || plankWidthPx > 200) {
      return NextResponse.json({ error: "largura da ripa precisa ser entre 4 e 200" }, { status: 400 });
    }
    if (!HEX_COLOR_RE.test(colorA) || !HEX_COLOR_RE.test(colorB)) {
      return NextResponse.json({ error: "as duas cores da ripa são obrigatórias" }, { status: 400 });
    }
    insert.plank_width_px = plankWidthPx;
    insert.color_a = colorA;
    insert.color_b = colorB;
  } else {
    const fileUrl = typeof body?.file_url === "string" ? body.file_url : "";
    if (!fileUrl) return NextResponse.json({ error: "imagem é obrigatória" }, { status: 400 });
    insert.file_url = fileUrl;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin.from("room_floor_items").insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
