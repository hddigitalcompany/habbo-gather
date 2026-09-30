-- "só pode haver uma conta por cpf" -- pedido do Douglas, 30/set, junto
-- com as regras de verificação de empresa (ver comentário grande em
-- app/api/account/verification/route.ts sobre as outras duas: "um
-- controlador por perfil empresarial verificado" e "uma empresa não
-- pode ser verificada em dois espaços", que dependem de um jeito de
-- identificar a EMPRESA de verdade -- CNPJ, que foi removido da aba
-- "Editar Empresa" antes -- ainda em aberto com ele).
--
-- Índice PARCIAL (where cpf <> '') -- account_private.cpf nasce '' pra
-- toda conta que ainda não preencheu "Dados da conta" (ver default ''
-- na 0041), então um índice único comum ia travar a PRIMEIRA vez que
-- uma segunda conta tentasse salvar CPF vazio (não é o CPF que
-- repetiu, é só que nenhuma das duas preencheu ainda). Com WHERE,
-- só entra na checagem de unicidade quando a pessoa de fato preencheu
-- um CPF (11 dígitos), que é o caso que a regra do Douglas quer
-- travar de verdade.
create unique index if not exists account_private_cpf_unique
  on public.account_private (cpf)
  where cpf <> '';
