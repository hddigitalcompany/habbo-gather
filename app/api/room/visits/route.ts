// GET /api/room/visits -- lista as salas de OUTRAS pessoas que o
// usuário logado já visitou (ver POST /api/room/visit), mais recente
// primeiro, pra virar os atalhos do dropdown "Espaços visitados" no
// Lobby. Junta com `rooms` pra pegar o nome/slug ATUAIS (se o dono
// renomear a sala depois, o atalho já mostra o nome novo -- não
// guarda cópia nenhuma) e filtra fora qualquer sala que tenha sido
// apagada nesse meio tempo (inner join via !inner).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ visits: [] });

  const { data, error } = await admin
    .from("room_visits")
    .select("visited_at, rooms!inner(id, name, room_slug)")
    .eq("user_id", userId)
    .order("visited_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const visits = (data ?? [])
    .map((row) => {
      const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
      if (!room) return null;
      return { id: room.id as string, name: room.name as string, room_slug: room.room_slug as string };
    })
    .filter((r): r is { id: string; name: string; room_slug: string } => r !== null);

  return NextResponse.json({ visits });
}
