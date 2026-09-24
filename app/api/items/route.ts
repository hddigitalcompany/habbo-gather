// Cadastra um item de móvel CUSTOM (Editor de Itens, ver
// components/ItemEditor.tsx) -- só o dono da sala pode. A IMAGEM em si
// já foi enviada direto do navegador pro Supabase Storage (bucket
// "room-items", ver supabase/migrations/0002_room_items.sql) ANTES
// dessa chamada -- aqui só grava os metadados (nome/categoria/URLs)
// depois de conferir de novo que quem pediu é owner (defesa em
// profundidade, mesmo padrão de app/api/room/members).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["poltrona", "divisoria", "sofa", "mesa", "planta", "computador"];
const ALLOWED_DIRECTIONS = ["down", "left", "right", "up"];

export async function POST(req: NextRequest) {
  const callerId = await getVerifiedUserId(req);
  if (!callerId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  await bootstrapOwnerIfEmpty(callerId);
  const membership = await getMembership(callerId);
  if (membership?.role !== "owner" || membership.status !== "active") {
    return NextResponse.json({ error: "só o dono da sala pode cadastrar item" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const art = body?.art && typeof body.art === "object" ? (body.art as Record<string, unknown>) : null;

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }
  if (!art || typeof art.down !== "string" || !art.down) {
    return NextResponse.json({ error: "imagem de frente é obrigatória" }, { status: 400 });
  }
  const cleanArt: Record<string, string> = {};
  for (const dir of ALLOWED_DIRECTIONS) {
    const value = art[dir];
    if (typeof value === "string" && value) cleanArt[dir] = value;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("room_items")
    .insert({ label, category, art: cleanArt, created_by: callerId })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
