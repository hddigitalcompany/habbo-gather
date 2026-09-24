// Resgata um código de convite (ver app/api/room/invite/route.ts) --
// quem tiver CONTA (qualquer uma, não precisa já ser membro) e o
// código certo vira "member" na hora, sem precisar de um dono
// promovendo na mão.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return NextResponse.json({ error: "código obrigatório" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: invite, error: findError } = await admin
    .from("room_invites")
    .select("id, created_by, max_uses, uses, expires_at, revoked")
    .eq("code", code)
    .maybeSingle();
  if (findError) return NextResponse.json({ error: findError.message }, { status: 500 });
  if (!invite) return NextResponse.json({ error: "código inválido" }, { status: 404 });
  if (invite.revoked) return NextResponse.json({ error: "esse convite foi revogado" }, { status: 400 });
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "esse convite expirou" }, { status: 400 });
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return NextResponse.json({ error: "esse convite já atingiu o limite de usos" }, { status: 400 });
  }

  // não deixa "resgatar de novo" sobrescrever quem já é owner, ou
  // reviver quem tá banido (banido precisa ser desbanido por um
  // dono de verdade, não driblando com um convite).
  const { data: existing } = await admin.from("room_members").select("role, status").eq("user_id", userId).maybeSingle();
  if (existing?.role === "owner") return NextResponse.json({ ok: true, already: true });
  if (existing?.status === "banned") {
    return NextResponse.json({ error: "sua conta foi banida dessa sala" }, { status: 403 });
  }

  const { error: upsertError } = await admin
    .from("room_members")
    .upsert({ user_id: userId, role: "member", status: "active", added_by: invite.created_by }, { onConflict: "user_id" });
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  await admin.from("room_invites").update({ uses: invite.uses + 1 }).eq("id", invite.id);

  return NextResponse.json({ ok: true });
}
