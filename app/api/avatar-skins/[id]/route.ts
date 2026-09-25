// Apaga um TOM DE PELE custom -- só o dono. Pedido do Douglas: "deixar
// apenas branco/pardo/negro" na lista "Tons cadastrados" (tinha entrada
// com nome errado "Ela" e "Pardo" duplicado -- feminino e masculino
// separados -- de teste antigo). Mesmo padrão de
// app/api/avatar-items/[id]/route.ts DELETE (owner-check, apaga o
// arquivo no Storage por melhor esforço, depois a linha).
//
// Sem PATCH aqui (mesma decisão de avatar-skins/route.ts -- editar tom
// custom ainda não tem UI, só cadastrar/apagar).
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
