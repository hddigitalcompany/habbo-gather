// Cadastra uma PORTA customizada (Editor de Itens, aba "Criar Porta", ver
// components/ItemEditor.tsx) -- só o admin da plataforma. Mesmo esquema de
// app/api/wall-items/route.ts, mas porta SEMPRE tem imagem (o Douglas
// sobe a arte -- "eu subirei a arte"), nunca um "padrão" desenhado por
// código, então em vez de cor de tijolo/argamassa aqui validamos URL de
// imagem por lado (esq/dir, ver DoorFacing em game/door.ts) x estado
// (aberta/fechada) -- o cliente já subiu os arquivos pro Storage ANTES
// de chamar aqui (mesmo fluxo de "Criar Piso"/"Criar Móvel"), então só
// recebemos as URLs públicas já prontas.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = ["correr-1-folha", "correr-2-folhas"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  if (!(await isPlatformAdmin(callerId))) {
    return NextResponse.json({ error: "só o admin da plataforma pode cadastrar porta" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });

  const kind = typeof body?.kind === "string" ? body.kind : "";
  if (!ALLOWED_KINDS.includes(kind)) {
    return NextResponse.json({ error: "tipo de porta inválido" }, { status: 400 });
  }

  const artLeftClosed = typeof body?.art_left_closed === "string" ? body.art_left_closed : "";
  const artLeftOpen = typeof body?.art_left_open === "string" ? body.art_left_open : "";
  if (!artLeftClosed || !artLeftOpen) {
    return NextResponse.json({ error: "imagem fechada/aberta (lado esquerdo) são obrigatórias" }, { status: 400 });
  }
  // lado direito é OPCIONAL -- sem ele, o jogo cai pro lado esquerdo (ver
  // resolveDoorArt em MainScene.ts), mesmo fallback que facing de móvel
  // já usa.
  const artRightClosed = typeof body?.art_right_closed === "string" ? body.art_right_closed : null;
  const artRightOpen = typeof body?.art_right_open === "string" ? body.art_right_open : null;

  const insert = {
    label,
    kind,
    art_left_closed: artLeftClosed,
    art_left_open: artLeftOpen,
    art_right_closed: artRightClosed,
    art_right_open: artRightOpen,
    created_by: callerId,
  };

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin.from("room_door_items").insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
