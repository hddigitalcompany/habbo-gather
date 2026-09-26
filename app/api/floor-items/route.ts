// Cadastra um modelo de PISO customizado (Editor de Itens, aba "Criar
// Piso", ver components/ItemEditor.tsx) -- só o dono da sala pode.
// Mesmo esquema de app/api/items/route.ts (móvel), bem mais simples:
// piso não tem direção/footprint/assento/interação, é só uma imagem
// PLANA (já subiu pro Storage ANTES dessa chamada, direto do navegador
// -- ver handleFloorSubmit em ItemEditor.tsx) + categoria + nome.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { bootstrapOwnerIfEmpty, getMembership, getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const ALLOWED_CATEGORIES = ["porcelanato", "laminado", "natural"];

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
  const fileUrl = typeof body?.file_url === "string" ? body.file_url : "";

  if (!label) return NextResponse.json({ error: "nome é obrigatório" }, { status: 400 });
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "categoria inválida" }, { status: 400 });
  }
  if (!fileUrl) return NextResponse.json({ error: "imagem é obrigatória" }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("room_floor_items")
    .insert({
      label,
      category,
      file_url: fileUrl,
      created_by: callerId,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ item: data });
}
