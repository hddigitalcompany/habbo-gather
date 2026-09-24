// Cria um link/código de convite pra virar membro direto (sem
// precisar de um dono promovendo na mão) -- só o dono pode gerar (ver
// app/api/room/members/route.ts pro mesmo padrão de checagem). Pra
// RESGATAR o código, ver app/api/room/invite/redeem/route.ts.
import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

function generateCode(): string {
  // 8 caracteres, base32-ish (sem 0/O/1/I pra não confundir lendo em
  // voz alta) -- curto o bastante pra digitar, longo o bastante pra
  // não adivinhar.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode gerar convite" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const maxUses = typeof body?.maxUses === "number" && body.maxUses > 0 ? Math.floor(body.maxUses) : null;
  const expiresInHours = typeof body?.expiresInHours === "number" && body.expiresInHours > 0 ? body.expiresInHours : null;
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3_600_000).toISOString() : null;

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const code = generateCode();
  const { error } = await admin.from("room_invites").insert({
    code,
    created_by: callerId,
    max_uses: maxUses,
    expires_at: expiresAt,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ code });
}
