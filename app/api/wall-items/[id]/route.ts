// Edita/apaga um PADRÃO de parede de sistema customizado (Editor de
// Itens, aba "Criar Parede") -- só o admin da plataforma. Mesmo esquema de
// app/api/floor-items/[id]/route.ts, mais simples: sem Storage envolvido
// (parede "padrão" não sobe imagem nenhuma), então o DELETE só apaga a
// linha, sem tentar remover arquivo nenhum.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode editar parede" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data: existing, error: fetchError } = await admin
    .from("room_wall_items")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "parede não encontrada" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corpo inválido" }, { status: 400 });

  const update: Record<string, unknown> = {};

  if (typeof body.label === "string") {
    const label = body.label.trim();
    if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
    update.label = label;
  }
  if ("height_px" in body) {
    const heightPx = typeof body.height_px === "number" && Number.isFinite(body.height_px) ? Math.round(body.height_px) : NaN;
    if (!Number.isFinite(heightPx) || heightPx < 20 || heightPx > 400) {
      return NextResponse.json({ error: "altura da parede precisa ser entre 20 e 400" }, { status: 400 });
    }
    update.height_px = heightPx;
  }
  if ("thickness_px" in body) {
    const thicknessPx = typeof body.thickness_px === "number" && Number.isFinite(body.thickness_px) ? Math.round(body.thickness_px) : NaN;
    if (!Number.isFinite(thicknessPx) || thicknessPx < 1 || thicknessPx > 60) {
      return NextResponse.json({ error: "espessura da parede precisa ser entre 1 e 60" }, { status: 400 });
    }
    update.thickness_px = thicknessPx;
  }
  if ("brick_width_px" in body) {
    const brickWidthPx = typeof body.brick_width_px === "number" && Number.isFinite(body.brick_width_px) ? Math.round(body.brick_width_px) : NaN;
    if (!Number.isFinite(brickWidthPx) || brickWidthPx < 4 || brickWidthPx > 200) {
      return NextResponse.json({ error: "largura do tijolo precisa ser entre 4 e 200" }, { status: 400 });
    }
    update.brick_width_px = brickWidthPx;
  }
  if ("brick_height_px" in body) {
    const brickHeightPx = typeof body.brick_height_px === "number" && Number.isFinite(body.brick_height_px) ? Math.round(body.brick_height_px) : NaN;
    if (!Number.isFinite(brickHeightPx) || brickHeightPx < 4 || brickHeightPx > 100) {
      return NextResponse.json({ error: "altura do tijolo precisa ser entre 4 e 100" }, { status: 400 });
    }
    update.brick_height_px = brickHeightPx;
  }
  if ("mortar_width_px" in body) {
    const mortarWidthPx = typeof body.mortar_width_px === "number" && Number.isFinite(body.mortar_width_px) ? Math.round(body.mortar_width_px) : NaN;
    if (!Number.isFinite(mortarWidthPx) || mortarWidthPx < 0 || mortarWidthPx > 20) {
      return NextResponse.json({ error: "espessura da junta precisa ser entre 0 e 20" }, { status: 400 });
    }
    update.mortar_width_px = mortarWidthPx;
  }
  if (typeof body.brick_color === "string") {
    if (!HEX_COLOR_RE.test(body.brick_color)) return NextResponse.json({ error: "cor do tijolo inválida" }, { status: 400 });
    update.brick_color = body.brick_color;
  }
  if (typeof body.mortar_color === "string") {
    if (!HEX_COLOR_RE.test(body.mortar_color)) return NextResponse.json({ error: "cor da argamassa inválida" }, { status: 400 });
    update.mortar_color = body.mortar_color;
  }
  if (typeof body.top_color === "string") {
    if (!HEX_COLOR_RE.test(body.top_color)) return NextResponse.json({ error: "cor do topo inválida" }, { status: 400 });
    update.top_color = body.top_color;
  }
  // "brick"/"panel" -- ver WallTextureKind em game/wall.ts e o comentário
  // equivalente em ../route.ts (POST).
  if (typeof body.texture_kind === "string") {
    if (body.texture_kind !== "brick" && body.texture_kind !== "panel") {
      return NextResponse.json({ error: "tipo de textura inválido" }, { status: 400 });
    }
    update.texture_kind = body.texture_kind;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await admin.from("room_wall_items").update(update).eq("id", params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode apagar parede" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { error } = await admin.from("room_wall_items").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
