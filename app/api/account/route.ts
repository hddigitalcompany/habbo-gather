// GET/POST /api/account -- "Dados da conta" (pedido do Douglas, 30/set:
// "Dados da conta: nome completo, cpf, data de nascimento, email da
// conta, senha, alterar senha") -- nome completo/CPF/nascimento moram
// em public.account_private (NÃO em public.profiles, que tem leitura
// aberta pra qualquer logado, ver comentário grande na migration
// 0041_account_and_verification.sql -- RODAR NO SQL EDITOR DO SUPABASE
// antes do deploy, senão essa tabela não existe ainda). Email/senha
// não passam por aqui -- email/senha são geridos pelo próprio
// Supabase Auth, trocados direto do navegador via
// supabase.auth.updateUser (ver AccountCard.tsx), essa rota só cuida
// dos 3 campos que não têm lugar nenhum no Auth.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const { data, error } = await admin
    .from("account_private")
    .select("full_name, cpf, birthdate")
    .eq("id", userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    account: {
      fullName: data?.full_name ?? "",
      cpf: data?.cpf ?? "",
      birthdate: data?.birthdate ?? "",
    },
  });
}

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim().slice(0, 150) : "";
  // só dígitos (aceita a pessoa digitar com pontuação, "123.456.789-00",
  // mas guarda limpo -- mesma ideia de sempre desse app de normalizar
  // no servidor em vez de confiar no formato que o cliente mandou).
  const cpf = typeof body?.cpf === "string" ? body.cpf.replace(/\D/g, "").slice(0, 11) : "";
  const birthdate = typeof body?.birthdate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.birthdate) ? body.birthdate : null;

  const { error } = await admin.from("account_private").upsert({
    id: userId,
    full_name: fullName,
    cpf,
    birthdate,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    // "só pode haver uma conta por cpf" (pedido do Douglas, 30/set) --
    // barrado no banco por um índice único parcial (ver migration
    // 0042_account_cpf_unique.sql). Código 23505 = unique_violation
    // (padrão do Postgres) -- mensagem amigável em vez do erro cru do
    // banco ("duplicate key value violates unique constraint...").
    if (error.code === "23505") {
      return NextResponse.json({ error: "Esse CPF já está cadastrado em outra conta." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
