-- "Card da Empresa" (Empresas Posicionadas / vitrine no Lobby) virando
-- de verdade -- pedido do Douglas (29/set (7)): "quero cada card de
-- empresa atrelado a um espaco". Até aqui era um MOLDE fixo, só local
-- (localStorage, mesmo navegador, sem ligação nenhuma com qual sala
-- era qual -- ver comentário grande do CompanyProfile em
-- components/Lobby.tsx antes dessa mudança). Agora cada linha de
-- public.rooms (cada ESPAÇO/empresa, is_template=false) ganha seus
-- próprios campos de card -- o "Nome fantasia" continua sendo a
-- coluna `name` que já existe (mesma que aparece em "Meus espaços" e
-- na aba "Empresa" do chat, ver 0032_rooms.sql/create-from-template),
-- não duplicado aqui.
--
-- Aditivo, mesmo espírito das migrations anteriores desse arquivo:
-- toda coluna nova tem default, então nenhuma sala existente quebra
-- -- só nasce com o card "em branco" (a pessoa preenche depois pelo
-- painel "Editar Empresa", agora salvando aqui em vez de
-- localStorage).
-- SEM "not null" de propósito (só "default", pra INSERT novo já
-- nascer preenchido) -- as 3 salas que já existem (Sala Principal +
-- as de teste) ficariam sem valor nenhum pra preencher numa coluna
-- nova obrigatória, e isso travaria a transação inteira (foi
-- exatamente o que aconteceu numa tentativa anterior, ver
-- ERROR 23502). O código em app/api/room/company-profile/route.ts já
-- trata null como se fosse o padrão (?? "", ?? true, ?? 0), então não
-- precisa da constraint pra funcionar direito.
alter table public.rooms add column if not exists company_handle text default '';
alter table public.rooms add column if not exists company_bio text default '';
alter table public.rooms add column if not exists company_link text default '';
-- imagens continuam em base64 (mesmo formato que já era usado no
-- localStorage, ver compressSquarePhotoToDataUrl/
-- compressBannerPhotoToDataUrl em components/Lobby.tsx) -- sem bucket
-- de storage de verdade ainda, texto guarda o data: URL inteiro.
alter table public.rooms add column if not exists company_logo_url text;
alter table public.rooms add column if not exists company_banner_url text;
-- "Posicione a sua empresa:" (multi-seleção, ver COMPANY_CATEGORIES
-- em components/Lobby.tsx) -- array de texto, uma entrada por
-- categoria marcada.
alter table public.rooms add column if not exists company_category text[] default '{}';
-- "Permitir exibição do nome da empresa do perfil dos colaboradores?"
alter table public.rooms add column if not exists company_show_name_on_employee_profiles boolean default true;
-- contador de "Seguidores" mostrado no card -- só um número guardado
-- (não é um relacionamento de verdade tipo public.followers, que é
-- entre PESSOAS -- ver 0039_followers.sql) -- mesmo espírito mock que
-- já era (DEFAULT_COMPANY_PROFILE.followers = 57 no molde antigo),
-- só que agora por sala em vez de fixo; nasce em 0 pra sala nova de
-- verdade.
alter table public.rooms add column if not exists company_followers integer default 0;

-- SEM policy nova de leitura/escrita pro público -- mesma regra que
-- já vale pro resto de `rooms` (0032_rooms.sql): só a service role
-- mexe aqui, sempre via app/api/room/** (agora também
-- app/api/room/company-profile).
