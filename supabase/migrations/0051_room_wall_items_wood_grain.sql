-- Efeito de veio de madeira pra textura "panel" (ver
-- WallPatternConfig.woodGrain em game/wall.ts, wallPanelGrainShapes) --
-- mesmo nome/ideia de wood_grain em room_floor_items (ver
-- 0018_room_floor_items_wood_grain.sql), o piso já tinha exatamente
-- essa escolha (tábua lisa vs. com veio).
--
-- Pedido do Douglas, vendo o 1º painel liso demais: "cade a madeira os
-- veios? kkk", esclarecido como 2 opções de verdade: "paineis de
-- madeira, paineis normal liso" -- por isso é TOGGLE (não automático
-- com a textura "panel"), default false ("liso", mesmo default do
-- piso) pra nenhuma parede já cadastrada mudar de visual sozinha.
-- Ignorado pra textura "brick" (tijolo nunca teve veio).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de
-- 0050_room_wall_items_texture_kind.sql.

alter table public.room_wall_items
  add column if not exists wood_grain boolean not null default false;
