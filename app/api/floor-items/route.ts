// Cadastra um modelo de PISO customizado (Editor de Itens, aba "Criar
// Piso", ver components/ItemEditor.tsx) -- só o dono da sala pode.
// Mesmo esquema de app/api/items/route.ts (móvel), bem mais simples:
// piso não tem direção/footprint/assento/interação.
//
// Dois "kind" (ver supabase/migrations/0016_room_floor_items_pattern.sql
// e FloorCatalogEntry em game/floor.ts): "image" (de sempre -- uma
// imagem PLANA, já subiu pro Storage ANTES dessa chamada, direto do
// navegador, ver handleFloorSubmit em ItemEditor.tsx) ou "pattern"
// (pedido do Douglas: "criamos ali dentro uma forma de preenchimento de
// linhas... nao precise ser imagem mesmo" -- sem arquivo nenhum, só
// largura da ripa + 2 cores, desenhado por código, ver
// createFloorPatternGraphics em game/MainScene.ts).
//
// plank_length_px/line_color/colors (ver supabase/migrations/
// 0017_room_floor_items_plank.sql) são OPCIONAIS, só pro kind
// "pattern": tábua emendada com linha de junta e/ou paleta de várias
// cores. Correção do Douglas depois que eu cadastrei isso hard-coded
// com cores chutadas: "eu nao defini as cores, so mandei exemplo,
// quero criar eles el criar piso" -- agora é tudo por aqui, com as
// cores que ELE escolher no formulário.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["porcelanato", "laminado", "natural"];
const ALLOWED_KINDS = ["image", "pattern"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Valida um array de cores hex ("#rrggbb") opcional -- 2 a 6 cores,
 * cada uma no formato certo. Devolve o array validado, ou lança um erro
 * de validação (mensagem em português, pra devolver direto no 400) se
 * vier preenchido mas fora do formato esperado. `undefined`/array vazio
 * não é erro -- a paleta é opcional. */
function parseColorsField(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length < 2 || value.length > 6) {
    throw new Error("a paleta de cores precisa ter entre 2 e 6 cores");
  }
  for (const c of value) {
    if (typeof c !== "string" || !HEX_COLOR_RE.test(c)) {
      throw new Error("cor inválida na paleta");
    }
  }
  return value as string[];
}

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar piso" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const kind = typeof body?.kind === "string" && ALLOWED_KINDS.includes(body.kind) ? body.kind : "image";

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }

  const insert: Record<string, unknown> = { label, category, kind, created_by: callerId };

  if (kind === "pattern") {
    const plankWidthPx = typeof body?.plank_width_px === "number" && Number.isFinite(body.plank_width_px) ? Math.round(body.plank_width_px) : NaN;
    const colorA = typeof body?.color_a === "string" ? body.color_a : "";
    const colorB = typeof body?.color_b === "string" ? body.color_b : "";
    if (!Number.isFinite(plankWidthPx) || plankWidthPx < 4 || plankWidthPx > 200) {
      return NextResponse.json({ error: "largura da ripa precisa ser entre 4 e 200" }, { status: 400 });
    }
    if (!HEX_COLOR_RE.test(colorA) || !HEX_COLOR_RE.test(colorB)) {
      return NextResponse.json({ error: "as duas cores da ripa são obrigatórias" }, { status: 400 });
    }
    insert.plank_width_px = plankWidthPx;
    insert.color_a = colorA;
    insert.color_b = colorB;

    // comprimento da tábua (opcional -- sem isso, ripa contínua sem
    // junta, comportamento de sempre, ver FloorPatternConfig.plankLengthPx
    // em game/floor.ts).
    if (body?.plank_length_px !== undefined && body?.plank_length_px !== null && body?.plank_length_px !== "") {
      const plankLengthPx = typeof body.plank_length_px === "number" && Number.isFinite(body.plank_length_px) ? Math.round(body.plank_length_px) : NaN;
      if (!Number.isFinite(plankLengthPx) || plankLengthPx < 4 || plankLengthPx > 400) {
        return NextResponse.json({ error: "comprimento da tábua precisa ser entre 4 e 400" }, { status: 400 });
      }
      insert.plank_length_px = plankLengthPx;
    }
    // cor da linha de junta (opcional -- só faz sentido junto com
    // plank_length_px, mas não é obrigatório: sem ela, o jogo calcula
    // uma variação escura de color_a sozinho).
    if (typeof body?.line_color === "string" && body.line_color) {
      if (!HEX_COLOR_RE.test(body.line_color)) {
        return NextResponse.json({ error: "cor da linha de junta inválida" }, { status: 400 });
      }
      insert.line_color = body.line_color;
    }
    // paleta de várias cores (opcional -- "Tábua Mesclada", ver
    // FloorPatternConfig.colors em game/floor.ts).
    try {
      const colors = parseColorsField(body?.colors);
      if (colors) insert.colors = colors;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "paleta de cores inválida" }, { status: 400 });
    }
    // veios de madeira (opcional -- "efeito laminado", ver
    // supabase/migrations/0018_room_floor_items_wood_grain.sql e
    // FloorPatternConfig.woodGrain em game/floor.ts). Só booleano, sem
    // validação extra -- qualquer coisa "truthy" no corpo vira true.
    if (typeof body?.wood_grain === "boolean") insert.wood_grain = body.wood_grain;
    // veios de mármore + emenda alinhada à grade (opcional --
    // "porcelanato... do tamanho do tile... efeito de porcelanato
    // marmorado", ver supabase/migrations/0019_room_floor_items_marble.sql
    // e FloorPatternConfig.marble/tileAligned em game/floor.ts). Mesmo
    // padrão do wood_grain acima -- só booleano, sem validação extra.
    if (typeof body?.marble === "boolean") insert.marble = body.marble;
    if (typeof body?.tile_aligned === "boolean") insert.tile_aligned = body.tile_aligned;
  } else {
    const fileUrl = typeof body?.file_url === "string" ? body.file_url : "";
    if (!fileUrl) return NextResponse.json({ error: "imagem é obrigatória" }, { status: 400 });
    insert.file_url = fileUrl;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin.from("room_floor_items").insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
