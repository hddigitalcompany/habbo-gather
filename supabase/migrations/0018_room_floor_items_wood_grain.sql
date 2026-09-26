-- Pedido do Douglas, com 2 fotos de referência de piso laminado: "agora
-- eu quero esse efeito laminado, como voce conseguiria fazer? de veios
-- de madeira", depois "no sentido das linhas também" (o veio corre no
-- mesmo sentido do comprimento da tábua, igual as linhas de junta
-- longas entre colunas).
--
-- - wood_grain: liga/desliga o efeito (riscos finos e semitransparentes
--   dentro de cada tábua, mais claros/escuros que a cor dela, sorteados
--   de forma determinística por tábua -- ver FloorPatternConfig.woodGrain
--   em game/floor.ts e woodGrainShapesForPlank, a mesma função pura
--   usada tanto pelo preview do formulário quanto pelo jogo de
--   verdade). Só tem efeito junto de plank_length_px (0017) preenchido
--   -- ripa contínua não tem tábua delimitada pra conter o veio dentro.
--   false por padrão -- não muda a aparência de nenhum piso já
--   cadastrado.
--
-- Rode isso DEPOIS de já ter rodado 0015, 0016 e 0017.

alter table public.room_floor_items
  add column if not exists wood_grain boolean not null default false;
