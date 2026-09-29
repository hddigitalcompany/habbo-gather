// GET /api/room/templates -- catálogo de modelos publicados (ver
// comentário grande em supabase/migrations/0032_rooms.sql:
// is_template=true, template_status='published') pra tela de "criar
// minha sala" do cliente escolher um (ver POST
// /api/room/create-from-template). Público de propósito -- só lista
// nome/id/slug, nada sensível, e o cliente precisa ver isso ANTES de
// logar/criar conta pra decidir se vale a pena (mesmo espírito de uma
// vitrine).
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ templates: [] });

  const { data, error } = await admin
    .from("rooms")
    .select("id, name, room_slug")
    .eq("is_template", true)
    .eq("template_status", "published")
    .not("room_slug", "is", null)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ templates: data ?? [] });
}
