// Apaga um TOM DE PELE custom -- só o dono. Pedido do Douglas: "deixar
// apenas branco/pardo/negro" na lista "Tons cadastrados" (tinha entrada
// com nome errado "Ela" e "Pardo" duplicado -- feminino e masculino
// separados -- de teste antigo). Mesmo padrão de
// app/api/avatar-items/[id]/route.ts DELETE (owner-check, apaga o
// arquivo no Storage por melhor esforço, depois a linha).
//
// PATCH: "adicionar cores pra avatar tambem" (pedido do Douglas, mesma
// ferramenta -- ColorZoneTool.tsx -- que já existia pra cabelo/
// acessório/traje, agora reaproveitada aqui via prop apiBase="avatar-
// skins") -- grava o array `colors` (variantes de cor GERADAS por cima
// do tom já cadastrado, ver game/colorTint.ts) desse tom de pele. Mesmo
// formato/validação de app/api/avatar-items/[id]/route.ts PATCH. Só
// esse campo -- não dá pra trocar label/sexo/arte base por aqui.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

/** Extrai o caminho DENTRO do bucket a partir da URL pública do Storage (.../object/public/<bucket>/<path>) -- null se não bater com o formato esperado. */
function storagePathFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode apagar tom de pele" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: skin } = await admin
    .from("avatar_skins")
    .select("sheet_url")
    .eq("id", params.id)
    .maybeSingle();

  if (skin?.sheet_url) {
    const path = storagePathFromPublicUrl(skin.sheet_url as string, "room-items");
    if (path) await admin.storage.from("room-items").remove([path]).catch(() => null);
  }

  const { error } = await admin.from("avatar_skins").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode editar tom de pele" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const colors = Array.isArray(body?.colors) ? body.colors : null;
  if (!colors) return NextResponse.json({ error: "colors (array) é obrigatório" }, { status: 400 });

  // validação básica de cada entrada -- mesmo formato de ColorOption em
  // game/customization.ts (id/label/file obrigatórios, hex opcional).
  for (const c of colors) {
    if (typeof c?.id !== "string" || !c.id) {
      return NextResponse.json({ error: "cada cor precisa de id" }, { status: 400 });
    }
    if (typeof c?.label !== "string" || !c.label) {
      return NextResponse.json({ error: "cada cor precisa de label" }, { status: 400 });
    }
    if (typeof c?.file !== "string" || !c.file) {
      return NextResponse.json({ error: "cada cor precisa de file (URL)" }, { status: 400 });
    }
    if (c.hex !== undefined && typeof c.hex !== "string") {
      return NextResponse.json({ error: "hex precisa ser string" }, { status: 400 });
    }
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("avatar_skins")
    .update({ colors })
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ skin: data });
}
