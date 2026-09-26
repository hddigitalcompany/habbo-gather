-- Correção do Douglas depois que eu cadastrei 2 pisos "padrão" de
-- fábrica com cores que eu mesmo chutei a partir das fotos de
-- referência que ele mandou: "eu nao defini as cores, so mandei
-- exemplo, quero criar eles el criar piso" -- as fotos eram só EXEMPLO
-- do ESTILO (tábua emendada com junta, tábua mesclada), não uma
-- especificação de cor. Removi os 2 de fábrica (ver game/floor.ts) e
-- trago os mesmos recursos pra cá, pro Douglas criar ele mesmo, com as
-- cores que ele quiser, pela aba "Criar Piso" -> "Padrão":
--
-- - plank_length_px: comprimento de cada tábua (junto com
--   plank_width_px, que já existia) -- quando preenchido, a ripa vira
--   tábuas EMENDADAS com linha de junta visível (ver
--   FloorPatternConfig.plankLengthPx em game/floor.ts), em vez da ripa
--   contínua de sempre. Deixar em branco mantém o comportamento antigo.
-- - line_color: cor da linha de junta entre tábuas (só usada quando
--   plank_length_px está preenchido). Deixar em branco usa uma
--   variação escura de color_a, calculada sozinha.
-- - colors: paleta de cores (array de hex "#rrggbb") pra pintar cada
--   tábua de um tom (determinístico, não muda sozinho) sorteado dessa
--   lista, em vez de só alternar color_a/color_b por coluna -- pro
--   efeito "Tábua Mesclada" (várias tonalidades). Deixar vazio/null
--   mantém o comportamento de 2 cores (color_a/color_b) de sempre.
--
-- Rode isso DEPOIS de já ter rodado 0015 e 0016.

alter table public.room_floor_items
  add column if not exists plank_length_px integer,
  add column if not exists line_color text,
  add column if not exists colors jsonb;
