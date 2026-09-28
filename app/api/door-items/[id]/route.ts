// Edita/apaga uma PORTA customizada (Editor de Itens, aba "Criar Porta")
// -- só o admin da plataforma. Mesmo esquema de app/api/floor-items/[id]/route.ts
// (envolve Storage, já que porta sempre tem imagem -- ver
// app/api/door-items/route.ts): PATCH troca label/kind/qualquer imagem
// vinda no corpo, apagando (melhor esforço) a imagem ANTIGA no Storage
// quando troca por uma URL diferente; DELETE apaga a linha e as 4
// imagens (melhor esforço, uma falha não impede apagar o registro).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = ["correr-1-folha", "correr-2-folhas"];
const ART_FIELDS = ["art_left_closed", "art_left_open", "art_right_closed", "art_right_open"] as const;

/** Mesma função de app/api/floor-items/[id]/route.ts (não compartilhada
 * num helper à parte só por isso -- são só 5 linhas). */
function storagePathFromPublicUrl(url: string, bucket: string): string | null {
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode editar porta" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: existing, error: fetchError } = await admin
    .from("room_door_items")
    .select(ART_FIELDS.join(", "))
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "porta não encontrada" }, { status: 404 });
  const existingRow = existing as unknown as Record<string, string | null>;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corpo inválido" }, { status: 400 });

  const update: Record<string, unknown> = {};

  if (typeof body.label === "string") {
    const label = body.label.trim();
    if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
    update.label = label;
  }
  if (typeof body.kind === "string") {
    if (!ALLOWED_KINDS.includes(body.kind)) return NextResponse.json({ error: "tipo de porta inválido" }, { status: 400 });
    update.kind = body.kind;
  }

  // imagem nova por campo (re-upload no editar) -- apaga (melhor
  // esforço) a arte ANTIGA no Storage quando troca por uma URL
  // diferente, mesmo esquema de file_url em app/api/floor-items/[id]/route.ts.
  // null explícito (só faz sentido nos campos "right", opcionais) apaga
  // a arte do lado direito -- volta a cair pro fallback do lado esquerdo.
  for (const field of ART_FIELDS) {
    if (!(field in body)) continue;
    const isRightField = field.includes("right");
    if (body[field] === null) {
      if (!isRightField) return NextResponse.json({ error: `${field} é obrigatório` }, { status: 400 });
      if (existingRow[field]) {
        const oldPath = storagePathFromPublicUrl(existingRow[field] as string, "room-items");
        if (oldPath) await admin.storage.from("room-items").remove([oldPath]).catch(() => null);
      }
      update[field] = null;
      continue;
    }
    if (typeof body[field] === "string" && body[field] && body[field] !== existingRow[field]) {
      if (existingRow[field]) {
        const oldPath = storagePathFromPublicUrl(existingRow[field] as string, "room-items");
        if (oldPath) await admin.storage.from("room-items").remove([oldPath]).catch(() => null);
      }
      update[field] = body[field];
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await admin.from("room_door_items").update(update).eq("id", params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode apagar porta" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: item } = await admin.from("room_door_items").select(ART_FIELDS.join(", ")).eq("id", params.id).maybeSingle();
  if (item) {
    const row = item as unknown as Record<string, string | null>;
    for (const field of ART_FIELDS) {
      if (!row[field]) continue;
      const path = storagePathFromPublicUrl(row[field] as string, "room-items");
      if (path) await admin.storage.from("room-items").remove([path]).catch(() => null);
    }
  }

  const { error } = await admin.from("room_door_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
