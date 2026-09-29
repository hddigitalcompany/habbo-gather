-- "Espaços visitados" (pedido do Douglas, 29/set: "aqui encima, do
-- lado de meus espacos, cria uma nova / espacos visitados / [...] se
-- eu entrar na sala de um amigo, a sala dele vai ficar ali, como um
-- link rapido"). Antes disso não existia NENHUM jeito de um cliente
-- entrar na sala de outro cliente -- o único convite que já existia
-- (room_invites/room_members, ver 0033_room_scoped_membership.sql) é
-- fixo pro TIME do Douglas entrar na Sala Principal dele
-- (getMembership em lib/supabase/roomAuth.ts é GLOBAL, não olha pra
-- qual sala). Isso fica intocado -- essa migration NÃO mexe em
-- room_members/room_invites.
--
-- O mecanismo novo é mais simples, de propósito: a sala própria de um
-- cliente já tem um room_slug (uuid, ver 0037_rooms_slug_and_first_
-- template.sql) imprevisível o bastante pra servir de "convite" só
-- por ele existir -- dono compartilha um link (?visitar=<slug>, ver
-- POST /api/room/visit) com quem quiser, sem precisar gerar código
-- nenhum. Essa tabela só REGISTRA quem já visitou o quê, pra alimentar
-- a lista de atalhos -- não é ela que decide se a visita é permitida
-- (isso é a query em /api/room/visit: só aceita sala de cliente de
-- verdade, nunca sala-principal/mapa-modelo, ver comentário grande lá).
create table if not exists public.room_visits (
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  visited_at timestamptz not null default now(),
  primary key (user_id, room_id)
);

-- ordenar "mais recente primeiro" pro dropdown é a única leitura que
-- essa tabela precisa servir rápido.
create index if not exists room_visits_user_visited_idx on public.room_visits (user_id, visited_at desc);
