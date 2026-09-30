-- "Founders" de uma empresa -- pedido do Douglas, 30/set (14),
-- corrigindo o que eu tinha feito antes: "somente founders ninguem
-- aqui falou membros / os membros podem adicionar o card da empresa
-- no perfil deles se quiserem, mas a empresa nao divulga eles apenas
-- os founders". Ou seja: DOIS conceitos DIFERENTES, sem relação um
-- com o outro --
-- - Membros/colaboradores (public.company_members,
--   0044_company_members_and_profile_card.sql): quem TRABALHA lá, cada
--   um decide se quer mostrar o card da empresa no PRÓPRIO perfil
--   (featured_company_room_id) -- a empresa não divulga essa lista pra
--   ninguém.
-- - Founders (aqui): quem a empresa ESCOLHE mostrar publicamente no
--   PRÓPRIO card dela (company_show_founders_on_card, migration 0045).
--   Roster à parte -- não é um subconjunto de company_members marcado
--   com uma flag, é outra tabela mesmo, porque são coisas diferentes
--   (alguém pode ser founder sem ser "membro/colaborador" cadastrado,
--   ou vice-versa).
--
-- Mesmo padrão de sempre pra "quem pode mexer" (só o dono do espaço,
-- adiciona direto sem convite -- mesma decisão de 0044): ver
-- app/api/room/company-founders/route.ts.
--
-- RODAR NO SQL EDITOR DO SUPABASE ANTES DO DEPLOY (mesmo aviso de
-- sempre -- sem essa tabela existir, a rota acima quebra).
create table if not exists public.company_founders (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists company_founders_room_idx on public.company_founders (room_id);

alter table public.company_founders enable row level security;

-- sem policy nenhuma de leitura/escrita pro público, de propósito --
-- só a service role mexe aqui (app/api/room/company-founders +
-- getFounders em app/api/room/company-profile), mesma regra de
-- company_members/followers/room_visits (ver comentário deles).
