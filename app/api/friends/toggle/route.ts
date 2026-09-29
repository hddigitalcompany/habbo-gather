// POST /api/friends/toggle -- segue OU deixa de seguir alguém (botão
// único, alterna: já segue -> deixa de seguir; não segue -> passa a
// seguir). Ver public.followers (0039_followers.sql) e o comentário
// grande lá sobre "amigo" ser CALCULADO (mútuo), não um estado
// próprio. Corpo: { targetUserId }. Devolve o novo estado pro cliente
// atualizar o botão na hora (components/FriendsPanel.tsx), sem
// precisar recarregar a lista inteira.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const targetUserId = typeof body?.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!targetUserId || targetUserId === userId) {
    return NextResponse.json({ error: "targetUserId inválido" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const existing = await admin
    .from("followers")
    .select("follower_id")
    .eq("follower_id", userId)
    .eq("followed_id", targetUserId)
    .maybeSingle();

  let following: boolean;
  if (existing.data) {
    const { error } = await admin
      .from("followers")
      .delete()
      .eq("follower_id", userId)
      .eq("followed_id", targetUserId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    following = false;
  } else {
    const { error } = await admin.from("followers").insert({ follower_id: userId, followed_id: targetUserId });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    following = true;
  }

  // "mútuo" (viraram amigos, ver comentário grande em 0039_followers.sql)
  // só é possível ter acabado de VIRAR true agora se `following` ficou
  // true nessa mesma chamada -- deixar de seguir sempre desfaz o mútuo.
  const back = following
    ? await admin
        .from("followers")
        .select("follower_id")
        .eq("follower_id", targetUserId)
        .eq("followed_id", userId)
        .maybeSingle()
    : { data: null };
  const mutual = following && !!back.data;

  return NextResponse.json({ following, mutual });
}
