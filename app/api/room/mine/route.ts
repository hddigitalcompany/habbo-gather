// GET /api/room/mine -- a sala DE VERDADE do usuário logado (ver
// comentário grande em supabase/migrations/0032_rooms.sql), se ele já
// tiver uma. Usado pelo Lobby pra decidir entre "Entrar na minha sala"
// (já tem, ver room.room_slug) e "Criar minha sala" (ainda não tem,
// mostra o catálogo de GET /api/room/templates). Pro Douglas (dono da
// plataforma) essa rota devolvia SÓ a própria "Sala Principal" -- ele é
// owner_user_id dela desde o bootstrap em
// supabase/migrations/0033_room_scoped_membership.sql.
//
// 29/set (10): pedido do Douglas "adicione mais um opcao: Criar
// espaço +" -- time (owner/member) agora também pode criar a PRÓPRIA
// sala/empresa, além de continuar dono de Sala Principal/Mapa Modelo
// (ver ROOM_SLUGS/openCreateRoomFlow em components/Lobby.tsx). Isso
// quebraria o `.maybeSingle()` de antes assim que alguém do time
// tivesse DUAS linhas em rooms (Sala Principal + a nova) -- ele erra
// com "mais de uma linha" em vez de escolher uma. RESERVED_SLUGS
// (mesma lista de app/api/room/visit/route.ts) marca quais são as
// salas FIXAS do time, não uma empresa de verdade -- busca TODAS as
// salas da pessoa e prefere a que NÃO é reservada (a empresa de
// verdade dela, se existir), só caindo pra uma reservada (Sala
// Principal) se for só isso que ela tiver -- mesmo comportamento de
// sempre pra quem só tem uma sala (a esmagadora maioria).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const RESERVED_SLUGS = new Set(["mapa-publicado", "mapa-modelo"]);

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
    .not("room_slug", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rooms = data ?? [];
  const mine = rooms.find((r) => !RESERVED_SLUGS.has(r.room_slug)) ?? rooms[0] ?? null;

  return NextResponse.json({ room: mine });
}
