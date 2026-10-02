-- Textura de VERDADE (imagem) pra face da frente do painel "padrão"
-- (ver WallPatternConfig.textureImageUrl em game/wall.ts) -- pedido do
-- Douglas depois de brigar com veio de madeira desenhado por código:
-- "eu nao to desenhando nao, o chat que ta gerando mas ele e pessimo
-- com angulo e tamanho... eu queria ela de textura direto na parede
-- que ja tem". Em vez de reimplementar a parede como sprite solto
-- (caminho que já existe, ver room_wall_items vs WALL_CATALOG com
-- `file` em game/wall.ts), a imagem entra como mais um campo opcional
-- do MESMO painel "padrão": quando presente, o motor ladrilha essa
-- imagem (repetindo sozinha, tamanho nativo dela = 1 ladrilho) por
-- cima da face da frente, no lugar do preenchimento liso/com veio por
-- código -- resolve de vez o problema de ângulo/tamanho (a imagem não
-- precisa bater com nada, só repete).
--
-- A imagem em si já sobe direto pro Storage (bucket "room-items",
-- pasta "parede-textura/", mesmo padrão de porta/mobi/piso -- ver
-- handleWallSubmit em components/ItemEditor.tsx) ANTES dessa coluna
-- ser gravada -- aqui só guarda a URL pública.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de
-- 0051_room_wall_items_wood_grain.sql.

alter table public.room_wall_items
  add column if not exists texture_image_url text;
