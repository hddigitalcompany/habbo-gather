-- Ajuste do padrão de parede de sistema (ver room_wall_items em
-- 0024_room_wall_items.sql) depois do Douglas testar ao vivo a primeira
-- versão (folha 2D encostada bem na linha da divisa entre os 2 tiles):
-- "voce ficou ela na divisa, eu quero ela no meio do tile... com
-- espessura de parede, inclusive quero editar isso na criacao" -- e,
-- depois de uma migração anterior (0025) ter trocado o tijolo por cor
-- sólida por engano (interpretando "e com cor solida" como "sem
-- tijolo"): "nao era pra tirar o tijolinho kkk, e que eu achei que ele
-- tava transparente" -- ou seja, o tijolo É pra continuar, "cor sólida"
-- era só sobre a face de CIMA (a que representa a espessura).
--
-- Esta migração deixa a tabela correta INDEPENDENTE de você já ter
-- rodado a 0025 ou não (todo comando usa "if exists"/"if not exists"):
-- garante thickness_px + as colunas de tijolo/argamassa de volta, e
-- remove a coluna "color" (cor sólida) que não é mais usada.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de 0024_room_wall_items.sql
-- (tenha rodado 0025 ou não, tanto faz).

alter table public.room_wall_items
  add column if not exists thickness_px numeric not null default 10 check (thickness_px >= 1 and thickness_px <= 60),
  add column if not exists brick_width_px numeric not null default 24 check (brick_width_px >= 4 and brick_width_px <= 200),
  add column if not exists brick_height_px numeric not null default 14 check (brick_height_px >= 4 and brick_height_px <= 100),
  add column if not exists brick_color text not null default '#b5502e',
  add column if not exists mortar_color text not null default '#d9d2c8',
  add column if not exists mortar_width_px numeric not null default 2 check (mortar_width_px >= 0 and mortar_width_px <= 20);

alter table public.room_wall_items drop column if exists color;
