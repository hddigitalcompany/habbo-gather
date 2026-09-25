// Apaga um TOM DE PELE custom -- só o dono. Pedido do Douglas: "deixar
// apenas branco/pardo/negro" na lista "Tons cadastrados" (tinha entrada
// com nome errado "Ela" e "Pardo" duplicado -- feminino e masculino
// separados -- de teste antigo). Mesmo padrão de
// app/api/avatar-items/[id]/route.ts DELETE (owner-check, apaga o
// arquivo no Storage por melhor esforço, depois a linha).
//
// PATCH aceita DOIS usos, no mesmo corpo (mistura os campos que vierem
// -- não precisa escolher um dos dois), mesmo esquema de
// app/api/avatar-items/[id]/route.ts:
//  1) `colors` -- "adicionar cores pra avatar tambem" (pedido do
//     Douglas, mesma ferramenta -- ColorZoneTool.tsx -- que já existia
//     pra cabelo/acessório/traje, agora reaproveitada aqui via prop
//     apiBase="avatar-skins") -- grava o array de variantes de cor
//     GERADAS por cima do tom já cadastrado (ver game/colorTint.ts).
//  2) label/gender/hex/sheetUrl -- "Editar" na lista de cadastrados
//     (pedido do Douglas: "quero editar o Avatar tambem", continuação
//     de "quero editar as coisas ja criadas, fotos etc" que já cobria
//     cabelo/acessório/barba/traje) -- a folha (sheetUrl) já chega
//     PRONTA do navegador (composeAvatarArtSheet em ItemEditor.tsx já
//     mescla a arte nova com a antiga direção a direção, ver
//     `fallback` lá), então aqui é só trocar a URL inteira. Apaga
//     (melhor esforço) o arquivo ANTIGO no Storage quando a URL muda.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

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

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode editar tom de pele" }, { status: 403 });
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

  // "Editar" (nome/sexo/cor do botão/foto) -- pedido do Douglas: "quero
  // editar o Avatar tambem". Mesma validação do POST em
  // app/api/avatar-skins/route.ts.
  if (typeof body.label === "string") {
    const label = body.label.trim();
    if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
    update.label = label;
  }
  if (typeof body.gender === "string") {
    if (!ALLOWED_GENDERS.includes(body.gender)) {
      return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
    }
    update.gender = body.gender;
  }
  if ("hex" in body) {
    // mesma validação do POST em app/api/avatar-skins/route.ts -- hex
    // fora do formato (ou ausente/vazio) cai pro fallback null de
    // sempre, em vez de rejeitar o PATCH inteiro por causa de um campo
    // opcional.
    const rawHex = typeof body.hex === "string" ? body.hex.trim() : "";
    update.hex = /^#[0-9a-fA-F]{6}$/.test(rawHex) ? rawHex : null;
  }

  let oldSheetUrl: string | null = null;
  if (typeof body.sheetUrl === "string" && body.sheetUrl) {
    const { data: existing } = await admin
      .from("avatar_skins")
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
    .from("avatar_skins")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // arquivo antigo virou lixo órfão (foi TROCADO por um novo, não
  // referenciado por mais nenhuma linha) -- apaga por melhor esforço,
  // depois de confirmar que a troca salvou.
  if ("sheet_url" in update && oldSheetUrl) {
    const oldPath = storagePathFromPublicUrl(oldSheetUrl, "room-items");
    if (oldPath) await admin.storage.from("room-items").remove([oldPath]).catch(() => null);
  }

  return NextResponse.json({ skin: data });
}
