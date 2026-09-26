// Edita/apaga um modelo de PISO customizado (Editor de Itens, aba
// "Criar Piso") -- só o dono. Mesmo esquema de app/api/items/[id]/route.ts
// (móvel), bem mais simples: PATCH só troca label/category/file_url (o
// que vier no corpo), DELETE apaga a linha e, melhor esforço, o arquivo
// correspondente no Storage (bucket "room-items", pasta "piso/") --
// uma falha ao apagar arquivo não impede apagar o registro.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["porcelanato", "laminado", "natural"];
const ALLOWED_KINDS = ["image", "pattern"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Extrai o caminho DENTRO do bucket a partir da URL pública do Storage (.../object/public/<bucket>/<path>) -- null se não bater com o formato esperado. Mesma função de app/api/items/[id]/route.ts (não compartilhada num helper à parte só por isso -- são só 5 linhas). */
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
    return NextResponse.json({ error: "só o dono da sala pode editar piso" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: existing, error: fetchError } = await admin
    .from("room_floor_items")
    .select("file_url, kind")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "piso não encontrado" }, { status: 404 });

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
  // troca de tipo (image <-> pattern, ver supabase/migrations/
  // 0016_room_floor_items_pattern.sql) -- raro (a aba "Criar Piso" não
  // deixa trocar tipo no meio de uma edição, só ao cadastrar um novo),
  // mas aceito aqui por completude/futuro.
  if (typeof body.kind === "string" && ALLOWED_KINDS.includes(body.kind)) update.kind = body.kind;

  // imagem nova (re-upload no editar) -- apaga (melhor esforço) o
  // arquivo ANTIGO no Storage quando troca por uma URL diferente, mesmo
  // esquema de `art` em app/api/items/[id]/route.ts.
  if (typeof body.file_url === "string" && body.file_url && body.file_url !== existing.file_url) {
    if (existing.file_url) {
      const oldPath = storagePathFromPublicUrl(existing.file_url as string, "room-items");
      if (oldPath) await admin.storage.from("room-items").remove([oldPath]).catch(() => null);
    }
    update.file_url = body.file_url;
  }

  // ripa/cores do piso "padrão" (ver FloorPatternConfig em
  // game/floor.ts) -- os 3 juntos ou nenhum, pra nunca salvar uma
  // combinação pela metade.
  if ("plank_width_px" in body || "color_a" in body || "color_b" in body) {
    const plankWidthPx = typeof body.plank_width_px === "number" && Number.isFinite(body.plank_width_px) ? Math.round(body.plank_width_px) : NaN;
    const colorA = typeof body.color_a === "string" ? body.color_a : "";
    const colorB = typeof body.color_b === "string" ? body.color_b : "";
    if (!Number.isFinite(plankWidthPx) || plankWidthPx < 4 || plankWidthPx > 200) {
      return NextResponse.json({ error: "largura da ripa precisa ser entre 4 e 200" }, { status: 400 });
    }
    if (!HEX_COLOR_RE.test(colorA) || !HEX_COLOR_RE.test(colorB)) {
      return NextResponse.json({ error: "as duas cores da ripa são obrigatórias" }, { status: 400 });
    }
    update.plank_width_px = plankWidthPx;
    update.color_a = colorA;
    update.color_b = colorB;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await admin.from("room_floor_items").update(update).eq("id", params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode apagar piso" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: item } = await admin.from("room_floor_items").select("file_url").eq("id", params.id).maybeSingle();
  if (item?.file_url) {
    const path = storagePathFromPublicUrl(item.file_url as string, "room-items");
    if (path) await admin.storage.from("room-items").remove([path]).catch(() => null);
  }

  const { error } = await admin.from("room_floor_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
