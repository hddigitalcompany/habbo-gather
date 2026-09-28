-- Persistência do PISO/PAREDE/PORTA/ÁREA/MOBÍLIA da sala, movida do
-- disco local do servidor WebSocket (server/roomStore.js, arquivo
-- data/room.json) pro Supabase -- achado na prática hoje (28/set):
-- criar um serviço novo no Render pro ambiente de staging nasce SEM
-- esse arquivo (disco local não é compartilhado nem sobrevive a um
-- serviço recriado do zero), e mesmo em produção esse disco é frágil
-- (Render free tier não garante disco persistente entre deploys) --
-- Douglas viu isso na prática: sala staging nasceu vazia, teve que
-- decorar de novo. Essa migration cria a tabela; a troca de fato (ler/
-- escrever daqui em vez do arquivo) é em server/roomStore.js.
--
-- Guarda o ESTADO INTEIRO da sala como um blob JSONB (mesmo formato
-- que já existia no JSON em disco: { floor, walls, doors, areaDefs,
-- areaTiles, areaOwners, furniture, furnitureSeatOffsets }), chaveado
-- por `room_slug` -- string simples (hoje sempre "sala-principal",
-- mesmo valor hardcoded no PartySocket do cliente, ver comentário
-- grande em server/roomStore.js) em vez de referenciar public.rooms.id
-- de propósito: o servidor WebSocket (server/index.js) ainda não foi
-- migrado pra multi-tenant de verdade (Task #63 maior, ainda
-- pendente) -- essa migration resolve só a DURABILIDADE (não perder
-- dado a cada redeploy/serviço novo), sem mexer na arquitetura de
-- sala única por enquanto. Quando o roomId de verdade entrar em cena,
-- essa tabela troca `room_slug` por uma referência a public.rooms.id
-- numa migration futura.
--
-- Sem policy nenhuma de leitura/escrita pro público -- só a service
-- role (usada por server/roomStore.js, que já roda num processo
-- confiável, não numa rota pública) mexe aqui, mesma regra de
-- room_items/room_wall_items/room_door_items (catálogos), só que essa
-- tabela nem precisa de leitura pública: o cliente sempre busca o
-- estado da sala pelo servidor WebSocket (GET /room/floor etc, ver
-- server/index.js), nunca direto do Supabase.
create table if not exists public.room_layout_state (
  room_slug text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.room_layout_state enable row level security;
