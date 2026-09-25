-- Variantes de COR de um item de avatar (cabelo/acessório/traje) --
-- pedido do Douglas: "cria essa ferramenta por seleção" (depois de
-- recusar tanto máscara fixa por coordenada quanto redesenhar cada
-- peça à mão, ver conversa no chat). Continuação de
-- 0006_avatar_items.sql.
--
-- Cada variante é GERADA pelo ColorZoneTool.tsx (Editor de Itens) sem
-- desenho novo: o Douglas pinta por cima do quadro de frente marcando
-- "isso é zona X", escolhe o hex alvo de cada zona, e o sistema recolore
-- a folha inteira (todos os 15 quadros) sozinho -- ver
-- game/colorTint.ts pro algoritmo. O resultado é uma folha PRONTA (PNG,
-- mesmo formato 8x2/200x260 de sempre) igual a qualquer outra arte de
-- item -- `colors` só guarda a LISTA dessas folhas geradas, cada uma
-- com id/label/hex (pro swatch)/file (URL no Storage), MESMO formato
-- de ColorOption em game/customization.ts.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0006_avatar_items.sql.
alter table public.avatar_items
  add column if not exists colors jsonb not null default '[]'::jsonb;
