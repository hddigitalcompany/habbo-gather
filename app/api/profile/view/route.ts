// GET /api/profile/view?userId=X -- perfil PÚBLICO de uma conta (nome/
// status/instagram/bio/foto, ver public.profiles/0001_accounts.sql),
// pra abrir o card de perfil ao clicar em alguém no painel de Amigos
// (pedido do Douglas, 29/set: "quero clicar, e abrir o perfil da
// pessoa" -- ver components/ProfileViewCard.tsx). DIFERENTE do
// ProfileCard de dentro da sala (components/GameRoom.tsx) -- aquele é
// só pra quem tá CONECTADO na sala agora (avatar/customização ao
// vivo via WebSocket); esse aqui funciona pra qualquer conta, online
// ou não, de dentro OU de fora da sala, porque lê direto de
// public.profiles.
//
// Também devolve following/mutual (mesmo cálculo de /api/friends/*)
// pra já desenhar os botões Seguir/Conversar sem precisar de uma
// segunda chamada.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const targetUserId = req.nextUrl.searchParams.get("userId")?.trim();
  if (!targetUserId) return NextResponse.json({ error: "userId é obrigatório" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: profile, error } = await admin
    .from("profiles")
    .select("id, name, status, instagram, bio, photo_url")
    .eq("id", targetUserId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: "perfil não encontrado" }, { status: 404 });

  let following = false;
  let mutual = false;
  if (targetUserId !== userId) {
    const [a, b] = await Promise.all([
      admin.from("followers").select("follower_id").eq("follower_id", userId).eq("followed_id", targetUserId).maybeSingle(),
      admin.from("followers").select("follower_id").eq("follower_id", targetUserId).eq("followed_id", userId).maybeSingle(),
    ]);
    following = !!a.data;
    mutual = !!a.data && !!b.data;
  }

  return NextResponse.json({
    profile: {
      userId: profile.id as string,
      name: (profile.name as string) || "",
      status: (profile.status as string) || "",
      instagram: (profile.instagram as string) || "",
      bio: (profile.bio as string) || "",
      photoUrl: (profile.photo_url as string) || "",
    },
    following,
    mutual,
    isSelf: targetUserId === userId,
  });
}
