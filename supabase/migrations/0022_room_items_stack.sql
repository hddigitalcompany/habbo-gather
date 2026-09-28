-- "Sobrepor" -- pedido do Douglas: "cada item, ex: mesa mesinha de
-- centro, eu teria que configurar, a altura de um segundo item,
-- adicionado ao tile dele" + "esse item que eu não tickar a opção de
-- sobrepor, continua igual tá agora, ele não deixa por outro item no
-- mesmo quadrado" (caso de uso: notebook em cima de uma mesa, sem travar
-- a posição de nenhum dos dois -- ver anyFurnitureAt/addFurnitureSprite
-- em game/MainScene.ts).
--
-- stackable: esse item (ex: notebook) pode ser colocado em cima de OUTRO
-- já ancorado no mesmo tile -- falso (padrão) = tile ocupado bloqueia
-- igual sempre bloqueou, comportamento de sempre.
-- stack_surface_offset_y: altura (px) da SUPERFÍCIE desse item (ex: a
-- mesa) -- some no deslocamento de quem for colocado "Sobrepor" em cima
-- dela. 0 (padrão) = sem superfície configurada. Mesma faixa -300..300
-- de um offset comum (ver clampItemOffset em lib/supabase/itemFields.ts).
--
-- Rode isso no SQL Editor do Supabase.
alter table public.room_items
  add column if not exists stackable boolean not null default false,
  add column if not exists stack_surface_offset_y integer not null default 0;

-- "add constraint if not exists" não existe no Postgres (só "add column"
-- aceita esse "if not exists") -- "drop ... if exists" antes garante que
-- rodar essa migration de novo por engano não quebra com "constraint já
-- existe" (mesmo padrão de 0020_room_items_display_width_max.sql).
alter table public.room_items
  drop constraint if exists room_items_stack_surface_offset_y_check;

alter table public.room_items
  add constraint room_items_stack_surface_offset_y_check
  check (stack_surface_offset_y between -300 and 300);
