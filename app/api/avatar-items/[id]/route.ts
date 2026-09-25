// Apaga um item de avatar CUSTOM (cabelo/acessório/barba/traje) -- só o
// dono. Pedido do Douglas: "faz assim, coloca la nos itens eles pra eu
// apagar por la" (em vez de rodar `delete from avatar_items;` na mão,
// depois de eu ter tirado o cabelo/barba/acessório/traje "de fábrica" do
// catálogo -- ver customization.ts -- e sobrarem os itens CUSTOM que ele
// já tinha subido de teste, ver fetchAndRegisterCustomAvatarItems em
// GameRoom.tsx). Mesmo padrão de app/api/items/[id]/route.ts DELETE
// (owner-check, apaga o arquivo no Storage por melhor esforço, depois a
// linha) -- só que aqui é 1 arquivo só (sheet_url) em vez de art{}+ícone.
//
// Sem PATCH aqui (mesma decisão de avatar-items/route.ts -- editar item
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
    return NextResponse.json({ error: "só o dono da sala pode apagar item de avatar" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: item } = await admin
    .from("avatar_items")
    .select("sheet_url")
    .eq("id", params.id)
    .maybeSingle();

  if (item?.sheet_url) {
    const path = storagePathFromPublicUrl(item.sheet_url as string, "room-items");
    if (path) await admin.storage.from("room-items").remove([path]).catch(() => null);
  }

  const { error } = await admin.from("avatar_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
