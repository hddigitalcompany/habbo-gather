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
// cadastrar de novo SUBSTITUI a anterior). DELETE apaga a linha do sexo
// (?gender=masculino|feminino) -- pedido do Douglas: "o botao comecar
// do zero nao apaga o avatar antigo" (o botão só limpava o upload em
// andamento no navegador, o registro salvo continuava voltando como
// fallback -- ver ItemEditor.tsx, handleClearPadrao).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_GENDERS = ["masculino", "feminino"];

/** Extrai o caminho DENTRO do bucket a partir da URL pública do Storage (.../object/public/<bucket>/<path>) -- null se não bater com o formato esperado. Mesma função de app/api/items/[id]/route.ts (ainda sem util compartilhado). */
function storagePathFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

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

export async function DELETE(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode apagar o Avatar Padrão" }, { status: 403 });
  }

  const gender = req.nextUrl.searchParams.get("gender") ?? "";
  if (!ALLOWED_GENDERS.includes(gender)) {
    return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: existing } = await admin
    .from("avatar_default_reference")
    .select("head_sheet_url, body_sheet_url")
    .eq("gender", gender)
    .maybeSingle();

  const paths: string[] = [];
  if (existing?.head_sheet_url) {
    const p = storagePathFromPublicUrl(existing.head_sheet_url as string, "room-items");
    if (p) paths.push(p);
  }
  if (existing?.body_sheet_url) {
    const p = storagePathFromPublicUrl(existing.body_sheet_url as string, "room-items");
    if (p) paths.push(p);
  }
  if (paths.length > 0) {
    await admin.storage.from("room-items").remove(paths).catch(() => null);
  }

  const { error } = await admin.from("avatar_default_reference").delete().eq("gender", gender);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
