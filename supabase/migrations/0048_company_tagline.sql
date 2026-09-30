-- "Tagline" (frase de impacto) da empresa -- pedido do Douglas, 30/set
-- (17): "adiciona no perfil da empresa Tagline: que e a frase de
-- impacto da empresa, ela aparecera assim no card, logo acima do quem
-- somos" (mandou print de referência: texto grande, em caixa alta,
-- negrito, branco -- ver .company-card-tagline em app/globals.css).
-- Texto simples (igual bio/handle/link), sem molde nenhum.
--
-- RODAR NO SQL EDITOR DO SUPABASE ANTES DO DEPLOY (mesmo aviso de
-- sempre).
alter table public.rooms add column if not exists company_tagline text not null default '';
