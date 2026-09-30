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
//
// Empresa é por ESPAÇO agora (pedido do Douglas, 30/set, ver migration
// 0043_company_verification_per_room.sql -- RODAR NO SQL EDITOR DO
// SUPABASE antes do deploy): "quando a pessoa for verificar a
// empresa, aparece a selecao do espaco que essa empresa esta". Por
// isso o type="company" exige `roomId` no POST (o front lista os
// espaços do dono em `ownedRooms`, ver GET) -- sem CNPJ nenhum, o
// próprio espaço escolhido É a empresa. "um controlador por perfil
// empresarial verificado"/"uma empresa não pode ser verificada em
// dois espaços" ficam travados no BANCO (índice único parcial +
// trigger, ver a migration), não só aqui -- mesmo se um pedido for
// aprovado direto no painel do Supabase (sem passar por código
// nenhum), a trava vale igual.
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const RESERVED_SLUGS = new Set(["mapa-publicado", "mapa-modelo"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15MB -- foto/PDF de documento, folga em cima do que um celular tira

type OwnedRoom = { id: string; slug: string; name: string; companyVerified: boolean };

// mesma query de sempre (era só isPlanGateOk, checando "é dono de
// sala de verdade" como substituto do gate de plano pago) -- agora
// também alimenta o seletor de espaço do bloco "Empresa" (ver GET),
// então devolve os espaços em vez de só um booleano.
async function getOwnedRealRooms(admin: ReturnType<typeof getSupabaseAdminClient>, userId: string): Promise<OwnedRoom[]> {
  if (!admin) return [];
  const { data } = await admin
    .from("rooms")
    .select("id, room_slug, name, company_verified")
    .eq("owner_user_id", userId)
    .eq("is_template", false)
    .not("room_slug", "is", null);
  return (data ?? [])
    .filter((r) => !RESERVED_SLUGS.has(r.room_slug as string))
    .map((r) => ({ id: r.id as string, slug: r.room_slug as string, name: r.name as string, companyVerified: !!r.company_verified }));
}

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const [{ data: requests, error }, { data: profile }, ownedRooms] = await Promise.all([
    admin
      .from("verification_requests")
      .select("id, type, status, created_at, room_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    admin.from("profiles").select("verified_personal, verified_company").eq("id", userId).maybeSingle(),
    getOwnedRealRooms(admin, userId),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    eligible: ownedRooms.length > 0,
    verifiedPersonal: profile?.verified_personal ?? false,
    verifiedCompany: profile?.verified_company ?? false,
    ownedRooms,
    requests: (requests ?? []).map((r) => ({ id: r.id, type: r.type, status: r.status, createdAt: r.created_at, roomId: r.room_id })),
  });
}

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const ownedRooms = await getOwnedRealRooms(admin, userId);
  if (ownedRooms.length === 0) {
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

  // Empresa é por ESPAÇO (ver comentário grande no topo do arquivo) --
  // a pessoa escolhe QUAL dos espaços dela é essa empresa; só pode
  // escolher um espaço que ela realmente é dona (confere de novo aqui,
  // não confia em nada que o front mandou além do id).
  let roomId: string | null = null;
  if (type === "company") {
    const roomIdRaw = form.get("roomId");
    const owned = typeof roomIdRaw === "string" ? ownedRooms.find((r) => r.id === roomIdRaw) : undefined;
    if (!owned) {
      return NextResponse.json({ error: "Selecione um espaço seu pra verificar." }, { status: 400 });
    }
    if (owned.companyVerified) {
      return NextResponse.json({ error: "Esse espaço já tem o selo de empresa verificado." }, { status: 409 });
    }
    roomId = owned.id;
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "arquivo é obrigatório" }, { status: 400 });
  if (file.size > MAX_DOC_BYTES) return NextResponse.json({ error: "arquivo muito grande (máx 15MB)" }, { status: 413 });

  // já tem um pedido PENDENTE? não deixa duplicar -- evita a pessoa
  // mandar 5 fotos diferentes enquanto o Douglas ainda nem olhou a
  // primeira. "personal" continua 1 pedido pendente por CONTA; "company"
  // agora é 1 pedido pendente por ESPAÇO (a mesma conta pode ter um
  // pedido pendente por sala diferente que ela é dona, mas não dois
  // pro mesmo espaço).
  let pendingQuery = admin.from("verification_requests").select("id").eq("user_id", userId).eq("type", type).eq("status", "pending");
  pendingQuery = type === "company" ? pendingQuery.eq("room_id", roomId as string) : pendingQuery;
  const { data: existingPending } = await pendingQuery.maybeSingle();
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
    .insert({ user_id: userId, type, doc_path: docPath, room_id: roomId })
    .select("id, type, status, created_at, room_id")
    .single();
  if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 500 });

  return NextResponse.json({
    request: {
      id: inserted.data.id,
      type: inserted.data.type,
      status: inserted.data.status,
      createdAt: inserted.data.created_at,
      roomId: inserted.data.room_id,
    },
  });
}
