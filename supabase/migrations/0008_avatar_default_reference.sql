-- "Avatar Padrão": UM boneco de referência fixo por sexo (masculino /
-- feminino), montado pelo Douglas (cabeça + traje/corpo LIMPO) e usado
-- pelo EDITOR (Editor de Itens, aba "Avatar Padrão" -- ver
-- components/ItemEditor.tsx e app/api/avatar-default-reference/**) como
-- boneco de fundo ao criar cabelo/acessório/barba/traje -- NUNCA aparece
-- pro jogador, é só ferramenta de alinhamento. Pedido do Douglas: "esse
-- padrao voce coloca ele inteiro montado no editor quando eu for criar
-- outros... eu uso ele exatamente de referencia sempre, pra tudo em
-- avatares".
--
-- `gender` é PRIMARY KEY -- só pode ter UM registro por sexo (pedido:
-- "só pode ter UMA em cada um deles"); cadastrar de novo faz upsert
-- (ver POST em app/api/avatar-default-reference/route.ts), substituindo
-- o anterior.
--
-- `head_sheet_url`/`body_sheet_url` guardam cada uma a URL pública
-- (Storage) de um PNG já composto em folha (8x2, 200x260/quadro -- mesmo
-- formato de avatar_skins.sheet_url), montadas no NAVEGADOR a partir das
-- fotos que o Douglas sobe (cabeça = só a cabeça, mesma convenção de
-- avatar_skins; traje = o "corpo limpo", ou seja o traje_nenhum de
-- referência) -- ver composeAvatarArtSheet em ItemEditor.tsx.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de public.room_members existir).
--
-- Storage: REUSA o bucket "room-items" que 0002_room_items.sql já criou
-- (path "avatar-default-reference/..." em vez de solto na raiz) -- as
-- policies de insert/delete de lá checam só `bucket_id = 'room-items'` +
-- dono da sala, sem filtrar por caminho dentro do bucket, então já
-- cobrem esse upload novo sem precisar de bucket nem policy própria.
create table if not exists public.avatar_default_reference (
  gender text primary key check (gender in ('masculino', 'feminino')),
  head_sheet_url text not null,
  body_sheet_url text not null,
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

alter table public.avatar_default_reference enable row level security;

-- leitura PÚBLICA (mesmo padrão de avatar_skins) -- embora hoje só o
-- editor (dono da sala) use isso, não custa deixar consistente/simples.
create policy "avatar_default_reference: leitura pra todo mundo" on public.avatar_default_reference
  for select to public using (true);
