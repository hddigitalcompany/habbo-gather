// Cadastra um PADRÃO de parede de sistema customizado (Editor de Itens,
// aba "Criar Parede", ver components/ItemEditor.tsx -- WallPatternCreatorPanel)
// -- só o admin da plataforma. Mesmo esquema de app/api/floor-items/route.ts,
// mais simples ainda: parede "padrão" não tem categoria, só o painel de
// tijolo + espessura (ver WallPatternConfig em game/wall.ts) -- e não
// existe kind "image" aqui (parede com arte continua vindo só da pasta
// local, ver scripts/syncWallAssets.mjs).
//
// Espessura adicionada depois do Douglas testar ao vivo a primeira
// versão (folha 2D encostada na linha da divisa): "voce ficou ela na
// divisa, eu quero ela no meio do tile... com espessura de parede,
// inclusive quero editar isso na criacao" (ver supabase/migrations/
// 0026_room_wall_items_thickness_brick.sql) -- o tijolo continua igual.
// top_color teve ida e volta (0027 criou, 0028 reverteu, ver esses
// arquivos) -- voltou em 0029_room_wall_items_top_color_v2.sql com
// escopo mais estreito: só controla a face de CIMA/topo (plana); a
// face de PONTA/lateral (espessura vertical) continua CALCULADA a
// partir de brick_color, sem campo próprio -- ver
// createWallPatternGraphics em MainScene.ts e o comentário grande de
// WallPatternConfig em game/wall.ts pro histórico completo.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode cadastrar parede" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });

  const heightPx = typeof body?.height_px === "number" && Number.isFinite(body.height_px) ? Math.round(body.height_px) : NaN;
  const thicknessPx = typeof body?.thickness_px === "number" && Number.isFinite(body.thickness_px) ? Math.round(body.thickness_px) : NaN;
  const brickWidthPx = typeof body?.brick_width_px === "number" && Number.isFinite(body.brick_width_px) ? Math.round(body.brick_width_px) : NaN;
  const brickHeightPx = typeof body?.brick_height_px === "number" && Number.isFinite(body.brick_height_px) ? Math.round(body.brick_height_px) : NaN;
  const mortarWidthPx = typeof body?.mortar_width_px === "number" && Number.isFinite(body.mortar_width_px) ? Math.round(body.mortar_width_px) : NaN;
  const brickColor = typeof body?.brick_color === "string" ? body.brick_color : "";
  const mortarColor = typeof body?.mortar_color === "string" ? body.mortar_color : "";
  const topColor = typeof body?.top_color === "string" ? body.top_color : "";
  // "brick" (padrão, tijolo de sempre) ou "panel" (ripas horizontais --
  // ver WallTextureKind em game/wall.ts). Ausente/inválido -> "brick",
  // igual ao default da coluna (texture_kind, ver
  // supabase/migrations/0050_room_wall_items_texture_kind.sql), então
  // nenhum chamador antigo (que não manda esse campo) quebra.
  const textureKind = body?.texture_kind === "panel" ? "panel" : "brick";

  if (!Number.isFinite(heightPx) || heightPx < 20 || heightPx > 400) {
    return NextResponse.json({ error: "altura da parede precisa ser entre 20 e 400" }, { status: 400 });
  }
  if (!Number.isFinite(thicknessPx) || thicknessPx < 1 || thicknessPx > 60) {
    return NextResponse.json({ error: "espessura da parede precisa ser entre 1 e 60" }, { status: 400 });
  }
  if (!Number.isFinite(brickWidthPx) || brickWidthPx < 4 || brickWidthPx > 200) {
    return NextResponse.json({ error: "largura do tijolo precisa ser entre 4 e 200" }, { status: 400 });
  }
  if (!Number.isFinite(brickHeightPx) || brickHeightPx < 4 || brickHeightPx > 100) {
    return NextResponse.json({ error: "altura do tijolo precisa ser entre 4 e 100" }, { status: 400 });
  }
  if (!Number.isFinite(mortarWidthPx) || mortarWidthPx < 0 || mortarWidthPx > 20) {
    return NextResponse.json({ error: "espessura da junta precisa ser entre 0 e 20" }, { status: 400 });
  }
  if (!HEX_COLOR_RE.test(brickColor) || !HEX_COLOR_RE.test(mortarColor) || !HEX_COLOR_RE.test(topColor)) {
    return NextResponse.json({ error: "cor do tijolo, da argamassa e do topo são obrigatórias" }, { status: 400 });
  }

  const insert = {
    label,
    height_px: heightPx,
    thickness_px: thicknessPx,
    brick_width_px: brickWidthPx,
    brick_height_px: brickHeightPx,
    brick_color: brickColor,
    mortar_color: mortarColor,
    mortar_width_px: mortarWidthPx,
    top_color: topColor,
    texture_kind: textureKind,
    created_by: callerId,
  };

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin.from("room_wall_items").insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
