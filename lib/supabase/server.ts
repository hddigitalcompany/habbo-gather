// Cliente Supabase do SERVIDOR (service role key -- acesso total,
// ignora RLS) -- só pode ser importado de código que roda no servidor
// (rotas em app/api/**/route.ts, ou server/index.js via
// server/roomAuth.js). NUNCA importar isso de um componente "use
// client"/do navegador: a service role key vazando dá acesso total ao
// banco pra qualquer um.
//
// Usado pra: conferir o token de quem loga (auth.getUser), e pra ler/
// escrever nas tabelas de membro/convite (room_members/room_invites)
// sem precisar duplicar política de RLS pra cada ação de admin -- quem
// decide se a ação é permitida é a própria rota da API (confere se
// quem pediu é owner/member antes de chamar isso), não o banco.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let cached: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
