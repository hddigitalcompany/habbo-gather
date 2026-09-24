-- Contas de verdade (login email+senha, ver AuthGate.tsx), perfil
-- persistente por conta (antes só existia local, no navegador -- ver
-- localStorage em GameRoom.tsx) e membro/visitante da sala (ver
-- server/roomAuth.js e app/api/room/**).
--
-- A sala em si é ÚNICA nesse app (não existe conceito de "várias
-- salas" em nenhum outro lugar do código, ver data/room.json), então
-- as tabelas abaixo NÃO têm uma coluna room_id -- é sempre "a" sala.
--
-- Rode isso no SQL Editor do painel do Supabase (ou via `supabase db
-- push`, se o Douglas tiver a CLI) uma vez só, no projeto que for usar
-- pra esse app.

-- ---------------------------------------------------------------
-- profiles: um por conta (auth.users), com os mesmos campos que já
-- existiam no ProfileCard (ver PROFILE_FIELDS em server/index.js) --
-- antes vivia só no navegador de cada um (perdia trocando de
-- aparelho); agora fica preso à conta.
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  status text not null default '',
  instagram text not null default '',
  bio text not null default '',
  photo_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- qualquer pessoa logada pode VER o perfil de qualquer outra (nome/
-- foto/bio/instagram não é informação sensível, e precisa aparecer
-- pros outros jogadores na sala/lista de membros) -- só a PRÓPRIA
-- pessoa pode editar o próprio perfil.
create policy "profiles: leitura pra quem tá logado" on public.profiles
  for select to authenticated using (true);

create policy "profiles: só edita o próprio perfil" on public.profiles
  for update to authenticated using (auth.uid() = id);

create policy "profiles: só cria o próprio perfil" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- cria a linha de profiles sozinha assim que a conta é criada (auth.users)
-- -- a tela de "criação de perfil" (AuthGate.tsx) só faz um UPDATE
-- depois, preenchendo nome/foto/etc, nunca um INSERT.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------
-- room_members: quem é "membro" (promovido) ou "banido" da sala.
-- Quem tem conta mas NÃO tem linha aqui é "visitante" (ver
-- server/roomAuth.js/app/api/room/members) -- membro precisa ter
-- CONTA *e* ter sido adicionado, não é automático.
--
-- Sem policy nenhuma de insert/update/delete pro público -- só a
-- service role (usada nas rotas em app/api/room/**, que conferem
-- permissão de admin ANTES de mexer aqui) pode escrever. Isso
-- garante que promover/banir só acontece pela rota certa, nunca
-- direto do navegador.
-- ---------------------------------------------------------------
create table if not exists public.room_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'banned')),
  added_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.room_members enable row level security;

create policy "room_members: leitura pra quem tá logado" on public.room_members
  for select to authenticated using (true);

-- ---------------------------------------------------------------
-- room_invites: link/código de convite pra virar membro direto,
-- sem precisar de um admin promover na mão depois. Mesma ideia de
-- RLS: só a service role escreve (ver app/api/room/invite).
-- ---------------------------------------------------------------
create table if not exists public.room_invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_by uuid not null references auth.users (id),
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.room_invites enable row level security;

create policy "room_invites: leitura pra quem tá logado" on public.room_invites
  for select to authenticated using (true);
