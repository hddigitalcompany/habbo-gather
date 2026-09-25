// Cadastra um item de avatar CUSTOM -- cabelo, acessório, barba ou
// traje (Editor de Itens, botão "Criar Avatar" > categoria
// correspondente -- ver AvatarCreatorPanel em components/ItemEditor.tsx).
// Continuação de app/api/avatar-skins/route.ts (que só cobre TOM DE
// PELE/"Avatar") -- mesmo padrão de auth (getVerifiedUserId +
// bootstrapOwnerIfEmpty + getMembership owner-check), mesmo esquema de
// upload (a FOLHA já composta -- 8x2/200x260, ver composeAvatarArtSheet
// em ItemEditor.tsx -- já foi enviada direto do navegador pro Supabase
// Storage, bucket "room-items", path "avatar-items/...", REUSA o
// bucket que 0002_room_items.sql já criou, ver 0006_avatar_items.sql --
// ANTES dessa chamada, aqui só grava os metadados). PATCH (editar/
// gerar cor) e DELETE (apagar) ficam em app/api/avatar-items/[id]/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["cabelo", "acessorio", "barba", "traje"];
const ALLOWED_GENDERS = ["masculino", "feminino"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar item de avatar" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const category = typeof body?.category === "string" ? body.category : "";
  const gender = typeof body?.gender === "string" ? body.gender : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const sheetUrl = typeof body?.sheetUrl === "string" ? body.sheetUrl : "";
  // skinIds: opcional (cabelo/acessório não usam, ver comentário na
  // migration) -- quando vem, filtra só string não-vazia, sem limite de
  // tamanho (o Editor de Itens já limita às opções que existem pro sexo
  // escolhido).
  const rawSkinIds = Array.isArray(body?.skinIds) ? body.skinIds : [];
  const skinIds = rawSkinIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }
  if (!ALLOWED_GENDERS.includes(gender)) {
    return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
  }
  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!sheetUrl) return NextResponse.json({ error: "imagem é obrigatória" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("avatar_items")
    .insert({
      category,
      gender,
      label,
      skin_ids: skinIds,
      sheet_url: sheetUrl,
      created_by: callerId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
