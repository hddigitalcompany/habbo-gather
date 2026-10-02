-- Novo tipo de TEXTURA pra parede de sistema "padrão" (ver
-- room_wall_items em 0024_room_wall_items.sql, WallPatternConfig em
-- game/wall.ts) -- pedido do Douglas, com foto de referência (parede de
-- madeira com 3 painéis horizontais, separados por 2 frisos/emendas
-- visíveis): "quero deixar a parede com efeito de paineis, direto nela"
-- + confirmado como opção reusável de textura (não um hack de uma
-- parede só): "obviamente isso como opcao de textura né".
--
-- "brick" (tijolo em fileiras desencontradas, comportamento de sempre)
-- continua sendo o default -- toda linha já cadastrada nasce "brick"
-- sem precisar editar nada. "panel" é o novo tipo (faixas horizontais
-- de largura total, sem amarração -- ver wallPanelRects em
-- game/wall.ts), que REAPROVEITA os campos de tijolo/argamassa já
-- existentes (brick_height_px vira "altura do painel", mortar_width_px
-- vira "largura do friso", etc. -- ver comentário grande de
-- WallTextureKind em game/wall.ts) -- por isso essa migração só
-- precisa de UMA coluna nova, nenhuma outra.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de
-- 0029_room_wall_items_top_color_v2.sql (ou de qualquer migração mais
-- recente de room_wall_items que você já tenha rodado -- idempotente,
-- "if not exists").

alter table public.room_wall_items
  add column if not exists texture_kind text not null default 'brick' check (texture_kind in ('brick', 'panel'));
