// GET /api/friends/list -- "amigos" de verdade (mútuo: eu sigo E sou
// seguido, ver public.followers/0039_followers.sql) do usuário
// logado, com nome/foto pra desenhar components/FriendsPanel.tsx.
// Fonte do nome/foto é public.profiles (conta de verdade), NÃO
// chatStore.listAllUsers -- "amigo" é conceito de CONTA (só quem tem
// login, ver getVerifiedUserId), diferente de "Conversar" no resto do
// app, que qualquer um (até visitante sem conta) pode fazer.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ friends: [] });

  const [{ data: following }, { data: followers }] = await Promise.all([
    admin.from("followers").select("followed_id").eq("follower_id", userId),
    admin.from("followers").select("follower_id").eq("followed_id", userId),
  ]);
  const followingIds = new Set((following ?? []).map((r) => r.followed_id as string));
  const followerIds = new Set((followers ?? []).map((r) => r.follower_id as string));
  const mutualIds = [...followingIds].filter((id) => followerIds.has(id));
  // DEBUG TEMPORÁRIO (2/out) -- Douglas: "eu e outra conta nos
  // seguimos mutuamente porem ela nao entra nos meus amigos ainda",
  // segunda tentativa (tab como dependência em FriendsPanel.tsx) não
  // resolveu ("nada ainda") -- ou seja, nem reabrir/recarregar a lista
  // do zero traz a conta mútua, o que aponta pro cálculo/dado no
  // SERVIDOR, não pra cache/staleness do navegador. Sem acesso direto
  // ao banco nessa sessão -- loga aqui pra ver no terminal (`npm run
  // dev`) o que o servidor realmente está vendo da próxima vez que
  // reproduzir. Remover depois de achar a causa.
  console.log("[friends/list][DEBUG] userId=%s following=%o followers=%o mutualIds=%o", userId, [...followingIds], [...followerIds], mutualIds);
  if (mutualIds.length === 0) return NextResponse.json({ friends: [] });

  const { data: profiles, error } = await admin.from("profiles").select("id, name, photo_url").in("id", mutualIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const friends = (profiles ?? [])
    .map((p) => ({ userId: p.id as string, name: (p.name as string) || "", photoUrl: (p.photo_url as string) || "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return NextResponse.json({ friends });
}
