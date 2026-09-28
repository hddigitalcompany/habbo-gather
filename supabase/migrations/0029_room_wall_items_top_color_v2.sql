-- Reintroduz a cor do topo da parede de sistema (ver
-- 0027_room_wall_items_top_color.sql / 0028_room_wall_items_drop_top_color.sql,
-- room_wall_items em 0024_room_wall_items.sql) -- dessa vez com o
-- ESCOPO esclarecido pelo Douglas, separando 2 faces que antes usavam
-- a mesma cor calculada:
--   "a cor encima da parede eu quero escolher" -- a face de CIMA/topo
--   (plana, olhando pra cima) passa a usar este campo (top_color),
--   igual antes de 0028.
--   "a cor da face na espessura vertical é a cor que segue da parede"
--   -- as faces de PONTA/lateral (que fecham a espessura da parede nas
--   pontas soltas, ver createWallPatternGraphics em game/MainScene.ts)
--   continuam CALCULADAS a partir de brick_color escurecido, sem campo
--   próprio nenhum -- não leem top_color.
--
-- Default abaixo = brick_color padrão ('#b5502e') já escurecido pelo
-- mesmo fator de sombra (darkenColor(..., 0.8), ver
-- WallPatternSwatch.tsx/MainScene.ts) -- só pra linha já existente (ou
-- nova sem valor enviado) nascer com uma cor coerente, igual o efeito
-- "sombra" de antes, até o dono editar pelo formulário "Criar Parede".
--
-- Idempotente (independe de você ter rodado 0027/0028 ou não). Rode
-- isso no SQL Editor do Supabase DEPOIS de
-- 0028_room_wall_items_drop_top_color.sql (tenha rodado ela ou não,
-- tanto faz).

alter table public.room_wall_items
  add column if not exists top_color text not null default '#914025';
