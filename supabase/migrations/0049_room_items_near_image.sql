-- Pedido do Douglas: "por proximidade, a um tile de distancia, o objeto
-- muda, muda pra outra imagem que eu vou adicionar a ele" -- uma
-- imagem opcional, por item (não por direção/cor, uma só), que substitui
-- a arte normal enquanto algum avatar estiver a 1 tile de distância do
-- móvel (ver FurnitureModelDef.nearImageUrl em game/furniture.ts e
-- updateFurnitureProximityState em game/MainScene.ts). null (padrão) =
-- sem efeito de proximidade nenhum, comportamento de sempre.
--
-- Mesmo esquema de icon_url (0004_room_items_icon_offset.sql): upload
-- separado via Editor de Itens, guardado como URL pública do Storage
-- (bucket room-items), null = desligado/não configurado.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado as
-- migrations anteriores (até 0048).
alter table public.room_items
  add column if not exists near_image_url text;
