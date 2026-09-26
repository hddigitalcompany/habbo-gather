-- Piso "padrão" -- pedido do Douglas (mandou foto de um piso de tacos e
-- perguntou): "precisamos de algo leve pro piso, pois vai encubrir toda
-- a sala... criamos ali dentro uma forma de preenchimento de linhas...
-- cada uma com uma sombra que muda a cor embaixo dela ja fixa... pra
-- que nao precise ser imagem mesmo, faz sentido? ficaria mais leve?" --
-- resposta: sim, e sim. Modelo de piso SEM arquivo de imagem nenhum,
-- desenhado direto por código (ripas alternando 2 cores, ver
-- FloorPatternConfig em game/floor.ts e createFloorPatternGraphics em
-- game/MainScene.ts) -- mais leve (zero download/textura) e as ripas
-- de tiles vizinhos do mesmo estilo continuam perfeitamente uma na
-- outra (parece piso corrido de verdade, não um carimbo repetido).
--
-- Rode isso DEPOIS de já ter rodado 0015_room_floor_items.sql.

alter table public.room_floor_items
  add column if not exists kind text not null default 'image' check (kind in ('image', 'pattern')),
  add column if not exists plank_width_px integer,
  -- cores em hex "#rrggbb" (string, não integer -- mais fácil de olhar/
  -- editar direto numa consulta SQL se precisar, e o cliente já
  -- trabalha com <input type="color"> nesse formato, sem conversão).
  add column if not exists color_a text,
  add column if not exists color_b text;

-- file_url deixa de ser obrigatório -- só faz sentido pra kind='image'
-- (kind='pattern' não tem imagem nenhuma). A obrigatoriedade dos campos
-- certos por kind é conferida na API (app/api/floor-items/route.ts),
-- não aqui -- mesmo padrão do resto do projeto (o banco confia na API,
-- que já confere role de owner antes de mais nada).
alter table public.room_floor_items alter column file_url drop not null;
