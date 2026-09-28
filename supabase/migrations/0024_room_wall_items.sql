-- Editor de Itens: cadastro de PADRÃO de parede de sistema customizado
-- (pedido do Douglas, depois de perguntar se dava pra criar uma
-- "geometria" de parede igual o piso "padrão", sem imagem: "a gente cria
-- uma nova aba la no criar pra configurar os padroes dela") -- nova aba
-- "Criar Parede" do Editor de Itens (distinta da antiga "Criar Parede",
-- rebatizada "Criar Divisória" -- ver components/ItemEditor.tsx), com
-- tabela PRÓPRIA (não reusa room_floor_items nem room_items): parede de
-- sistema pinta uma ARESTA da grade, não um tile/móvel (ver comentário
-- grande em game/wall.ts sobre o modelo de dado "aresta" em vez de
-- "tile"). Ver app/api/wall-items/** e registerCustomWallModels em
-- game/wall.ts.
--
-- Só cobre o tipo "padrão" (sem imagem, ver WallPatternConfig em
-- game/wall.ts) -- parede de sistema COM arte continua vindo só da pasta
-- local (scripts/syncWallAssets.mjs), sem upload pelo Editor de Itens
-- ainda (o Douglas não pediu isso, só o padrão desenhado por código).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de public.room_members existir).

create table if not exists public.room_wall_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  -- bate com WallPatternConfig em game/wall.ts -- painel de tijolo
  -- desenhado direto por código, sem imagem nenhuma.
  height_px numeric not null check (height_px >= 20 and height_px <= 400),
  brick_width_px numeric not null check (brick_width_px >= 4 and brick_width_px <= 200),
  brick_height_px numeric not null check (brick_height_px >= 4 and brick_height_px <= 100),
  brick_color text not null,
  mortar_color text not null,
  mortar_width_px numeric not null check (mortar_width_px >= 0 and mortar_width_px <= 20),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.room_wall_items enable row level security;

-- leitura PÚBLICA (mesma regra de room_floor_items/room_items --
-- visitante sem conta também precisa ver a parede customizada erguida na
-- sala).
create policy "room_wall_items: leitura pra todo mundo" on public.room_wall_items
  for select to public using (true);

-- sem policy de insert/update/delete pro público -- só a service role
-- (usada em app/api/wall-items/**, que confere permissão de owner ANTES
-- de mexer aqui) pode escrever, mesma regra de room_floor_items.
