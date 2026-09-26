-- Aumenta o teto de display_width (ver 0003_room_items_display_width.sql)
-- de 600 pra 1200px -- pedido do Douglas trabalhando nas paredes
-- ("Criar Parede", ver ItemEditor.tsx): "vou precisar de mais opcoes de
-- escala no redimensionamento ali dentro do editar, mais uma linha ja
-- bate" -- uma parede cobrindo boa parte do fundo da sala é bem mais
-- larga que qualquer móvel, e 600px (uns 4-5 tiles, ISO_TILE_WIDTH=128)
-- já batia no teto do slider "Tamanho no jogo" (DISPLAY_WIDTH_MAX em
-- ItemEditor.tsx).
--
-- A constraint original (0003) foi criada SEM nome, junto da coluna
-- (`add column ... check (...)`) -- o Postgres nomeia esse tipo de
-- constraint sozinho como "<tabela>_<coluna>_check", por isso o drop
-- abaixo usa esse nome padrão (com "if exists", por segurança caso o
-- nome real tenha saído diferente por algum motivo).
--
-- Rode isso DEPOIS de já ter rodado 0003_room_items_display_width.sql
-- (e, de resto, toda a cadeia até 0019 -- não depende delas, mas segue
-- a ordem de sempre).
alter table public.room_items
  drop constraint if exists room_items_display_width_check;

alter table public.room_items
  add constraint room_items_display_width_check
  check (display_width is null or (display_width between 20 and 1200));
