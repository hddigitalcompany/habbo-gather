-- Editor de Itens: cadastro de móvel CUSTOMIZADO, feito pelo dono da
-- sala direto pela tela (upload de imagem), sem precisar subir arquivo
-- na pasta local e rodar `npm run sync-assets` -- ver
-- components/ItemEditor.tsx e app/api/items/**.
--
-- Diferente do catálogo "de fábrica" (game/furniture.ts, gerado a
-- partir da pasta local do Douglas em build-time), esses itens vivem só
-- no banco/Storage e chegam pro jogo em TEMPO DE EXECUÇÃO, buscados
-- assim que a sala carrega (ver fetchCustomFurnitureModels em
-- GameRoom.tsx / registerCustomFurnitureModels em game/furniture.ts).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de public.room_members existir).

-- ---------------------------------------------------------------
-- Storage: bucket público onde ficam as imagens dos itens (uma por
-- direção, ver `art` na tabela abaixo). Upload vai DIRETO do
-- navegador pro Storage (usando o token da própria pessoa) -- arquivo
-- de imagem não devia virar tráfego binário passando pelo Next.js à
-- toa. "public" = true pra servir a URL direto pro Phaser sem
-- precisar de signed URL nem esconder nada (é só arte de móvel, não é
-- dado sensível).
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('room-items', 'room-items', true)
on conflict (id) do nothing;

-- só o DONO da sala pode subir/apagar arquivo nesse bucket -- confere
-- direto contra room_members (mesma regra de "quem é owner" usada em
-- app/api/room/**). A inserção da LINHA de metadados (tabela
-- room_items abaixo) sempre passa pela rota da API (service role, que
-- confere de novo) -- isso aqui só protege o Storage em si.
create policy "room-items: só o dono sobe arquivo" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'room-items'
    and exists (
      select 1 from public.room_members
      where user_id = auth.uid() and role = 'owner' and status = 'active'
    )
  );

create policy "room-items: só o dono apaga arquivo" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'room-items'
    and exists (
      select 1 from public.room_members
      where user_id = auth.uid() and role = 'owner' and status = 'active'
    )
  );

-- ---------------------------------------------------------------
-- room_items: um item de móvel customizado por linha. `art` guarda a
-- URL pública (Storage) de cada direção -- "down" (frente) sempre
-- presente, as outras 3 são opcionais (ver furnitureArtFile/
-- resolveFurnitureArt em game/furniture.ts, que já cai pra "down"
-- quando falta alguma). `category` bate com FurnitureCategoryId (ver
-- game/furniture.ts) -- decide em qual aba da barra de ícones do
-- editor de espaço o item aparece.
--
-- Sem policy nenhuma de insert/update/delete pro público -- só a
-- service role (usada em app/api/items/**, que confere permissão de
-- owner ANTES de mexer aqui) pode escrever, mesma regra de
-- room_members/room_invites.
-- ---------------------------------------------------------------
create table if not exists public.room_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  category text not null check (category in ('poltrona', 'divisoria', 'sofa', 'mesa', 'planta', 'computador')),
  art jsonb not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.room_items enable row level security;

-- leitura PÚBLICA (não só "authenticated" -- diferente de profiles/
-- room_members/room_invites) porque visitante SEM conta também
-- precisa ver os móveis customizados colocados na sala.
create policy "room_items: leitura pra todo mundo" on public.room_items
  for select to public using (true);
