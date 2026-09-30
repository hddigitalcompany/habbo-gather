// GET/POST /api/account/verification -- "Selo de verificação" (pedido
// do Douglas, 30/set): "ativar selo de verificado, pessoal e empresa,
// essa opcao vai estar disponivel pra preencher/ativar, apenas se a
// pessoa paga algum plano em uma sala ... ele tem que enviar foto
// segurando doc pra analise, e na empresa, tem que enviar o contrato
// social da empresa constando ele como socio".
//
// GATE ("paga algum plano em uma sala"): esse app ainda NÃO tem
// sistema de plano/assinatura nenhum (sem tabela de plano, sem
// Stripe, nada) -- construir isso é um projeto à parte. Até existir,
// uso "é dono de uma sala própria de verdade" (mesma regra de
// myRealRoom em Lobby.tsx/GET /api/room/mine) como um substituto
// temporário -- é o sinal mais próximo que existe hoje de "é cliente
// pagante" nessa plataforma. Trocar esse trecho (isPlanGateOk) assim
// que o sistema de plano de verdade existir.
//
// Upload do documento NUNCA direto do navegador -- sempre por aqui
// (service role), gravado no bucket PRIVADO "verification-docs" (ver
// migration 0041_account_and_verification.sql -- RODAR NO SQL EDITOR
// DO SUPABASE antes do deploy). Aprovação (status pending -> approved/
// rejected) ainda não tem tela dentro do app -- é manual, direto na
// tabela verification_requests pelo painel do Supabase (mesmo aviso
// da migration).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const RESERVED_SLUGS = new Set(["sala-principal", "mapa-modelo"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15MB -- foto/PDF de documento, folga em cima do que um celular tira

async function isPlanGateOk(admin: ReturnType<typeof getSupabaseAdminClient>, userId: string): Promise<boolean> {
  if (!admin) return false;
  const { data } = await admin
    .from("rooms")
    .select("room_slug")
    .eq("owner_user_id", userId)
    .eq("is_template", false)
    .not("room_slug", "is", null);
  return (data ?? []).some((r) => !RESERVED_SLUGS.has(r.room_slug as string));
}

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const [{ data: requests, error }, { data: profile }, eligible] = await Promise.all([
    admin
      .from("verification_requests")
      .select("id, type, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    admin.from("profiles").select("verified_personal, verified_company").eq("id", userId).maybeSingle(),
    isPlanGateOk(admin, userId),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    eligible,
    verifiedPersonal: profile?.verified_personal ?? false,
    verifiedCompany: profile?.verified_company ?? false,
    requests: (requests ?? []).map((r) => ({ id: r.id, type: r.type, status: r.status, createdAt: r.created_at })),
  });
}

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  if (!(await isPlanGateOk(admin, userId))) {
    return NextResponse.json(
      { error: "Selo de verificação só fica disponível pra quem tem um plano pago em alguma sala." },
      { status: 403 }
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "corpo inválido" }, { status: 400 });

  const type = form.get("type");
  if (type !== "personal" && type !== "company") {
    return NextResponse.json({ error: '"type" precisa ser "personal" ou "company"' }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "arquivo é obrigatório" }, { status: 400 });
  if (file.size > MAX_DOC_BYTES) return NextResponse.json({ error: "arquivo muito grande (máx 15MB)" }, { status: 413 });

  // já tem um pedido PENDENTE desse mesmo tipo? não deixa duplicar --
  // evita a pessoa mandar 5 fotos diferentes enquanto o Douglas ainda
  // nem olhou a primeira.
  const { data: existingPending } = await admin
    .from("verification_requests")
    .select("id")
    .eq("user_id", userId)
    .eq("type", type)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    return NextResponse.json({ error: "Você já tem um pedido em análise desse tipo." }, { status: 409 });
  }

  const ext = (file.name.split(".").pop() || "jpg").slice(0, 8);
  const docPath = `${type}/${userId}/${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const uploaded = await admin.storage
    .from("verification-docs")
    .upload(docPath, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploaded.error) return NextResponse.json({ error: uploaded.error.message }, { status: 500 });

  const inserted = await admin
    .from("verification_requests")
    .insert({ user_id: userId, type, doc_path: docPath })
    .select("id, type, status, created_at")
    .single();
  if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 500 });

  return NextResponse.json({
    request: {
      id: inserted.data.id,
      type: inserted.data.type,
      status: inserted.data.status,
      createdAt: inserted.data.created_at,
    },
  });
}
