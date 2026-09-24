// Cliente Supabase do NAVEGADOR (chave "anon", pública -- protegida
// pelas políticas de RLS no banco, ver supabase/migrations/0001_accounts.sql).
// Usado pro login/cadastro (email+senha) e pra ler o próprio perfil --
// NUNCA usa a service role key (essa só existe em lib/supabase/server.ts,
// que roda só no servidor).
//
// Sessão fica salva sozinha no localStorage do navegador (comportamento
// padrão do supabase-js) e é renovada sozinha também -- é o mesmo token
// que o cliente manda pro server/index.js (WS) na mensagem "identify",
// pra o servidor confirmar quem é o dono de verdade do userId (ver
// server/roomAuth.js).
"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: SupabaseClient | null = null;

// null quando as variáveis de ambiente ainda não foram configuradas
// (ver .env.local.example) -- quem chama precisa tratar esse caso (ver
// AuthGate.tsx), em vez de quebrar a sala inteira só porque login ainda
// não foi configurado.
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
