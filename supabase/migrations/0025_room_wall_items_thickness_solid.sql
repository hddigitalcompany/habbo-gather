-- Ajuste do padrão de parede de sistema (ver room_wall_items em
-- 0024_room_wall_items.sql) depois do Douglas testar ao vivo a primeira
-- versão (tijolo, folha 2D encostada bem na linha da divisa entre os 2
-- tiles): "voce ficou ela na divisa, eu quero ela no meio do tile, e com
-- cor solida, e com espessura de parede, inclusive quero editar isso na
-- criacao, mas ta legal esse e o caminho".
--
-- Troca o tijolo/argamassa por uma cor sólida só, e adiciona uma
-- ESPESSURA de verdade (metade fica de cada lado da divisa, dando volume
-- à parede em vez de uma folha fina -- ver WallPatternConfig em
-- game/wall.ts e createWallPatternGraphics em game/MainScene.ts).
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0024_room_wall_items.sql. Os valores padrão abaixo (10px de espessura,
-- marrom) só preenchem retroativamente a(s) parede(s) já cadastrada(s)
-- ANTES desse ajuste -- edite pela aba "Criar Parede" se quiser mudar.

alter table public.room_wall_items
  drop column if exists brick_width_px,
  drop column if exists brick_height_px,
  drop column if exists brick_color,
  drop column if exists mortar_color,
  drop column if exists mortar_width_px;

alter table public.room_wall_items
  add column if not exists thickness_px numeric not null default 10 check (thickness_px >= 1 and thickness_px <= 60),
  add column if not exists color text not null default '#8a6d4b';
