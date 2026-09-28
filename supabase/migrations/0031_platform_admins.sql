-- Separa duas permissões que ATÉ AGORA eram a mesma coisa: "dono da
-- sala" (role='owner' em room_members, ver 0001_accounts.sql) também
-- liberava o Editor de Itens ("+Criar", ver components/ItemEditor.tsx
-- e as rotas app/api/{items,floor-items,wall-items,door-items,
-- avatar-items,avatar-skins,avatar-default-reference}/**) -- cadastrar
-- item NOVO no catálogo (móvel/piso/parede/porta/avatar), que é
-- COMPARTILHADO por toda a plataforma (room_items não tem room_id, ver
-- 0002_room_items.sql, de propósito -- catálogo é um só pra todo
-- mundo). Isso nunca deu problema com uma sala só (o único "owner" era
-- o próprio Douglas), mas quebra assim que cada empresa tiver seu
-- próprio dono de sala: o dono da EMPRESA X não pode cadastrar item
-- novo no catálogo de TODO MUNDO, só arrumar a sala dele com o que já
-- existe (ver "Editar espaço", continua gated por room_members.role
-- ='owner', sem mudança nenhuma).
--
-- platform_admins é ESSA permissão nova, separada: só quem tá aqui
-- pode abrir o Editor de Itens e mexer no catálogo global -- hoje,
-- só o Douglas (funciona como um "super-admin" da plataforma inteira,
-- não de uma sala específica). Sem role/status como room_members (não
-- existe "platform_admin banido" nem "platform_member") -- ou a pessoa
-- tá na tabela (é admin), ou não tá (não é), booleano puro por
-- presença de linha.
--
-- Sem policy nenhuma de insert/update/delete pro público -- só a
-- service role (rotas em app/api/**, que conferem isPlatformAdmin
-- ANTES de mexer aqui) pode escrever, mesmo esquema de room_members.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de room_members existir, pro bootstrap
-- abaixo).
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

create policy "platform_admins: leitura pra quem tá logado" on public.platform_admins
  for select to authenticated using (true);

-- Bootstrap: quem já é 'owner' em room_members HOJE (na prática, só o
-- Douglas, já que a sala sempre foi única) vira platform_admin
-- automaticamente -- sem isso, essa migration tiraria o acesso dele ao
-- "+Criar" na hora, e ele precisaria se auto-promover à mão antes de
-- conseguir usar o Editor de Itens de novo. `on conflict do nothing`
-- pra rodar essa migration de novo (ou junto de um seed futuro) não
-- estourar em linha duplicada.
insert into public.platform_admins (user_id, added_by)
select user_id, user_id from public.room_members where role = 'owner'
on conflict (user_id) do nothing;

-- As DUAS policies de Storage do bucket "room-items" (criadas em
-- 0002_room_items.sql, reusado por avatar-items/avatar-skins/
-- avatar-default-reference/floor-items/wall-items/door-items também --
-- ver comentário em cada migration) ainda conferiam
-- "role='owner' em room_members" pra liberar upload/exclusão de
-- arquivo. Isso é O MESMO GATE que as rotas app/api/**/route.ts (agora
-- em isPlatformAdmin) -- o upload de imagem vai DIRETO do navegador pro
-- Storage (ver ItemEditor.tsx), então se essa policy continuasse
-- olhando pra room_members, um admin de plataforma que não fosse
-- também dono de alguma sala nem conseguiria subir o arquivo (a chamada
-- pra nossa API, já corrigida, nunca seria alcançada) -- e um dono de
-- sala comum continuaria conseguindo, mesmo sem ser mais admin.
-- Substitui pelas duas de novo, agora contra platform_admins.
drop policy if exists "room-items: só o dono sobe arquivo" on storage.objects;
drop policy if exists "room-items: só o dono apaga arquivo" on storage.objects;

create policy "room-items: só admin da plataforma sobe arquivo" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'room-items'
    and exists (select 1 from public.platform_admins where user_id = auth.uid())
  );

create policy "room-items: só admin da plataforma apaga arquivo" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'room-items'
    and exists (select 1 from public.platform_admins where user_id = auth.uid())
  );
