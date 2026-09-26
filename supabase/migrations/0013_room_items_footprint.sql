-- "tenho mobis que ocupam mais tiles doq um ou dois, entao preciso
-- selecionar pra que nao se suba em um item" -- até aqui TODO móvel
-- travava passagem (quando trava, ver FURNITURE_BLOCKS_MOVEMENT em
-- game/furniture.ts) só no próprio tile-âncora (col/row) -- um sofá ou
-- mesa desenhado mais largo que 1 tile deixava o resto da peça andável,
-- dava pra atravessar "por dentro" dela.
--
-- footprint_cols/footprint_rows guardam o tamanho (em tiles do grid)
-- que o MODELO ocupa a partir da âncora -- 1 (padrão) = comportamento
-- de sempre, só a âncora, não regride NENHUM item existente. Ver
-- furnitureFootprintTiles/blockingFurnitureAt em game/furniture.ts pra
-- como isso vira bloqueio de fato.
--
-- Rode isso no SQL Editor do Supabase.
alter table public.room_items
  add column if not exists footprint_cols integer not null default 1,
  add column if not exists footprint_rows integer not null default 1;
