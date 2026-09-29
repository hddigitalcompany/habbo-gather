// GET /api/friends/search?q=texto -- busca gente (por nome) pra
// SEGUIR, na aba de busca do FriendsPanel (ver comentário grande em
// components/FriendsPanel.tsx). Fonte é public.profiles (toda conta
// real da plataforma), não chatStore -- "seguir" só existe pra quem
// tem conta (ver /api/friends/list). Sem "q", devolve os primeiros 50
// por nome (mesma ideia de "todo mundo cadastrado" que o Contatos de
// antes tinha, só que agora filtrado pra quem tem CONTA de verdade).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ users: [] });

  const q = (req.nextUrl.searchParams.get("q") || "").trim().slice(0, 100);
  let query = admin.from("profiles").select("id, name, photo_url").neq("id", userId).order("name").limit(50);
  if (q) query = query.ilike("name", `%${q}%`);
  const { data: profiles, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: following } = await admin.from("followers").select("followed_id").eq("follower_id", userId);
  const followingIds = new Set((following ?? []).map((r) => r.followed_id as string));

  const users = (profiles ?? []).map((p) => ({
    userId: p.id as string,
    name: (p.name as string) || "",
    photoUrl: (p.photo_url as string) || "",
    following: followingIds.has(p.id as string),
  }));

  return NextResponse.json({ users });
}
