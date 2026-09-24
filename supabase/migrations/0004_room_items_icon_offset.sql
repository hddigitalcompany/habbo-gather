-- 3 pedidos do Douglas pro Editor de Itens (ver components/ItemEditor.tsx):
--
-- 1) icon_url: ícone PRÓPRIO pro botão do catálogo (barra de móveis do
--    editor de espaço) -- upload separado das 4 fotos de direção (ver
--    DIRECTION_FIELDS em ItemEditor.tsx), útil quando a arte da peça não
--    fica boa cortada em quadrado pequeno (ex: um sofá de lado). null =
--    sem ícone próprio, cai no fallback de sempre (foto de frente, ver
--    catalogEntryIconFile em GameRoom.tsx).
--
-- 2) offset_x/offset_y: posição do móvel DENTRO do tile, ajustada à mão
--    no preview do Editor de Itens (arrastar o item em cima do
--    quadrado/boneco de referência) -- desloca só a EXIBIÇÃO a partir do
--    ponto-âncora padrão (borda de baixo do tile, ver furnitureWorldPos
--    em game/furniture.ts), não muda o tile lógico nem a profundidade.
--    0/0 (padrão) = comportamento de sempre, sem deslocamento.
--
-- Faixa -300..300 só de sanidade (mesmo espírito do check de
-- display_width em 0003) -- bem mais que suficiente pra qualquer ajuste
-- dentro/perto de um tile (TILE = 90px na resolução atual, ver
-- game/grid.ts).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql, 0002_room_items.sql e 0003_room_items_display_width.sql.
alter table public.room_items
  add column if not exists icon_url text,
  add column if not exists offset_x integer not null default 0 check (offset_x between -300 and 300),
  add column if not exists offset_y integer not null default 0 check (offset_y between -300 and 300);
