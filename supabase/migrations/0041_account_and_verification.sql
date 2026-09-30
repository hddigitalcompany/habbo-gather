-- Dados sensíveis da conta (nome completo/CPF/nascimento) + selo de
-- verificação (pessoal/empresa) -- pedido do Douglas, 30/set: "Dados
-- da conta: nome completo, cpf, data de nascimento, email da conta,
-- senha, alterar senha" + "Selo de verificação: ... ativar selo de
-- verificado, pessoal e empresa ... ele tem que enviar foto segurando
-- doc pra analise, e na empresa, tem que enviar o contrato social da
-- empresa constando ele como socio".
--
-- IMPORTANTE (por que NÃO entra na tabela public.profiles de sempre):
-- profiles tem uma policy de leitura ABERTA pra qualquer logado ("profiles:
-- leitura pra quem tá logado", ver 0001_accounts.sql) -- faz sentido pra
-- nome/foto/bio (aparecem pros outros na sala), mas CPF/data de
-- nascimento são dado sensível de verdade, não pode vazar pra qualquer
-- conta que decidir consultar a tabela. Por isso mora numa tabela À
-- PARTE, sem NENHUMA policy de select pública -- só o dono (auth.uid())
-- ou a service role (rotas em app/api/account/**, que já conferem o
-- token antes) conseguem ler.

create table if not exists public.account_private (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  cpf text not null default '',
  birthdate date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_private enable row level security;

create policy "account_private: só o dono lê" on public.account_private
  for select to authenticated using (auth.uid() = id);

create policy "account_private: só o dono grava" on public.account_private
  for insert to authenticated with check (auth.uid() = id);

create policy "account_private: só o dono atualiza" on public.account_private
  for update to authenticated using (auth.uid() = id);

-- ---------------------------------------------------------------
-- verification_requests: pedido de selo de verificação (pessoal ou
-- empresa) -- fica "pending" até alguém (hoje, só o Douglas, via
-- painel do Supabase mesmo -- não tem tela de aprovação dentro do app
-- ainda) aprovar ou recusar. doc_path é o caminho DENTRO do bucket
-- privado "verification-docs" (ver mais abaixo), nunca uma URL pública
-- -- é documento de identidade/contrato social de verdade, não pode
-- ficar acessível por link adivinhável igual o bucket "room-items".
-- ---------------------------------------------------------------
create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('personal', 'company')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  doc_path text not null,
  note text not null default '',
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.verification_requests enable row level security;

-- só o dono vê os PRÓPRIOS pedidos (status do selo dele) -- sem select
-- público nenhum (mesmo motivo de account_private acima).
create policy "verification_requests: só o dono lê os próprios" on public.verification_requests
  for select to authenticated using (auth.uid() = user_id);

-- sem policy de insert/update pro público de propósito -- só a service
-- role escreve (rota app/api/account/verification, que confere o
-- token e o "gate" de plano/sala ANTES de inserir), mesmo padrão de
-- room_members/room_invites (ver 0001_accounts.sql).

-- selo em si, pra desenhar o ícone verificado nos cards (ver
-- VerifiedBadge em components/Lobby.tsx) -- fica em profiles porque
-- ISSO sim é público (os outros precisam ver o selo), diferente do
-- pedido/documento que gerou ele. Só a service role muda (aprovação
-- manual, ver comentário da tabela acima).
alter table public.profiles add column if not exists verified_personal boolean not null default false;
alter table public.profiles add column if not exists verified_company boolean not null default false;

-- ---------------------------------------------------------------
-- bucket PRIVADO (public: false, diferente de "room-items") pros
-- documentos de verificação -- foto segurando documento (pessoal) ou
-- contrato social (empresa). Upload SEMPRE via app/api/account/verification
-- (service role), nunca direto do navegador -- por isso não tem policy
-- de insert pra "authenticated" aqui, só a service role (que ignora
-- RLS) consegue gravar.
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('verification-docs', 'verification-docs', false)
on conflict (id) do nothing;
