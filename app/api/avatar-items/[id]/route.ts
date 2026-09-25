// Apaga OU atualiza um item de avatar CUSTOM (cabelo/acessório/barba/
// traje) -- só o dono. Pedido do Douglas: "faz assim, coloca la nos
// itens eles pra eu apagar por la" (em vez de rodar `delete from
// avatar_items;` na mão, depois de eu ter tirado o cabelo/barba/
// acessório/traje "de fábrica" do catálogo -- ver customization.ts --
// e sobrarem os itens CUSTOM que ele já tinha subido de teste, ver
// fetchAndRegisterCustomAvatarItems em GameRoom.tsx). Mesmo padrão de
// app/api/items/[id]/route.ts DELETE (owner-check, apaga o arquivo no
// Storage por melhor esforço, depois a linha) -- só que aqui é 1
// arquivo só (sheet_url) em vez de art{}+ícone.
//
// PATCH aceita DOIS usos, no mesmo corpo (mistura os campos que vierem
// -- não precisa escolher um dos dois):
//  1) `colors` -- "cria essa ferramenta por seleção" (pedido do
//     Douglas, depois dele recusar máscara fixa por coordenada E
//     redesenhar cada peça à mão) -- grava o array de variantes de cor
//     GERADAS pelo ColorZoneTool.tsx (ver game/colorTint.ts).
//  2) category/gender/label/skinIds/sheetUrl -- "Editar" na lista de
//     cadastrados (pedido do Douglas: "quero editar as coisas ja
//     criadas, fotos etc") -- mesmo padrão de app/api/items/[id]/
//     route.ts, só que a folha (sheetUrl) já chega PRONTA do navegador
//     (composeAvatarArtSheet/composeAvatarArtSheetMultiPose em
//     ItemEditor.tsx já mesclam a arte nova com a antiga direção a
//     direção -- ver `fallback` nas duas funções -- então aqui é só
//     trocar a URL inteira, sem merge por campo como o de room_items).
//     Apaga (melhor esforço) o arquivo ANTIGO no Storage quando a URL
//     muda, senão vira lixo órfão no bucket.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["cabelo", "acessorio", "barba", "traje"];
const ALLOWED_GENDERS = ["masculino", "feminino"];

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

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode editar item de avatar" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "corpo inválido" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const update: Record<string, unknown> = {};

  // `colors` -- ver ColorZoneTool.tsx, formato de ColorOption em
  // game/customization.ts (id/label/file obrigatórios, hex opcional).
  if ("colors" in body) {
    const colors = Array.isArray(body.colors) ? body.colors : null;
    if (!colors) return NextResponse.json({ error: "colors precisa ser um array" }, { status: 400 });
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
    update.colors = colors;
  }

  // "Editar" (nome/sexo/categoria/tons/foto) -- pedido do Douglas:
  // "quero editar as coisas ja criadas, fotos etc". Mesma
  // validação do POST em app/api/avatar-items/route.ts.
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
  if (typeof body.gender === "string") {
    if (!ALLOWED_GENDERS.includes(body.gender)) {
      return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
    }
    update.gender = body.gender;
  }
  if (Array.isArray(body.skinIds)) {
    update.skin_ids = body.skinIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  }

  let oldSheetUrl: string | null = null;
  if (typeof body.sheetUrl === "string" && body.sheetUrl) {
    const { data: existing } = await admin
      .from("avatar_items")
      .select("sheet_url")
      .eq("id", params.id)
      .maybeSingle();
    oldSheetUrl = (existing?.sheet_url as string | null) ?? null;
    if (oldSheetUrl !== body.sheetUrl) update.sheet_url = body.sheetUrl;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada pra atualizar" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("avatar_items")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // arquivo antigo virou lixo órfão (foi TROCADO por um novo, não
  // referenciado por mais nenhuma linha) -- apaga por melhor esforço,
  // depois de confirmar que a troca salvou (nunca antes -- se o update
  // falhar, o registro continua apontando pro arquivo antigo).
  if ("sheet_url" in update && oldSheetUrl) {
    const oldPath = storagePathFromPublicUrl(oldSheetUrl, "room-items");
    if (oldPath) await admin.storage.from("room-items").remove([oldPath]).catch(() => null);
  }

  return NextResponse.json({ item: data });
}
