-- Tamanho de EXIBIÇÃO por item custom (Editor de Itens, ver
-- components/ItemEditor.tsx) -- até aqui o tamanho vinha só da
-- CATEGORIA (CUSTOM_ITEM_TARGET_WIDTH, game/furniture.ts), igual pra
-- todo item daquela categoria. O Douglas notou que isso não é
-- suficiente: as imagens que ele gera não vêm num padrão de proporção
-- (uma poltrona pode sair "quadrada", outra "alongada"), então o
-- mesmo target de LARGURA dá resultados de tamanho bem diferentes de
-- item pra item. Esse campo guarda o tamanho ajustado À MÃO no preview
-- do Editor de Itens (ver display_width no POST /api/items) -- null
-- pros itens cadastrados ANTES dessa migration, que continuam caindo
-- no fallback por categoria (ver addFurnitureSprite, MainScene.ts).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql e 0002_room_items.sql.
alter table public.room_items
  add column if not exists display_width integer
  check (display_width is null or (display_width between 20 and 600));
