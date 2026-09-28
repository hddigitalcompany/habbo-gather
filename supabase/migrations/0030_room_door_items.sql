-- Editor de Itens: cadastro de porta customizada (pedido do Douglas:
-- "vamos criar uma nova categoria 'porta'... porque ela precisa abrir de
-- diferentes formas: por proximidade... [e] o dono da area em questao,
-- pode bloquear ela"). Categoria SEPARADA de parede/móvel, tabela
-- PRÓPRIA -- porta pinta uma ARESTA da grade igual parede (ver
-- comentário grande em game/door.ts), mas SEMPRE com arte (o Douglas vai
-- subir as imagens -- "eu subirei a arte"), nunca um padrão desenhado
-- por código como a parede "padrão" -- por isso, ao contrário de
-- room_wall_items, aqui não tem campo de tijolo/cor nenhum, só URL de
-- imagem por lado (esq/dir, ver DoorFacing em game/door.ts) x estado
-- (aberta/fechada) -- 4 colunas de imagem no total, as de lado "dir"
-- opcionais (caem pro "esq" até o Douglas subir a versão espelhada,
-- mesmo fallback que móvel já usa pra facing sem arte própria).
--
-- Só existem portas de correr por enquanto (pedido do Douglas: "por
-- enquanto, so terá porta de correr"), em 2 variantes (1 ou 2 folhas) --
-- ver DoorKind em game/door.ts. A diferença entre elas é só de ARTE (não
-- muda nenhuma coluna/lógica aqui), então "kind" é só uma tag de
-- organização do catálogo/formulário "Criar Porta".
--
-- Rode isso no SQL Editor do Supabase DEPOIS de já ter rodado
-- 0001_accounts.sql (depende de public.room_members existir).

create table if not exists public.room_door_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  -- bate com DoorKind em game/door.ts ("correr-1-folha"/"correr-2-folhas")
  kind text not null check (kind in ('correr-1-folha', 'correr-2-folhas')),
  art_left_closed text not null,
  art_left_open text not null,
  art_right_closed text,
  art_right_open text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.room_door_items enable row level security;

-- leitura PÚBLICA (mesma regra de room_wall_items/room_floor_items/
-- room_items -- visitante sem conta também precisa ver a porta erguida
-- na sala).
create policy "room_door_items: leitura pra todo mundo" on public.room_door_items
  for select to public using (true);

-- sem policy de insert/update/delete pro público -- só a service role
-- (usada em app/api/door-items/**, que confere permissão de owner ANTES
-- de mexer aqui) pode escrever, mesma regra das outras tabelas de item.
