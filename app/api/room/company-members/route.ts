// GET/POST/DELETE /api/room/company-members -- membros (colaboradores)
// de UMA empresa (ver public.company_members, migration
// 0044_company_members_and_profile_card.sql) -- pedido do Douglas,
// 30/set (8). Perguntado como alguém vira membro de uma empresa
// específica (convite por link "acaba indo pra visitantes também"),
// escolheu: "a pessoa tem que ser adicionada como membro por quem tem
// direitos na sala" -- hoje só existe UM "direito" desses por espaço
// (rooms.owner_user_id, mesmo padrão de app/api/room/company-profile),
// então só o DONO do espaço pode listar/adicionar/remover, igual editar
// o card da empresa.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

async function requireOwnedRoom(admin: ReturnType<typeof getSupabaseAdminClient>, userId: string, slug: string) {
  if (!admin) return { error: "Supabase não configurado", status: 500 } as const;
  const room = await admin.from("rooms").select("id, owner_user_id").eq("room_slug", slug).maybeSingle();
  if (!room.data) return { error: "espaço não encontrado", status: 404 } as const;
  if (room.data.owner_user_id !== userId) {
    return { error: "só o dono desse espaço pode mexer nos membros", status: 403 } as const;
  }
  return { roomId: room.data.id as string } as const;
}

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const slug = req.nextUrl.searchParams.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "slug é obrigatório" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const gate = await requireOwnedRoom(admin, userId, slug);
  if ("error" in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const { data, error } = await admin!
    .from("company_members")
    .select("user_id, cargo, created_at, profiles(name, photo_url)")
    .eq("room_id", gate.roomId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const members = (data ?? []).map((row: any) => ({
    userId: row.user_id as string,
    name: (row.profiles?.name as string) || "",
    photoUrl: (row.profiles?.photo_url as string) || "",
    // "Cargo" (pedido do Douglas, 30/set (16), ver migration
    // 0047_company_member_cargo.sql) -- "" quando o dono ainda não
    // escolheu nenhum (ver CARGO_OPTIONS em components/Lobby.tsx).
    cargo: (row.cargo as string) || "",
  }));
  return NextResponse.json({ members });
}

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const targetUserId = typeof body?.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!slug || !targetUserId) return NextResponse.json({ error: "slug e targetUserId são obrigatórios" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const gate = await requireOwnedRoom(admin, userId, slug);
  if ("error" in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (targetUserId === userId) {
    return NextResponse.json({ error: "você já é a dona desse espaço" }, { status: 400 });
  }
  const targetProfile = await admin!.from("profiles").select("id").eq("id", targetUserId).maybeSingle();
  if (!targetProfile.data) return NextResponse.json({ error: "conta não encontrada" }, { status: 404 });

  // "Cargo" (pedido do Douglas, 30/set (16)) -- MESMA rota serve pra
  // "adicionar membro" (sem `cargo` no corpo -- upsert só grava
  // room_id/user_id/added_by, o cargo nasce "" pelo default do banco
  // numa linha nova, ou fica INTOCADO numa já existente, já que só as
  // colunas presentes no payload entram no ON CONFLICT DO UPDATE) e
  // "trocar o cargo de um membro já adicionado" (com `cargo` no
  // corpo, ver updateMemberCargo em components/Lobby.tsx). Sem
  // validação contra a lista fixa (mesmo padrão de company_category
  // logo abaixo em company-profile/route.ts) -- só tipo/tamanho.
  const cargo = typeof body?.cargo === "string" ? body.cargo.trim().slice(0, 60) : undefined;
  const payload: { room_id: string; user_id: string; added_by: string; cargo?: string } = {
    room_id: gate.roomId,
    user_id: targetUserId,
    added_by: userId,
  };
  if (cargo !== undefined) payload.cargo = cargo;

  const { error } = await admin!.from("company_members").upsert(payload, { onConflict: "room_id,user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const targetUserId = typeof body?.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!slug || !targetUserId) return NextResponse.json({ error: "slug e targetUserId são obrigatórios" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  const gate = await requireOwnedRoom(admin, userId, slug);
  if ("error" in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const { error } = await admin!.from("company_members").delete().eq("room_id", gate.roomId).eq("user_id", targetUserId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
