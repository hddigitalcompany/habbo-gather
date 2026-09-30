-- Membros da empresa (colaboradores) + qual empresa a pessoa escolheu
-- destacar no PRÓPRIO perfil -- pedido do Douglas, 30/set (8): "as
-- empresas que a pessoa é dona/membro vao aparecer no perfil dela, e
-- junto a logo embaixo, a funcao dela na empresa, como no card da
-- empresa, porem vai ser a logo da empresa que aparecera no lugar do
-- campo / em edicao de perfil, ele vai escolher qual empresa mostrar".
--
-- "DONA" já existia de verdade por espaço (rooms.owner_user_id, ver
-- app/api/room/company-profile). "MEMBRO" só existia de um jeito
-- GLOBAL/antigo (public.room_members, de antes de existir várias
-- empresas na plataforma -- ver comentário grande em
-- lib/supabase/roomAuth.ts), sem saber de qual empresa. Perguntado
-- como a pessoa deveria virar membro de uma empresa ESPECÍFICA, o
-- Douglas escolheu: "o dono adiciona direto, sem convite" (convite
-- por link "acaba indo pra visitantes também, a pessoa tem que ser
-- adicionada como membro por quem tem direitos na sala").
create table if not exists public.company_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists company_members_user_idx on public.company_members (user_id);

alter table public.company_members enable row level security;

-- sem policy nenhuma de leitura/escrita pro público, de propósito --
-- só a service role mexe (app/api/room/company-members, que confere
-- se quem chama é o rooms.owner_user_id DAQUELE espaço antes de
-- inserir/remover -- mesmo padrão de followers/room_members).

-- Card de empresa no PERFIL pessoal (ver ProfileViewCard.tsx) -- qual
-- das empresas que a pessoa é dona OU membro ela escolheu mostrar (só
-- UMA -- "ele vai escolher qual empresa mostrar"). "on delete set
-- null": se o espaço for apagado, o campo só some -- sem "trigger" de
-- limpeza pra quando a pessoa deixa de ser dona/membro dele, a leitura
-- (GET /api/profile/view) já confere de novo, na hora, se ela ainda é
-- dona/membro daquele espaço antes de mostrar o card (mesmo espírito
-- defensivo do resto do app: nunca confia só no que já foi salvo antes).
alter table public.profiles add column if not exists featured_company_room_id uuid references public.rooms (id) on delete set null;
