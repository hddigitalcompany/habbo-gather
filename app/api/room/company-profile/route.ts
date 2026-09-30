// GET/POST /api/room/company-profile -- pedido do Douglas (29/set
// (7)): "quero cada card de empresa atrelado a um espaco". Antes o
// "Card da Empresa" (components/Lobby.tsx, .lobby-company-card-pin)
// era um MOLDE fixo, guardado só em localStorage, o mesmo pra
// qualquer sala/conta nesse navegador (ver comentário grande do
// CompanyProfile em Lobby.tsx antes dessa rota existir). Agora cada
// ESPAÇO (linha de public.rooms, is_template=false) tem seu próprio
// card, colunas company_* (ver migration
// 0040_room_company_profile.sql -- RODAR NO SQL EDITOR DO SUPABASE
// ANTES de fazer deploy disso, senão essas colunas não existem
// ainda).
//
// GET é PÚBLICO de propósito (?slug=<room_slug>) -- igual o "mapinha"
// de prévia (GET /api/room/layout) e o preview de "Entrar na sala",
// qualquer um vendo um espaço (o seu, o de outra empresa que visitou,
// a Sala Principal do time) pode ver o card dela. `canEdit` no
// retorno diz pro FRONT se mostra a setinha de editar -- calculado
// aqui (dono de verdade, via token opcional), não é uma trava de
// segurança nova: o POST abaixo confere a posse de novo, do zero,
// então mesmo alguém forçando o front a mostrar a edição não
// conseguiria de fato salvar em sala que não é dela.
//
// `name` (Nome fantasia) não é coluna nova nenhuma -- é a MESMA
// `rooms.name` que já aparece em "Meus espaços"/aba "Empresa" do chat
// (ver create-from-template/route.ts). Editar aqui reescreve ela
// direto -- assim o nome nunca diverge entre os dois lugares (era
// exatamente o problema que o sync manual antigo, em Lobby.tsx,
// tentava tapar; essa rota substitui aquele hack).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

type CompanyProfileRow = {
  name: string;
  owner_user_id: string | null;
  company_handle: string | null;
  company_bio: string | null;
  company_link: string | null;
  company_logo_url: string | null;
  company_banner_url: string | null;
  company_category: string[] | null;
  company_show_name_on_employee_profiles: boolean | null;
  company_followers: number | null;
};

function toProfile(row: CompanyProfileRow) {
  return {
    name: row.name,
    handle: row.company_handle ?? "",
    bio: row.company_bio ?? "",
    link: row.company_link ?? "",
    logoUrl: row.company_logo_url ?? "",
    bannerUrl: row.company_banner_url ?? "",
    category: Array.isArray(row.company_category) ? row.company_category : [],
    showNameOnEmployeeProfiles: row.company_show_name_on_employee_profiles ?? true,
    followers: row.company_followers ?? 0,
  };
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "slug é obrigatório" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("rooms")
    .select(
      "name, owner_user_id, company_handle, company_bio, company_link, company_logo_url, company_banner_url, company_category, company_show_name_on_employee_profiles, company_followers"
    )
    .eq("room_slug", slug)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ profile: null, canEdit: false });

  // token opcional só pra saber se quem tá olhando é o dono (mostra a
  // setinha de editar) -- não bloqueia a leitura se não vier/for
  // inválido, ver comentário grande no topo do arquivo.
  const userId = await getVerifiedUserId(req);
  const canEdit = !!userId && !!data.owner_user_id && userId === data.owner_user_id;

  return NextResponse.json({ profile: toProfile(data as CompanyProfileRow), canEdit });
}

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  if (!slug) return NextResponse.json({ error: "slug é obrigatório" }, { status: 400 });

  // confere posse de novo aqui (não confia no `canEdit` que o GET
  // mandou pro front) -- mesmo padrão de app/api/room/members (só
  // dono mexe na própria sala).
  const room = await admin.from("rooms").select("id, owner_user_id").eq("room_slug", slug).maybeSingle();
  if (!room.data) return NextResponse.json({ error: "espaço não encontrado" }, { status: 404 });
  if (room.data.owner_user_id !== userId) {
    return NextResponse.json({ error: "só o dono desse espaço pode editar o card" }, { status: 403 });
  }

  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return NextResponse.json({ error: "nome fantasia é obrigatório" }, { status: 400 });

  const update = {
    name,
    company_handle: typeof body?.handle === "string" ? body.handle.trim().slice(0, 30) : "",
    company_bio: typeof body?.bio === "string" ? body.bio.trim().slice(0, 200) : "",
    company_link: typeof body?.link === "string" ? body.link.trim().slice(0, 80) : "",
    company_logo_url: typeof body?.logoUrl === "string" ? body.logoUrl : "",
    company_banner_url: typeof body?.bannerUrl === "string" ? body.bannerUrl : "",
    company_category: Array.isArray(body?.category) ? body.category.filter((c: unknown) => typeof c === "string") : [],
    company_show_name_on_employee_profiles: body?.showNameOnEmployeeProfiles !== false,
  };

  const updated = await admin
    .from("rooms")
    .update(update)
    .eq("id", room.data.id)
    .select(
      "name, owner_user_id, company_handle, company_bio, company_link, company_logo_url, company_banner_url, company_category, company_show_name_on_employee_profiles, company_followers"
    )
    .single();
  if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 500 });

  return NextResponse.json({ profile: toProfile(updated.data as CompanyProfileRow) });
}
