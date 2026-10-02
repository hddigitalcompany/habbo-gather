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

// 2/out, pedido do Douglas ("liga um no outro", depois de reclamar
// "demora demais pra aparecer o seguidor e subir contato pra puxar na
// conversa") -- essa rota roda na Vercel (serverless) e NUNCA viu o
// processo do WebSocket (server/index.js, no Render), então gravar um
// follow/unfollow aqui não tinha como avisar ninguém em tempo real --
// cada lado só descobria a mudança na próxima vez que trocasse de aba
// (ver reloadFriends/FriendsPanel.tsx e newConvFriends/
// usePlatformChat.ts). Chama POST /internal/friends-changed lá (ver
// handlePostFriendsChanged/server/index.js) depois de gravar com
// sucesso, autenticado com o MESMO SUPABASE_SERVICE_ROLE_KEY que essa
// rota já usa pra falar com o Supabase como admin (reaproveitado como
// segredo compartilhado server-a-servidor, em vez de inventar uma
// variável de ambiente nova pra configurar nos dois lugares à parte).
// Melhor esforço só -- se essa chamada falhar (Render fora do ar,
// rede), o following/mutual que essa rota já devolve pro cliente que
// chamou continua certo; só o AVISO em tempo real pro OUTRO lado que
// se perde, ele ainda pega a mudança do jeito antigo (trocar de aba).
const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE = `${
  REALTIME_HOST.startsWith("127.0.0.1") || REALTIME_HOST.startsWith("localhost") ? "http" : "https"
}://${REALTIME_HOST}`;

async function notifyFriendsChanged(userIds: string[]) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return;
  try {
    await fetch(`${REALTIME_HTTP_BASE}/internal/friends-changed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ userIds }),
    });
  } catch {
    // ver comentário grande acima -- melhor esforço, nunca derruba a
    // resposta dessa rota.
  }
}

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

  await notifyFriendsChanged([userId, targetUserId]);

  return NextResponse.json({ following, mutual });
}
