// Lista/promove/rebaixa/bane membro da sala -- só o "owner" (dono,
// ver bootstrapOwnerIfEmpty em lib/supabase/roomAuth.ts) pode mexer.
// Chamado do painel de configuração de membros (ver
// components/RoomMembersPanel.tsx), sempre com o access token do
// Supabase no header Authorization: Bearer <token> (ver
// accountAccessToken em AuthGate.tsx/GameRoom.tsx).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

// GET /api/room/members       -> { role } (o MEU papel na sala)
// GET /api/room/members?list=1 -> { role, members: [...] } (só owner)
export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(userId);
  const membership = await getMembership(userId);
  const role: "owner" | "member" | "visitor" = membership?.status === "banned" ? "visitor" : membership?.role ?? "visitor";
  const banned = membership?.status === "banned";

  if (req.nextUrl.searchParams.get("list") !== "1") {
    return NextResponse.json({ role, banned });
  }
  if (role !== "owner") {
    return NextResponse.json({ error: "só o dono da sala pode ver essa lista" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("room_members")
    .select("user_id, role, status, created_at, profiles(name, photo_url)")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ role, members: data ?? [] });
}

type Action = "promote" | "demote" | "ban" | "unban";

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const callerMembership = await getMembership(callerId);
  if (callerMembership?.role !== "owner" || callerMembership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode fazer isso" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as Action | undefined;
  const targetUserId = typeof body?.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!action || !targetUserId) {
    return NextResponse.json({ error: "action e targetUserId são obrigatórios" }, { status: 400 });
  }
  if (targetUserId === callerId) {
    return NextResponse.json({ error: "não dá pra mexer no seu próprio acesso por aqui" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  // nunca deixa promover/rebaixar/banir quem já é owner (só existe UM
  // dono, definido pelo bootstrap -- ver comentário lá).
  const target = await getMembership(targetUserId);
  if (target?.role === "owner") {
    return NextResponse.json({ error: "não dá pra mexer no dono da sala" }, { status: 400 });
  }

  let error: { message: string } | null = null;
  if (action === "promote") {
    ({ error } = await admin
      .from("room_members")
      .upsert({ user_id: targetUserId, role: "member", status: "active", added_by: callerId }, { onConflict: "user_id" }));
  } else if (action === "demote") {
    ({ error } = await admin.from("room_members").delete().eq("user_id", targetUserId).eq("role", "member"));
  } else if (action === "ban") {
    ({ error } = await admin
      .from("room_members")
      .upsert({ user_id: targetUserId, role: "member", status: "banned", added_by: callerId }, { onConflict: "user_id" }));
  } else if (action === "unban") {
    ({ error } = await admin.from("room_members").delete().eq("user_id", targetUserId).eq("status", "banned"));
  } else {
    return NextResponse.json({ error: "ação inválida" }, { status: 400 });
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
