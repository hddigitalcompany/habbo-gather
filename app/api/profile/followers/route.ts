// GET /api/profile/followers?userId=X&type=followers|following -- lista
// de contas pro card "Seguidores"/"Seguindo" do perfil público (pedido
// do Douglas, 30/set: "perfil de usuario publico, quero seguidores e
// seguindo", ver components/ProfileViewCard.tsx). Mesma tabela/cálculo
// de sempre (public.followers, 0039_followers.sql -- assimétrico,
// "amigo" é só quando os dois se seguem, não entra aqui) -- essa rota
// só lista um lado de cada vez:
// - type=followers: quem SEGUE a conta `userId` (follower_id ->
//   followed_id = userId)
// - type=following: quem a conta `userId` SEGUE (follower_id = userId)
//
// Público pra qualquer conta logada ver de QUALQUER perfil (igual
// Instagram/Twitter -- não só a própria lista, ver /api/friends/list
// que é só a de quem chama), por isso lê com a service role (mesmo
// motivo de sempre: public.followers não tem policy de select pro
// cliente, ver comentário na migration).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const viewerId = await getVerifiedUserId(req);
  if (!viewerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const targetUserId = req.nextUrl.searchParams.get("userId")?.trim();
  const type = req.nextUrl.searchParams.get("type") === "following" ? "following" : "followers";
  if (!targetUserId) return NextResponse.json({ error: "userId é obrigatório" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ users: [] });

  const { data: rows, error } =
    type === "following"
      ? await admin.from("followers").select("followed_id").eq("follower_id", targetUserId)
      : await admin.from("followers").select("follower_id").eq("followed_id", targetUserId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (rows ?? []).map((r) => (type === "following" ? (r as { followed_id: string }).followed_id : (r as { follower_id: string }).follower_id));
  if (ids.length === 0) return NextResponse.json({ users: [] });

  const { data: profiles, error: profilesError } = await admin.from("profiles").select("id, name, photo_url").in("id", ids);
  if (profilesError) return NextResponse.json({ error: profilesError.message }, { status: 500 });

  const users = (profiles ?? [])
    .map((p) => ({ userId: p.id as string, name: (p.name as string) || "", photoUrl: (p.photo_url as string) || "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return NextResponse.json({ users });
}
