// Edita/apaga um item de móvel CUSTOM (Editor de Itens) -- só o dono.
// PATCH atualiza só os campos que vierem no corpo (nome/categoria/
// imagens/tamanho/ícone/posição -- ver ItemEditor.tsx, botão "Editar"),
// mesclando a arte nova com a que já existia (não perde uma direção que
// não foi reenviada). DELETE apaga a LINHA e, melhor esforço, os
// arquivos correspondentes no Storage (bucket "room-items") -- uma
// falha ao apagar arquivo não impede apagar o registro (não deixa um
// item "fantasma" preso só porque sobrou lixo no Storage). Os dois
// fazem a mesma limpeza quando uma imagem (direção OU ícone) é
// SUBSTITUÍDA por um upload novo: cada envio gera um caminho com
// timestamp próprio (ver ItemEditor.tsx), então o arquivo antigo vira
// lixo se ninguém apagar.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";
import { clampItemOffset, clampSeatOffset, cleanDirectionOffsets } from "@/lib/supabase/itemFields";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["poltrona", "divisoria", "sofa", "mesa", "planta", "computador"];
const ALLOWED_DIRECTIONS = ["down", "left", "right", "up"];

/** Extrai o caminho DENTRO do bucket a partir da URL pública do Storage (.../object/public/<bucket>/<path>) -- null se não bater com o formato esperado. */
function storagePathFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode editar item" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: existing, error: fetchError } = await admin
    .from("room_items")
    .select("art, icon_url")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "item não encontrado" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corpo inválido" }, { status: 400 });

  const update: Record<string, unknown> = {};

  if (typeof body.label === "string") {
    const label = body.label.trim();
    if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
    update.label = label;
  }
  if (typeof body.category === "string") {
    if (!ALLOWED_CATEGORIES.includes(body.category)) {
      return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
    }
    update.category = body.category;
  }

  // arte: MESCLA com o que já existia -- só troca as direções que
  // vieram no corpo (re-upload no editar), as outras continuam com a
  // URL antiga. Apaga (melhor esforço) o arquivo ANTIGO no Storage de
  // cada direção substituída por uma URL diferente.
  if (body.art && typeof body.art === "object") {
    const oldArt = (existing.art ?? {}) as Record<string, string>;
    const mergedArt: Record<string, string> = { ...oldArt };
    const staleStoragePaths: string[] = [];
    for (const dir of ALLOWED_DIRECTIONS) {
      const value = (body.art as Record<string, unknown>)[dir];
      if (typeof value !== "string" || !value || value === oldArt[dir]) continue;
      if (oldArt[dir]) {
        const oldPath = storagePathFromPublicUrl(oldArt[dir], "room-items");
        if (oldPath) staleStoragePaths.push(oldPath);
      }
      mergedArt[dir] = value;
    }
    if (!mergedArt.down) return NextResponse.json({ error: "imagem de frente é obrigatória" }, { status: 400 });
    update.art = mergedArt;
    if (staleStoragePaths.length > 0) {
      await admin.storage.from("room-items").remove(staleStoragePaths).catch(() => null);
    }
  }

  if ("display_width" in body) {
    const raw = body.display_width;
    update.display_width =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 20 && raw <= 600 ? Math.round(raw) : null;
  }

  // ícone próprio do catálogo -- "icon_url" no corpo (mesmo ausente que
  // string vazia) pode vir null de propósito (removeu o ícone custom,
  // volta pro fallback padrão), por isso confere presença da CHAVE, não
  // truthiness do valor.
  if ("icon_url" in body) {
    const rawIcon = body.icon_url;
    const nextIcon = typeof rawIcon === "string" && rawIcon ? rawIcon : null;
    const oldIcon = (existing.icon_url as string | null) ?? null;
    if (oldIcon && oldIcon !== nextIcon) {
      const oldIconPath = storagePathFromPublicUrl(oldIcon, "room-items");
      if (oldIconPath) await admin.storage.from("room-items").remove([oldIconPath]).catch(() => null);
    }
    update.icon_url = nextIcon;
  }

  if ("offset_x" in body) update.offset_x = clampItemOffset(body.offset_x);
  if ("offset_y" in body) update.offset_y = clampItemOffset(body.offset_y);
  // ajuste por direção + interação/assento (ver comentário equivalente
  // em app/api/items/route.ts/POST) -- "in body" de propósito (não
  // truthiness): null explícito é uma edição de verdade (limpa o
  // override/volta pro fallback), diferente de "não mandou esse campo".
  if ("direction_offsets" in body) update.direction_offsets = cleanDirectionOffsets(body.direction_offsets);
  if (typeof body.sittable === "boolean") update.sittable = body.sittable;
  if ("seat_offset_x" in body) update.seat_offset_x = clampSeatOffset(body.seat_offset_x) ?? null;
  if ("seat_offset_y" in body) update.seat_offset_y = clampSeatOffset(body.seat_offset_y) ?? null;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await admin.from("room_items").update(update).eq("id", params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
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

  const { data: item } = await admin.from("room_items").select("art, icon_url").eq("id", params.id).maybeSingle();
  const paths: string[] = [];
  if (item?.art && typeof item.art === "object") {
    paths.push(
      ...Object.values(item.art as Record<string, string>)
        .map((url) => storagePathFromPublicUrl(url, "room-items"))
        .filter((p): p is string => Boolean(p))
    );
  }
  if (item?.icon_url) {
    const iconPath = storagePathFromPublicUrl(item.icon_url as string, "room-items");
    if (iconPath) paths.push(iconPath);
  }
  if (paths.length > 0) {
    await admin.storage.from("room-items").remove(paths).catch(() => null);
  }

  const { error } = await admin.from("room_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
