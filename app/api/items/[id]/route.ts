// Apaga um item de móvel CUSTOM (Editor de Itens) -- só o dono. Apaga
// a LINHA (room_items) e, melhor esforço, os arquivos correspondentes
// no Storage (bucket "room-items") -- uma falha ao apagar arquivo não
// impede apagar o registro (não deixa um item "fantasma" preso só
// porque sobrou lixo no Storage).
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
    return NextResponse.json({ error: "só o dono da sala pode apagar item" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: item } = await admin.from("room_items").select("art").eq("id", params.id).maybeSingle();
  if (item?.art && typeof item.art === "object") {
    const paths = Object.values(item.art as Record<string, string>)
      .map((url) => storagePathFromPublicUrl(url, "room-items"))
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      await admin.storage.from("room-items").remove(paths).catch(() => null);
    }
  }

  const { error } = await admin.from("room_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
