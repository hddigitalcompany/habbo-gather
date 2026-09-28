-- Cor da face de CIMA/topo da parede de sistema (ver room_wall_items em
-- 0024_room_wall_items.sql, thickness_px/brick_* em
-- 0026_room_wall_items_thickness_brick.sql) virou campo PRÓPRIO --
-- pedido do Douglas depois de testar ao vivo: "quero pintar a cor de
-- cima tambem", "o topo da parede... tem que ser a pintura da parede
-- frontal" e, mais direto: "quero escolher a cor do topo". Antes era
-- calculada sozinha a cada desenho (clareando brick_color, ver
-- WallPatternConfig.topColor em game/wall.ts) -- agora é um valor
-- guardado, editável no formulário "Criar Parede" igual os outros.
--
-- Idempotente (independe de você já ter rodado essa ou não). Rode isso
-- no SQL Editor do Supabase DEPOIS de 0026_room_wall_items_thickness_brick.sql.

alter table public.room_wall_items
  add column if not exists top_color text not null default '#d8a988';
