-- Fundação do multi-tenant: cada linha aqui vira, no futuro (ver Tasks
-- #63-65 do roadmap), UMA SALA de verdade -- hoje o app inteiro ainda é
-- singleton (uma sala só, "sala-principal" fixo no WebSocket, um
-- data/room.json só, ver comentário no topo de server/roomStore.js e
-- o header de 0001_accounts.sql). Essa migration só CRIA a tabela --
-- ainda não tem NENHUM código lendo/escrevendo aqui (Task #63 vai
-- migrar room_members/room_invites/o estado da sala pra usar room_id,
-- só depois disso essa tabela passa a valer de verdade).
--
-- Dois "tipos" de linha na mesma tabela, distinguidos por is_template:
--   - is_template = false -> uma sala DE VERDADE, de uma empresa (dono
--     em owner_user_id, nome da empresa em company_name). Se veio de
--     um template, source_template_id aponta pra linha template que
--     foi clonada na criação (layout inicial -- depois disso as duas
--     salas vivem cada uma por si, editar uma não muda a outra).
--   - is_template = true -> um dos modelos pré-definidos do Douglas
--     (mesas, setores, sala de CEO, sala de reunião etc, ver conversa
--     "eu vou meio que criar varios mapas ja pre definidos... e eles
--     vao escolher um template"). Editado com a MESMA ferramenta de
--     edição de sala de sempre (canEditRoom) -- não é um formato
--     separado. template_status controla se já pode ser escolhido por
--     empresas de verdade: 'draft' = só o Douglas vê/testa (ambiente
--     de staging, "quero um ambiente de teste... deu certo no teste?
--     joga pros usuarios"), 'published' = aparece no catálogo de
--     templates pra qualquer empresa criar sala a partir dele.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (owner_user_id referencia auth.users) e
-- 0031_platform_admins.sql (não referencia platform_admins de verdade
-- ainda, só faz sentido cronologicamente já que templates só devem ser
-- criados por admin da plataforma -- Task #63/#64 conferem isso no
-- código, não tem constraint de banco pra isso aqui).
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- só preenchido pra sala de empresa de verdade (is_template=false);
  -- null num template (o template em si não é "de" nenhuma empresa).
  company_name text,
  -- dono da SALA (mesmo papel que hoje é global em room_members.role=
  -- 'owner', ver Task #63) -- null enquanto ninguém reivindicou/criou
  -- por conta própria, ou num template (dono conceitual é o Douglas,
  -- via isPlatformAdmin, não precisa de uma linha aqui pra isso).
  -- ON DELETE SET NULL: apagar a CONTA do dono não deve apagar a sala
  -- sozinha, só deixa "sem dono" (mesmo espírito de created_by nas
  -- outras tabelas de catálogo).
  owner_user_id uuid references auth.users (id) on delete set null,
  is_template boolean not null default false,
  template_status text check (template_status in ('draft', 'published')),
  -- de qual template essa sala nasceu (clone do layout na criação, ver
  -- Task #64) -- null se foi criada do zero (ou se ela MESMA é um
  -- template). ON DELETE SET NULL: apagar o template não pode arrastar
  -- junto toda sala de empresa que nasceu dele.
  source_template_id uuid references public.rooms (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- template_status só faz sentido (e é OBRIGATÓRIO) quando
  -- is_template=true; numa sala de empresa de verdade tem que ficar
  -- null -- evita o estado sem sentido de uma sala normal com
  -- "template_status='draft'" pairando por engano.
  constraint rooms_template_status_matches_is_template check (
    (is_template = true and template_status is not null)
    or (is_template = false and template_status is null)
  )
);

create index if not exists rooms_is_template_idx on public.rooms (is_template, template_status);
create index if not exists rooms_owner_user_id_idx on public.rooms (owner_user_id);

alter table public.rooms enable row level security;

-- SEM policy de leitura/escrita pro público ainda, de propósito --
-- ninguém lê essa tabela pelo cliente até Task #63/#64 existir de
-- verdade (hoje só a service role, via rotas app/api/**, vai poder
-- mexer aqui, do jeito que as outras tabelas sensíveis já fazem). As
-- policies de verdade (leitura de template published pra todo mundo,
-- leitura/escrita da própria sala só pro dono/membro dela) entram
-- junto com Task #63, quando room_members ganhar room_id e o código
-- realmente passar a consultar rooms.
