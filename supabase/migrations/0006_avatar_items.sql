-- Item de avatar CUSTOMIZADO -- cabelo, acessório, barba ou traje,
-- cadastrado pelo dono da sala direto pela tela (Editor de Itens, botão
-- "Criar Avatar", categoria correspondente -- ver AvatarCreatorPanel em
-- components/ItemEditor.tsx e app/api/avatar-items/**). Continuação de
-- 0005_avatar_skins.sql (que só cobria TOM DE PELE/"Avatar") -- pedido
-- do Douglas: "avatar/cabelo/acessorio/barba/traje" como categorias
-- irmãs no mesmo fluxo de upload.
--
-- Por que uma tabela SEPARADA de avatar_skins em vez de generalizar
-- aquela: tom de pele não tem `category` nem `skin_ids` (é a PRÓPRIA
-- definição de um tom -- não "aplica pra" um tom, ele MÓ é o tom), e já
-- tem gente usando avatar_skins (skins cadastrados antes dessa
-- migration) -- mexer no formato dela é risco sem necessidade real.
--
-- `skin_ids`: pra barba/traje, a lista de tons de pele (id de
-- avatar_skins/game/skinCatalog.generated.ts) que essa peça cobre --
-- pedido do Douglas: "selecionar pra qual cor vai: branco pardo negro,
-- podendo selecionar todos" -- marcados no Editor de Itens como
-- checkbox por tom JÁ EXISTENTE (do sexo escolhido), todos apontando
-- pra MESMA folha (sheet_url) -- não tem arte diferente por tom aqui
-- (diferente do traje/barba da pasta local, que tem uma pasta de
-- imagem por tom -- esse é o upload RÁPIDO, reaproveita a mesma arte).
-- Pra cabelo/acessório fica vazio/sem uso (a arte deles nunca mudou por
-- tom de pele, ver bySkin em game/customization.ts) -- guardado mesmo
-- assim só pra manter o esquema igual nas 4 categorias.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql e 0005_avatar_skins.sql.
--
-- Storage: REUSA o bucket "room-items" (mesma lógica de
-- 0005_avatar_skins.sql -- as policies de insert/delete checam só
-- bucket_id + dono da sala, sem filtrar caminho), path
-- "avatar-items/<categoria>-<sexo>-...png".
create table if not exists public.avatar_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cabelo', 'acessorio', 'barba', 'traje')),
  gender text not null check (gender in ('masculino', 'feminino')),
  label text not null,
  skin_ids text[] not null default '{}',
  sheet_url text not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.avatar_items enable row level security;

-- leitura PÚBLICA (mesma razão de avatar_skins: visitante sem conta
-- também precisa ver o avatar de quem usa um item customizado).
create policy "avatar_items: leitura pra todo mundo" on public.avatar_items
  for select to public using (true);
