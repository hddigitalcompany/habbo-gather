// POST /api/account/featured-company -- qual empresa (dona ou membro)
// EU escolhi destacar no meu próprio perfil (ver
// profiles.featured_company_room_id, migration
// 0044_company_members_and_profile_card.sql, e ProfileViewCard.tsx --
// pedido do Douglas 30/set (8): "em edicao de perfil, ele vai escolher
// qual empresa mostrar"). Rota própria (em vez do cliente escrever
// direto em public.profiles pelo browser client, como o resto do
// perfil já faz -- ver saveProfileEdit em ProfileViewCard.tsx) porque
// esse campo precisa de VALIDAÇÃO: só aceita um roomId de uma empresa
// que a pessoa realmente é dona ou membro AGORA (nunca confia no que
// o cliente mandou -- RLS de public.company_members nem deixa o
// browser client ler essa tabela pra conferir sozinho, então essa
// validação só dá pra fazer aqui, com a service role).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";
import { getUserRelationToRoom } from "@/lib/supabase/companyMembership";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const rawRoomId = body?.roomId;
  // null/"" = "não mostrar nenhuma" (limpa a escolha).
  const roomId = typeof rawRoomId === "string" && rawRoomId.trim() ? rawRoomId.trim() : null;

  if (roomId) {
    const relation = await getUserRelationToRoom(admin, userId, roomId);
    if (!relation) {
      return NextResponse.json({ error: "você não é dona nem membro dessa empresa" }, { status: 403 });
    }
  }

  const { error } = await admin.from("profiles").update({ featured_company_room_id: roomId }).eq("id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, roomId });
}
