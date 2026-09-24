// Helpers de autorização pras rotas de API da sala (app/api/room/**) --
// contraparte, do lado do Next.js, do server/roomAuth.js que o
// servidor WebSocket usa (processos DIFERENTES -- server/index.js
// pode rodar noutro host, ver README -- por isso não compartilham
// arquivo, só a mesma ideia: confere o token do Supabase de verdade
// em vez de confiar em qualquer coisa que o cliente mande).
import { getSupabaseAdminClient } from "./server";
import type { NextRequest } from "next/server";

export async function getVerifiedUserId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return null;
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export type Membership = { role: "owner" | "member"; status: "active" | "banned" } | null;

/** null = visitante (tem conta, mas nunca foi adicionado à sala). */
export async function getMembership(userId: string): Promise<Membership> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("room_members")
    .select("role, status")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Membership) ?? null;
}

/**
 * Primeiro acesso: a sala (ÚNICA nesse app, ver comentário no topo de
 * supabase/migrations/0001_accounts.sql) ainda não tem NENHUM membro
 * -- quem entrar primeiro vira "owner" (dono/admin) sozinho, sem
 * precisar de um passo manual de "criar a sala". Não faz nada se já
 * existir qualquer linha em room_members (mesmo de outra pessoa).
 */
export async function bootstrapOwnerIfEmpty(userId: string): Promise<void> {
  const admin = getSupabaseAdminClient();
  if (!admin) return;
  const { count } = await admin.from("room_members").select("user_id", { count: "exact", head: true });
  if (count && count > 0) return;
  await admin.from("room_members").insert({ user_id: userId, role: "owner", status: "active", added_by: userId });
}
