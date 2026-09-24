-- Tom de pele CUSTOMIZADO, cadastrado pelo dono da sala direto pela tela
-- (Editor de Itens, botão "Criar Avatar" -- ver components/ItemEditor.tsx
-- e app/api/avatar-skins/**), sem precisar subir arquivo na pasta local e
-- rodar `npm run sync-assets` -- pedido do Douglas: "quero subir os
-- personagens DENTRO da plataforma".
--
-- Mesmo esquema do room_items (0002_room_items.sql): diferente do
-- catálogo "de fábrica" (game/skinCatalog.generated.ts, gerado a partir
-- da pasta local em build-time, ver scripts/syncSkinAssets.mjs), esses
-- tons vivem só no banco/Storage e chegam pro jogo em TEMPO DE EXECUÇÃO,
-- buscados assim que a sala carrega (ver fetchCustomAvatarSkins em
-- GameRoom.tsx / registerCustomSkins em game/customization.ts). RODA
-- JUNTO com a pasta local (pedido do Douglas: "duplicar sem perder o
-- outro") -- não mexe em nada do que já existe, só soma.
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de public.room_members existir).
--
-- Storage: REUSA o bucket "room-items" que 0002_room_items.sql já criou
-- (path "avatar-skins/..." em vez de solto na raiz) -- as policies de
-- insert/delete de lá checam só `bucket_id = 'room-items'` + dono da
-- sala, sem filtrar por caminho dentro do bucket, então já cobrem esse
-- upload novo sem precisar de bucket nem policy própria.

-- `art` guarda a URL pública (Storage) de UM PNG já composto em folha
-- (8 colunas x 2 linhas, 200x260 por quadro -- mesmo formato de
-- public/assets/avatar_<tom>.png que scripts/syncSkinAssets.mjs gera),
-- montado no NAVEGADOR a partir das até 4 fotos que a pessoa sobe
-- (frente/lado esq/lado dir/costas -- mesma convenção "só a cabeça" da
-- pasta local, ver ItemEditor.tsx) antes de enviar -- só uma URL, não um
-- mapa de direção como em room_items.art, porque aqui o navegador já
-- entrega o resultado final pronto pro Phaser carregar como spritesheet.
create table if not exists public.avatar_skins (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  gender text not null check (gender in ('masculino', 'feminino')),
  sheet_url text not null,
  hex text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.avatar_skins enable row level security;

-- leitura PÚBLICA (não só "authenticated") -- visitante sem conta também
-- precisa ver o avatar de quem escolheu um tom customizado.
create policy "avatar_skins: leitura pra todo mundo" on public.avatar_skins
  for select to public using (true);
