// Confere quem é o dono de verdade de um token de acesso do Supabase
// (mandado pelo cliente na mensagem "identify", ver accountAccessToken
// em components/GameRoom.tsx/AuthGate.tsx) -- SEM isso, esse servidor
// confiava cegamente no userId que o cliente mandava (dava pra mandar
// qualquer string, inclusive o id de outra pessoa, e "virar" ela pro
// resto da sala). Com conta de verdade, o userId "oficial" de quem
// mandou um token válido passa a ser o auth.users.id confirmado aqui
// -- ver o case "identify" em index.js.
//
// Sem NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configurados
// no ambiente desse processo (ver .env.local.example -- e lembrando
// que esse servidor NÃO é o Next.js, então precisa ter essas variáveis
// exportadas pra ele também, não só pro `next dev`), essa verificação
// simplesmente não roda: identify sempre confia no userId que o
// cliente mandou, exatamente como sempre foi (visitante anônimo) --
// não trava ninguém enquanto o Douglas não tiver criado o projeto.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

export function isAccountsConfigured() {
  return Boolean(admin);
}

/**
 * Devolve o userId (auth.users.id) de verdade dono desse token, ou
 * null se o token não veio, é inválido, expirou, ou o Supabase ainda
 * não tá configurado nesse processo -- em qualquer desses casos quem
 * chamou deve cair pro comportamento de visitante anônimo de sempre
 * (confiar no userId que o cliente mandou), nunca travar a conexão.
 */
export async function verifyAccessToken(accessToken) {
  if (!admin || typeof accessToken !== "string" || !accessToken.trim()) return null;
  try {
    const { data, error } = await admin.auth.getUser(accessToken);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

// ids de quem é membro ATIVO da sala (role owner/member, status
// active -- ver room_members em supabase/migrations/0001_accounts.sql)
// -- usado pra contar membro x visitante (ver GET /room/presence e
// handleGetPresence em index.js). Cacheado por MEMBER_CACHE_TTL_MS pra
// não bater no Supabase a cada "identify"/reconexão -- então promover/
// banir alguém pela área de configuração (ver app/api/room/members)
// pode demorar até esse tanto pra refletir na contagem AO VIVO da
// sala (o resultado de promover/banir em si é instantâneo, só a
// contagem que atrasa um pouco -- aceitável pra um contador, não pra
// permissão de verdade).
const MEMBER_CACHE_TTL_MS = 10_000;
let memberIdCache = { ids: new Set(), fetchedAt: 0 };

export async function getActiveMemberIds() {
  if (!admin) return new Set();
  const now = Date.now();
  if (now - memberIdCache.fetchedAt < MEMBER_CACHE_TTL_MS) return memberIdCache.ids;
  try {
    const { data, error } = await admin.from("room_members").select("user_id").eq("status", "active");
    if (error) return memberIdCache.ids; // mantém o cache antigo num erro passageiro, não zera a contagem
    memberIdCache = { ids: new Set((data ?? []).map((r) => r.user_id)), fetchedAt: now };
  } catch {
    // mantém o cache antigo
  }
  return memberIdCache.ids;
}

/**
 * Confere na hora (SEM cache -- diferente de getActiveMemberIds, isso
 * aqui é permissão de verdade, não só um contador, então não pode
 * atrasar) se esse userId tá banido da sala (ver ação "ban" em
 * app/api/room/members/route.ts). Chamado só no "identify" (uma vez
 * por conexão), então o custo extra de bater direto no Supabase é
 * aceitável.
 */
export async function isBanned(userId) {
  if (!admin || !userId) return false;
  try {
    const { data } = await admin.from("room_members").select("status").eq("user_id", userId).maybeSingle();
    return data?.status === "banned";
  } catch {
    return false;
  }
}

/**
 * "owner" | "member" | "banned" | "visitor" (nunca foi adicionado) --
 * usado só pra decidir se quem pediu GET /room/presence?detail=1 pode
 * ver a lista de visitante online (ver handleGetPresence em index.js).
 * SEM cache, de propósito -- é decisão de acesso, não contador.
 */
export async function getRole(userId) {
  if (!admin || !userId) return null;
  try {
    const { data } = await admin.from("room_members").select("role, status").eq("user_id", userId).maybeSingle();
    if (!data) return "visitor";
    if (data.status === "banned") return "banned";
    return data.role;
  } catch {
    return null;
  }
}
