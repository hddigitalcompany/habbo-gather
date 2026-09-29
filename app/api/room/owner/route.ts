// GET /api/room/owner?room=<slug> -- "eu sou dono DESSA sala
// específica?" (ver public.rooms.owner_user_id), usado por
// components/GameRoom.tsx (isCurrentRoomOwner) pra decidir quem pode
// editar o espaço (floor/walls/furniture) e "destituir" posse de mesa
// -- ver canEditRoom/scene.setRoomOwner lá.
//
// CORRIGIU um bug real de autorização (29/set, achado pelo Douglas:
// "o cliente, tem acesso ao catalogo e a membros"): até aqui,
// GameRoom.tsx usava o mesmo roomRole de GET /api/room/members (papel
// GLOBAL na Sala Principal, tabela room_members -- anterior ao
// multi-sala, ver supabase/migrations/0001_accounts.sql) pra decidir
// "canEditRoom" em QUALQUER sala -- então o dono da Sala Principal (ou
// quem quer que getRole achasse "owner") aparecia como dono em toda
// sala que abrisse, inclusive a de um cliente. Essa rota olha pra sala
// CERTA (rooms.owner_user_id === quem pediu, pelo room_slug de
// verdade) -- funciona igual pra Sala Principal (owner_user_id dela já
// é o Douglas, ver bootstrap em 0033_room_scoped_membership.sql) e pra
// sala própria de qualquer cliente (ver POST /api/room/create-from-template).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ isOwner: false });

  const roomSlug = req.nextUrl.searchParams.get("room")?.trim();
  if (!roomSlug) return NextResponse.json({ isOwner: false });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ isOwner: false });

  const { data } = await admin
    .from("rooms")
    .select("owner_user_id")
    .eq("room_slug", roomSlug)
    .eq("is_template", false)
    .maybeSingle();

  return NextResponse.json({ isOwner: !!data && data.owner_user_id === userId });
}
