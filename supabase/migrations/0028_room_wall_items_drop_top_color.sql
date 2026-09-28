-- Reverte 0027_room_wall_items_top_color.sql -- a cor da face de
-- CIMA/topo da parede de sistema chegou a virar campo próprio (pedido
-- do Douglas: "quero escolher a cor do topo"), mas testando ao vivo com
-- uma cor de fato diferente do tijolo (print: tira rosa clara destoando
-- do tijolo terracota) ele voltou atrás: "os topos devem ser
-- preenchidos igual a cor da face da parede, um pouco mais escuro por
-- um efeito de sombra" -- ou seja, CALCULADA a partir de brick_color
-- (escurecida), sem campo próprio nenhum (ver createWallPatternGraphics
-- em MainScene.ts).
--
-- Idempotente (independe de você já ter rodado 0027 ou não). Rode isso
-- no SQL Editor do Supabase DEPOIS de 0027_room_wall_items_top_color.sql
-- (tenha rodado ela ou não, tanto faz).

alter table public.room_wall_items drop column if exists top_color;
