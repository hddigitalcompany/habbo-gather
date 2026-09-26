-- Pedido do Douglas, com foto de referência de porcelanato marmorado:
-- "ainda em piso, agora eu quero um, porcelanato, que vai ser do
-- tamanho do tile, com linha divisoria, e com efeito de porcelanato
-- marmorado, assim".
--
-- - marble: liga/desliga o efeito (veios em diagonal, com borda suave,
--   dentro de cada placa -- ver FloorPatternConfig.marble em
--   game/floor.ts e marbleVeinShapesForSlab, a mesma função pura usada
--   tanto pelo preview do formulário quanto pelo jogo de verdade). Só
--   tem efeito junto de plank_length_px (0017) preenchido -- ripa
--   contínua não tem placa delimitada pra conter o veio dentro.
-- - tile_aligned: liga/desliga o desalinhamento "amarração" entre
--   colunas que as tábuas de madeira usam (ver colOffset em
--   createFloorPatternGraphics, MainScene.ts) -- com isso ligado, a
--   emenda cai reta, alinhada à grade do jogo (o normal pra porcelanato
--   de verdade, que não é intercalado feito assoalho). Junto com
--   plank_width_px/plank_length_px do tamanho do tile (ver
--   TILE_SIZED_PLANK_PX em game/floor.ts, preenchido automaticamente
--   pelo botão "Placa do tamanho do tile" no formulário "Criar Piso"),
--   faz cada placa cobrir exatamente 1 quadrado da grade.
--
-- Ambos false por padrão -- não mudam a aparência de nenhum piso já
-- cadastrado.
--
-- Rode isso DEPOIS de já ter rodado 0015, 0016, 0017 e 0018.

alter table public.room_floor_items
  add column if not exists marble boolean not null default false,
  add column if not exists tile_aligned boolean not null default false;
