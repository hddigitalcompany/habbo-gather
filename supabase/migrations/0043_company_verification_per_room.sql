-- Selo de verificação de EMPRESA passa a ser por ESPAÇO (sala) -- pedido
-- do Douglas, 30/set, respondendo como travar "um controlador por
-- perfil empresarial verificado" e "uma empresa não pode ser
-- verificada em dois espaços" sem precisar reintroduzir CNPJ (que
-- tinha sido removido da aba "Editar Empresa" antes): "quando a
-- pessoa for verificar a empresa, aparece a selecao do espaco que
-- essa empresa esta ... e so ele selcionar o espaco que quer
-- adicionar a verificacao, e isso ja trava no card publico da
-- empresa". Ou seja: a identidade da "empresa", pra esse selo, é o
-- PRÓPRIO espaço escolhido (cada linha de rooms já é uma empresa,
-- nome fantasia = rooms.name) -- não precisa de documento oficial
-- novo, só travar 1 selo aprovado por espaço.

-- pedido de verificação de empresa agora aponta PRA QUAL espaço é
-- (null pra pedido "personal", que não é de nenhuma sala).
alter table public.verification_requests
  add column if not exists room_id uuid references public.rooms (id) on delete cascade;

alter table public.verification_requests
  drop constraint if exists verification_requests_room_matches_type;
alter table public.verification_requests
  add constraint verification_requests_room_matches_type check (
    (type = 'company' and room_id is not null) or (type = 'personal' and room_id is null)
  );

-- "um controlador por perfil empresarial verificado" + "uma empresa
-- não pode ser verificada em dois espaços" -- travado no banco (não só
-- no código): no máximo UM pedido aprovado por espaço, pra sempre.
-- Índice parcial (só conta linhas status='approved' do tipo 'company')
-- -- assim continua dando pra ter vários pedidos 'rejected' antigos
-- pro mesmo espaço sem esbarrar nesse índice, só trava quando alguém
-- (o Douglas, hoje manual pelo painel do Supabase, ver comentário
-- grande em app/api/account/verification/route.ts) tenta aprovar um
-- SEGUNDO pedido pro mesmo espaço -- o próprio banco recusa.
create unique index if not exists verification_requests_room_company_approved_unique
  on public.verification_requests (room_id)
  where type = 'company' and status = 'approved';

-- selo público NO CARD DA EMPRESA (vitrine, "Empresas Posicionadas",
-- ver .company-card-verified em components/Lobby.tsx -- até aqui era
-- um ícone FIXO, sempre aparecia, copiado do print de referência
-- "Copie EXATAMENTE TUDO... verificado, tudo"; agora vira condicional
-- de verdade nessa coluna). Fica em `rooms` (não só em
-- `profiles.verified_company`, que continua existindo pro selo
-- pessoal/de conta do usuário) porque o pedido do Douglas é claro:
-- "isso ja trava no card publico da empresa" -- o card É da sala, não
-- só da conta de quem verificou.
alter table public.rooms add column if not exists company_verified boolean not null default false;

-- Aprovação continua manual (mudar `status` pra 'approved' direto na
-- tabela, pelo painel do Supabase -- sem tela de aprovação no app
-- ainda, "isso e pra depois, vamos criar um painel disso separado").
-- Esse trigger é o que faz esse UM clique/edit manual (trocar status)
-- já refletir sozinho nos dois lugares certos: profiles.verified_* (selo
-- da CONTA de quem verificou) e, pra empresa, rooms.company_verified
-- (selo do CARD DA SALA) -- sem precisar de nenhum código de app rodando
-- no momento da aprovação, então funciona igual seja aprovado hoje
-- (manual) ou pelo painel de admin de verdade (futuro, "pra depois").
create or replace function public.apply_verification_approval() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if new.type = 'personal' then
      update public.profiles set verified_personal = true where id = new.user_id;
    elsif new.type = 'company' then
      update public.profiles set verified_company = true where id = new.user_id;
      if new.room_id is not null then
        update public.rooms set company_verified = true where id = new.room_id;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists verification_requests_apply_approval on public.verification_requests;
create trigger verification_requests_apply_approval
  after update on public.verification_requests
  for each row execute function public.apply_verification_approval();
