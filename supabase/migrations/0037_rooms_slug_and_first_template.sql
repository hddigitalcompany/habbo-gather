-- room_slug: liga cada linha de public.rooms (criada em 0032_rooms.sql)
-- ao slug usado hoje no mecanismo multi-sala do servidor (ver
-- comentário grande "MULTI-SALA" em server/roomStore.js --
-- Map<roomSlug, store>, cada slug é uma sala independente com seu
-- próprio piso/parede/porta/área/mobília em room_layout_state). Até
-- agora nenhuma linha de `rooms` apontava pra um slug de verdade (a
-- "Sala Principal" inserida em 0033_room_scoped_membership.sql não
-- tinha essa coluna ainda) -- essa migration fecha esse elo. Toda sala
-- NOVA (clonada de um template pra um cliente, ver POST
-- /api/room/create-from-template) grava aqui o PRÓPRIO id (uuid, já
-- único por ser a chave primária) como room_slug -- simples, sem
-- precisar gerar/reservar nada à parte, e o padrão de slug
-- (letras/números/hífen) já aceita uuid de fábrica (ver SLUG_PATTERN
-- em server/roomStore.js).
alter table public.rooms add column if not exists room_slug text unique;

-- backfill da sala única de hoje (inserida em 0033, sem room_slug
-- ainda) -- mesmo slug fixo de sempre ("sala-principal", ver
-- DEFAULT_ROOM_SLUG em server/roomStore.js e PartySocket em
-- GameRoom.tsx).
update public.rooms
set room_slug = 'sala-principal'
where is_template = false and name = 'Sala Principal' and room_slug is null;

-- primeiro modelo de verdade -- o "Mapa Modelo" que já existe hoje no
-- servidor com slug fixo "mapa-modelo" (ver ROOM_SLUGS em
-- components/Lobby.tsx e DEFAULT_ROOM_SLUG/comentário grande
-- "MULTI-SALA" em server/roomStore.js), agora ganhando uma linha de
-- catálogo de verdade em `rooms`. Publicado direto (template_status=
-- 'published') pra já aparecer no catálogo de escolha do cliente (GET
-- /api/room/templates) assim que essa migration rodar, mesmo sem
-- decoração nenhuma ainda (Douglas: "ja pode criar um, mesmo que sem
-- decoracao"). owner_user_id fica NULL de propósito -- dono
-- conceitual de um template é o Douglas via isPlatformAdmin, não
-- precisa de uma linha de dono aqui (mesmo espírito do comentário
-- original em 0032_rooms.sql). "where not exists" evita duplicar essa
-- linha se essa migration rodar de novo.
insert into public.rooms (name, is_template, template_status, room_slug)
select 'Mapa Modelo', true, 'published', 'mapa-modelo'
where not exists (select 1 from public.rooms where room_slug = 'mapa-modelo');
