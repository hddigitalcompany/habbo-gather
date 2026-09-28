-- Mesma correção de 0034_room_layout_state.sql (achado 28/set: disco
-- local do Render some quando o serviço é recriado, e não é garantido
-- persistir entre deploys nem no free tier), agora pro chat
-- direto/grupo (server/chatStore.js, antes data/chat.json) e pra
-- Agenda de calls (server/agendaStore.js, antes data/agenda.json).
-- Douglas: "chat tem que salvar historico" -- confirmado, é
-- justamente esse arquivo que guardava (guarda) o histórico; só
-- trocando ONDE mora, mesma ideia da tabela de sala.
--
-- Continuam blobs JSONB simples (mesmo formato de sempre: chat.json
-- vira { users, conversations, messages }, agenda.json vira { calls }),
-- uma linha cada, chaveados por STORE_SLUG fixo ("sala-principal",
-- mesma convenção de room_layout_state) -- não são por sala ainda
-- (esse ambiente só tem uma sala hoje), viram multi-tenant de verdade
-- junto com o resto na Task #63.
--
-- Sem policy de leitura/escrita pro público -- só a service role
-- (usada por server/chatStore.js e server/agendaStore.js) mexe aqui,
-- cliente nunca lê direto do Supabase (sempre pelo servidor
-- WebSocket).
create table if not exists public.chat_store_state (
  store_slug text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.agenda_store_state (
  store_slug text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chat_store_state enable row level security;
alter table public.agenda_store_state enable row level security;
