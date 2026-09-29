-- "Amigos" (pedido do Douglas, 29/set: "eu quero que as pessoas
-- possam adicionar como amigo [...] as pessoas podem ter Seguidores,
-- quando os dois se seguem mutuamente, viram amigos / Aquela aba
-- contatos, vai virar amigos / nao necessariamente quem ta na empresa
-- dele, vira amigo"). Modelo clássico de seguidor (assimétrico) --
-- "amigo" não é um estado gravado, é CALCULADO: A é amigo de B quando
-- existe uma linha A->B E uma linha B->A ao mesmo tempo (ver
-- areMutualFriends em server/chatStore.js e app/api/friends/**, que
-- são os únicos lugares que leem/escrevem essa tabela).
--
-- Usado também pra travar a lane "private" das conversas (ver
-- comentário grande em server/chatStore.js/getOrCreateDirectConversation
-- e 0038_room_visits.sql pro precedente da lane "company" == sem
-- trava nenhuma, igual sempre foi).
create table if not exists public.followers (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followed_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint followers_no_self_follow check (follower_id <> followed_id)
);

-- "quem me segue" (pro cálculo de mútuo) é a consulta mais comum além
-- da primary key (que já cobre "quem eu sigo").
create index if not exists followers_followed_idx on public.followers (followed_id, follower_id);

alter table public.followers enable row level security;

-- sem policy nenhuma de leitura/escrita pro público, de propósito --
-- só a service role mexe aqui (app/api/friends/toggle,list,search),
-- mesma regra de room_visits/rooms/room_layout_state (ver comentário
-- deles).
