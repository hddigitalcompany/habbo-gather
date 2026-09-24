-- 2 pedidos do Douglas pro Editor de Itens (ver components/ItemEditor.tsx):
--
-- 1) direction_offsets: cada uma das 4 direções (frente/lado esq/lado
--    dir/costas) ganha o PRÓPRIO ajuste de posição dentro do tile, em
--    vez de um offset_x/offset_y só valendo pras 4 (pedido: "editar
--    todos os lados do mobi"). "down" (frente) continua usando
--    offset_x/offset_y direto (sem entrada aqui) -- essa coluna só
--    guarda o OVERRIDE das outras 3, ex: {"left": {"x": 10, "y": -4}}.
--    Direção sem entrada aqui cai no offset_x/offset_y de "down" (mesmo
--    comportamento de sempre, sem regressão pros itens já cadastrados).
--
-- 2) sittable/seat_offset_x/seat_offset_y: pedido do Douglas: "editar
--    também a posição sentado lá dentro, com uma seleção, se vai ter
--    interação, e qual interação -- por enquanto só temos sentar". Até
--    aqui, sentar dependia só da CATEGORIA (poltrona/sofá sentam, o
--    resto não, ver isSittableFurnitureType em game/furniture.ts) --
--    sittable permite escolher por ITEM, direto no cadastro (null =
--    ainda sem escolha, cai no fallback por categoria, cobre os itens
--    cadastrados ANTES dessa coluna existir). seat_offset_x/y é o
--    ajuste PADRÃO de onde o boneco senta nesse item (aplicado nas 4
--    direções) -- o ajuste fino POR DIREÇÃO continua sendo o painel
--    "Assento" já existente no editor de espaço (não mexe nisso).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql, 0002_room_items.sql, 0003_room_items_display_width.sql
-- e 0004_room_items_icon_offset.sql.
alter table public.room_items
  add column if not exists direction_offsets jsonb,
  add column if not exists sittable boolean,
  add column if not exists seat_offset_x integer check (seat_offset_x between -100 and 100),
  add column if not exists seat_offset_y integer check (seat_offset_y between -100 and 100);
