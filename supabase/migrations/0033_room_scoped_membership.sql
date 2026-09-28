-- Primeiro passo de verdade rumo a multi-tenant (Task #63 do roadmap):
-- dá a room_members/room_invites uma coluna room_id, apontando pra
-- public.rooms (criada em 0032_rooms.sql) -- hoje as duas tabelas são
-- GLOBAIS (uma linha por usuário/convite, sem noção de qual sala, ver
-- o header de 0001_accounts.sql). De propósito, essa migration é só o
-- lado do BANCO, e é ADITIVA/sem quebrar nada que já roda: cria a
-- coluna, bota ela pra apontar pra sala única de hoje (bootstrap
-- abaixo) em toda linha existente, mas deixa DEPOIS pra tornar
-- obrigatória -- os pontos do código que fazem INSERT em room_members
-- (bootstrapOwnerIfEmpty em lib/supabase/roomAuth.ts, o
-- promote/unban em app/api/room/members/route.ts) ainda não mandam
-- room_id nenhum; se essa migration travasse a coluna como NOT NULL
-- agora, esses INSERTs começariam a falhar na hora, em produção, sem
-- eu ter mudado uma linha de código ainda. Isso fica pra uma migration
-- separada, JUNTO da troca desses call sites (não faz sentido travar o
-- banco um passo na frente do código que escreve nele).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0032_rooms.sql (depende de public.rooms existir).

alter table public.room_members add column if not exists room_id uuid references public.rooms (id) on delete cascade;
alter table public.room_invites add column if not exists room_id uuid references public.rooms (id) on delete cascade;

-- Bootstrap: cria (se ainda não existir) a linha em `rooms` que
-- representa a ÚNICA sala de hoje ("sala-principal", fixo no
-- WebSocket -- ver comentário no topo de server/index.js) -- dono
-- dela é quem já é 'owner' em room_members hoje (na prática, o
-- Douglas). is_template=false (é uma sala de verdade, não um modelo).
-- "where not exists" evita duplicar essa linha se essa migration
-- rodar de novo.
insert into public.rooms (name, company_name, owner_user_id, is_template)
select 'Sala Principal', null, (select user_id from public.room_members where role = 'owner' limit 1), false
where not exists (select 1 from public.rooms where is_template = false and name = 'Sala Principal');

-- Backfill: toda linha existente (de antes dessa coluna existir)
-- passa a apontar pra essa sala única -- sem isso, o app continuaria
-- funcionando (nada lê room_id ainda), mas a coluna ficaria "furada"
-- pra sempre em quem já tinha conta antes dessa migration.
update public.room_members
set room_id = (select id from public.rooms where is_template = false and name = 'Sala Principal' limit 1)
where room_id is null;

update public.room_invites
set room_id = (select id from public.rooms where is_template = false and name = 'Sala Principal' limit 1)
where room_id is null;

create index if not exists room_members_room_id_idx on public.room_members (room_id);
create index if not exists room_invites_room_id_idx on public.room_invites (room_id);
