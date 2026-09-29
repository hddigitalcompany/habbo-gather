-- Editor de Itens, aba "Criar Porta": tamanho da porta editável, igual
-- o "Tamanho no jogo" que móvel já tem (pedido do Douglas: "quero
-- editar a dimensao dos arquivos que subo nelas tambem, com tile e ta;
-- igual os mobis normais"). ANTES a largura de exibição da porta era
-- SEMPRE forçada a bater exatamente com doorEdgeLengthPx (a largura de
-- uma aresta da grade, ver addDoorSprite em game/MainScene.ts) -- sem
-- nenhum jeito de ajustar, nem maior nem menor.
--
-- Coluna NULLABLE de propósito: null = comportamento de sempre (encaixa
-- exatamente no vão da aresta, mesmo fallback que toda porta já
-- cadastrada antes dessa coluna existir continua usando sem precisar
-- editar nada). Preenchida = usa esse valor (px) como largura de
-- exibição, mesma técnica de setDisplaySize que já existia -- a altura
-- continua calculada a partir da proporção NATIVA de cada imagem (não
-- trava altura junto, só a largura, igual o resto do jogo já faz).
--
-- Uma porta só tem UM valor (não um por lado esq/dir, diferente do
-- footprint/tamanho por direção de móvel): os dois lados são a MESMA
-- porta física vista de ângulos opostos -- não faz sentido físico o
-- vão parecer mais largo de um lado que do outro.
--
-- Rode isso no SQL Editor do Supabase.

alter table public.room_door_items
  add column if not exists display_width_px integer;
