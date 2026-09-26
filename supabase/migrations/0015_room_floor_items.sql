-- Editor de Itens: cadastro de PISO customizado (pedido do Douglas:
-- "eu quero uma aba so pra piso tambem... vai ter funcoes totalmente
-- diferentes dos mobis") -- terceira aba do Editor de Itens (depois de
-- "Criar Mobi"/"Criar Parede"), mas com uma TABELA própria (não reusa
-- room_items): piso é uma imagem PLANA só, deitada no tile inteiro,
-- sem direção/footprint/assento/interação -- nenhum desses campos de
-- móvel faz sentido aqui, por isso não reaproveita a mesma tabela (ver
-- comentário grande em game/floor.ts sobre o piso ser bem mais simples
-- que móvel). Ver components/ItemEditor.tsx (aba "Criar Piso"),
-- app/api/floor-items/** e registerCustomFloorModels em game/floor.ts.
--
-- Reaproveita o MESMO bucket "room-items" do Storage (já criado em
-- 0002_room_items.sql, já público, já com policy de upload/apagar só
-- pro dono) -- as imagens de piso custom sobem lá dentro da pasta
-- "piso/", sem precisar de bucket nem policy de Storage novos.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql e 0002_room_items.sql (depende de public.room_members
-- e do bucket "room-items" existirem).

create table if not exists public.room_floor_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  -- bate com FloorCategory em game/floor.ts (porcelanato/laminado/natural
  -- -- as mesmas 3 categorias que já existem pro piso "de fábrica").
  category text not null check (category in ('porcelanato', 'laminado', 'natural')),
  file_url text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.room_floor_items enable row level security;

-- leitura PÚBLICA (mesma regra de room_items -- visitante sem conta
-- também precisa ver o piso customizado pintado na sala).
create policy "room_floor_items: leitura pra todo mundo" on public.room_floor_items
  for select to public using (true);

-- sem policy de insert/update/delete pro público -- só a service role
-- (usada em app/api/floor-items/**, que confere permissão de owner
-- ANTES de mexer aqui) pode escrever, mesma regra de room_items.
