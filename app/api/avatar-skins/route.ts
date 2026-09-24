// Cadastra um TOM DE PELE custom (Editor de Itens, botão "Criar Avatar" --
// ver components/ItemEditor.tsx). A FOLHA já composta (8x2/200x260, ver
// composeSkinSheet em ItemEditor.tsx) já foi enviada direto do navegador
// pro Supabase Storage (bucket "room-items", path "avatar-skins/...",
// REUSA o bucket que supabase/migrations/0002_room_items.sql já criou --
// ver 0005_avatar_skins.sql) ANTES dessa chamada -- aqui só grava os
// metadados (nome/sexo/URL/hex) depois de conferir de novo que quem
// pediu é owner (defesa em profundidade, mesmo padrão de app/api/items).
//
// Sem PATCH/DELETE por enquanto (editar/apagar tom custom ainda não tem
// UI -- diferente do móvel, que já ganhou isso -- fica pra depois se o
// Douglas pedir).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_GENDERS = ["masculino", "feminino"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar tom de pele" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const gender = typeof body?.gender === "string" ? body.gender : "";
  const sheetUrl = typeof body?.sheetUrl === "string" ? body.sheetUrl : "";
  // hex opcional (cor do botão seletor, ver skin-swatch em GameRoom.tsx)
  // -- sem valor, cai no fallback cinza neutro de sempre (mesmo esquema
  // dos tons "de fábrica" sem hex, ver SKIN_HEX_BY_NAME em
  // scripts/syncSkinAssets.mjs).
  const rawHex = typeof body?.hex === "string" ? body.hex.trim() : "";
  const hex = /^#[0-9a-fA-F]{6}$/.test(rawHex) ? rawHex : null;

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_GENDERS.includes(gender)) {
    return NextResponse.json({ error: "sexo inválido" }, { status: 400 });
  }
  if (!sheetUrl) return NextResponse.json({ error: "imagem é obrigatória" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("avatar_skins")
    .insert({
      label,
      gender,
      sheet_url: sheetUrl,
      hex,
      created_by: callerId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ skin: data });
}
