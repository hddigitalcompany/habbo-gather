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
// segunda chamada, e followerCount/followingCount (pedido do Douglas,
// 30/set: "perfil de usuario publico, quero seguidores e seguindo") --
// as LISTAS de quem segue/é seguido vêm de uma rota à parte (GET
// /api/profile/followers), só quando a pessoa clica pra abrir (ver
// components/ProfileViewCard.tsx), pra não puxar todo mundo numa
// visita comum ao perfil.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";
import { getUserRelationToRoom } from "@/lib/supabase/companyMembership";

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
    .select("id, name, status, instagram, bio, photo_url, featured_company_room_id")
    .eq("id", targetUserId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: "perfil não encontrado" }, { status: 404 });

  let following = false;
  let mutual = false;
  const followCountsPromise = Promise.all([
    admin.from("followers").select("follower_id", { count: "exact", head: true }).eq("followed_id", targetUserId),
    admin.from("followers").select("followed_id", { count: "exact", head: true }).eq("follower_id", targetUserId),
  ]);
  if (targetUserId !== userId) {
    const [a, b] = await Promise.all([
      admin.from("followers").select("follower_id").eq("follower_id", userId).eq("followed_id", targetUserId).maybeSingle(),
      admin.from("followers").select("follower_id").eq("follower_id", targetUserId).eq("followed_id", userId).maybeSingle(),
    ]);
    following = !!a.data;
    mutual = !!a.data && !!b.data;
  }
  const [followerCountRes, followingCountRes] = await followCountsPromise;
  const followerCount = followerCountRes.count ?? 0;
  const followingCount = followingCountRes.count ?? 0;

  // empresa destacada (ver profiles.featured_company_room_id, migration
  // 0044_company_members_and_profile_card.sql) -- pedido do Douglas,
  // 30/set (8): "as empresas que a pessoa é dona/membro vao aparecer no
  // perfil dela [...] a logo da empresa que aparecera [...] a funcao
  // dela na empresa". RE-CONFERE aqui (nunca confia só no que já foi
  // salvo antes, ver comentário na migration) se ainda é dona/membro
  // desse espaço -- se deixou de ser (saiu, foi removida, a empresa foi
  // apagada), simplesmente não mostra mais, sem precisar de trigger
  // nenhum limpando o campo salvo.
  let company: { roomId: string; slug: string; name: string; logoUrl: string; relation: "owner" | "member" } | null = null;
  const featuredRoomId = profile.featured_company_room_id as string | null;
  if (featuredRoomId) {
    const relation = await getUserRelationToRoom(admin, targetUserId, featuredRoomId);
    if (relation) {
      const room = await admin
        .from("rooms")
        .select("id, room_slug, name, company_logo_url")
        .eq("id", featuredRoomId)
        .maybeSingle();
      if (room.data) {
        company = {
          roomId: room.data.id as string,
          slug: (room.data.room_slug as string) || "",
          name: (room.data.name as string) || "",
          logoUrl: (room.data.company_logo_url as string) || "",
          relation,
        };
      }
    }
  }

  return NextResponse.json({
    profile: {
      userId: profile.id as string,
      name: (profile.name as string) || "",
      status: (profile.status as string) || "",
      instagram: (profile.instagram as string) || "",
      bio: (profile.bio as string) || "",
      photoUrl: (profile.photo_url as string) || "",
      company,
      followerCount,
      followingCount,
    },
    following,
    mutual,
    isSelf: targetUserId === userId,
  });
}
