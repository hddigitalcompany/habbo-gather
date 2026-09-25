// "Avatar Padrão" (Editor de Itens, aba "Avatar Padrão" -- ver
// components/ItemEditor.tsx e supabase/migrations/0008_avatar_default_reference.sql):
// UM boneco fixo de referência por sexo (cabeça + traje/corpo limpo),
// usado só pelo editor pra alinhar cabelo/acessório/barba/traje. As DUAS
// folhas já compostas (8x2/200x260, ver composeAvatarArtSheet em
// ItemEditor.tsx) já foram enviadas direto do navegador pro Supabase
// Storage (bucket "room-items", path "avatar-default-reference/...",
// REUSA o bucket que 0002_room_items.sql já criou) ANTES dessa chamada --
// aqui só grava os metadados (sexo/URLs) depois de conferir de novo que
// quem pediu é owner (defesa em profundidade, mesmo padrão de
// app/api/avatar-skins).
//
// gender é PRIMARY KEY -- POST faz UPSERT (só pode ter uma linha por
// sexo, pedido do Douglas: "só pode ter UMA em cada um deles" --
// cadastrar de novo SUBSTITUI a anterior).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_GENDERS = ["masculino", "feminino"];

export async function GET() {
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("avatar_default_reference")
    .select("gender, head_sheet_url, body_sheet_url");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ references: data ?? [] });
}

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar o Avatar Padrão" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const gender = typeof body?.gender === "string" ? body.gender : "";
  const headSheetUrl = typeof body?.headSheetUrl === "string" ? body.headSheetUrl : "";
  const bodySheetUrl = typeof body?.bodySheetUrl === "string" ? body.bodySheetUrl : "";

  if (!ALLOWED_GENDERS.includes(gender)) {
    return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
  }
  if (!headSheetUrl) return NextResponse.json({ error: "imagem da cabeça é obrigatória" }, { status: 400 });
  if (!bodySheetUrl) return NextResponse.json({ error: "imagem do traje/corpo é obrigatória" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("avatar_default_reference")
    .upsert(
      {
        gender,
        head_sheet_url: headSheetUrl,
        body_sheet_url: bodySheetUrl,
        created_by: callerId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "gender" },
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ reference: data });
}
