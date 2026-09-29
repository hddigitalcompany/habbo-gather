// GET /api/room/mine -- a sala DE VERDADE do usuário logado (ver
// comentário grande em supabase/migrations/0032_rooms.sql), se ele já
// tiver uma. Usado pelo Lobby pra decidir entre "Entrar na minha sala"
// (já tem, ver room.room_slug) e "Criar minha sala" (ainda não tem,
// mostra o catálogo de GET /api/room/templates). Pro Douglas (dono da
// plataforma) essa rota devolve a própria "Sala Principal" -- ele é
// owner_user_id dela desde o bootstrap em
// supabase/migrations/0033_room_scoped_membership.sql, então ela já É
// "a sala dele" nesse sentido, sem precisar de nenhuma linha especial
// a mais.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ room: null });

  const { data, error } = await admin
    .from("rooms")
    .select("id, name, room_slug")
    .eq("owner_user_id", userId)
    .eq("is_template", false)
    .not("room_slug", "is", null)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ room: data ?? null });
}
