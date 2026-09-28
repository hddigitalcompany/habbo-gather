# Habbo x Gather — Protótipo

Protótipo funcional do núcleo do produto: uma sala 2D estilo pixel art
(inspirada no Habbo) onde vários jogadores se veem em tempo real e, quando
o avatar de alguém se aproxima do seu, a câmera e o microfone ligam
automaticamente (o efeito principal do Gather.town).

## O que já funciona nesta versão

- Sala com piso, paredes e decoração em pixel art (gerados por script).
- Avatar controlável (setas ou WASD), com animação de andar nas 4 direções.
- Multiplayer em tempo real: todo mundo vê a posição de todo mundo.
- Vídeo/áudio por proximidade via WebRTC (liga perto, desliga longe, com
  o vídeo ficando mais "apagado" quanto mais longe).
- Chat de texto simples.

## O que ainda falta (próximas etapas)

- Sistema de assinatura/pagamento pra liberar acesso.
- Mais salas, customização de avatar, arte final (a atual é placeholder).
- Empacotar como app baixável (Windows/Mac).

## Como rodar na sua máquina

Pré-requisitos: [Node.js](https://nodejs.org) instalado (versão 18 ou mais
recente).

1. Abra o terminal dentro desta pasta e rode:

   ```
   npm install
   ```

2. Copie o arquivo de exemplo de variáveis de ambiente:

   ```
   cp .env.local.example .env.local
   ```

3. Rode o projeto (isso sobe o site E o servidor multiplayer ao mesmo tempo):

   ```
   npm run dev
   ```

4. Abra o navegador em `http://localhost:3000`. Permita o acesso à câmera
   e ao microfone quando o navegador pedir.

5. Pra testar o multiplayer e o vídeo por proximidade, abra uma **segunda
   aba** (ou uma aba anônima) também em `http://localhost:3000`, e mova os
   dois avatares um perto do outro.

## Adicionar cabelo novo (sem mexer em código)

Pra colocar um penteado novo no jogo, crie uma pasta dentro de
`assets-source/cabelo/` com o nome do item e 4 imagens dentro, cada uma
com **200x260px** (use os arquivos em `assets-source/cabelo/_referencia/`
como fundo/guia no seu editor de imagem, pra alinhar certinho com a
cabeça do avatar):

```
assets-source/cabelo/cabelinho-pra-tras-loiro/
  frente.png
  lado_esq.png   (ou lado-esq.png)
  lado_dir.png   (ou lado-dir.png)
  costas.png
```

Com `npm run dev` rodando, isso é sincronizado sozinho (processo "assets"
no terminal) assim que você salva a pasta -- o item já aparece no editor
de personagem do jogo, sem precisar rodar nada nem mandar as imagens por
aqui. Se quiser um nome de exibição diferente do nome da pasta, adicione
um arquivo `label.txt` dentro da pasta com o nome desejado.

Pra rodar a sincronização manualmente (sem o `npm run dev` aberto):

```
npm run sync-assets
```

(ver `scripts/syncAvatarAssets.mjs` pra como funciona por dentro.)

## Regenerar os assets (arte placeholder)

Se quiser mexer na arte, o script que gera o piso e o avatar está em
`scripts/generate_assets.py` (precisa de Python 3 + Pillow: `pip install pillow`).

```
python3 scripts/generate_assets.py
```

## Deploy

- O site (Next.js) vai pro Vercel, do mesmo jeito que o Painel Pessoal.
- O servidor multiplayer (pasta `server/`, um servidor Node.js + WebSocket
  simples) é publicado à parte, no Render (plano gratuito), conectado
  direto no repositório do GitHub.
- Depois de publicar o servidor no Render, configure a variável de ambiente
  `NEXT_PUBLIC_REALTIME_HOST` no Vercel apontando pro host que o Render deu
  (ex: `habbo-gather-realtime.onrender.com`, sem `https://` na frente).

Observação: as pastas `party/` e o arquivo `partykit.json` são de uma
tentativa anterior (usando PartyKit/Cloudflare) que esbarrou numa
incompatibilidade recente da própria Cloudflare com contas gratuitas. Não
são mais usados — o servidor atual é o `server/index.js`.

### Staging (ambiente de teste, separado de produção)

Pedido do Douglas: "quero um ambiente de teste... pra que as alterações
que a gente vai fazendo não caia direto pro cliente... deu certo no
teste? joga pros usuários" -- dois AMBIENTES completos e isolados, cada
um com seu próprio banco/dados, rodando o MESMO código, só que
apontando pra branches diferentes do git.

**Estratégia de branch:** `main` = produção (como já é hoje). Uma
branch nova, `staging`, criada a partir da `main` = staging. Toda
mudança vai primeiro pra `staging` (Vercel/Render publicam sozinhos ao
receber o push), o Douglas testa lá, e só quando validar dá merge de
`staging` pra `main` (aí sim vai pro cliente de verdade). A criação da
branch/push é sempre o Douglas (ver regra de nunca dar `git push`
sozinho) -- aqui só documento o fluxo.

**Vercel -- 1 projeto só, os 2 ambientes já vêm de graça:**
- Ao importar o repositório, configura `main` como Production Branch.
- Toda branch DIFERENTE de `main` (inclusive `staging`) já vira uma
  Preview Deployment automática, com uma URL ESTÁVEL só dela (não muda
  a cada commit) -- algo como
  `https://habbo-gather-git-staging-<sua-conta>.vercel.app`. Não
  precisa de um segundo projeto Vercel.
- Em Project Settings -> Environment Variables, cada variável pode ter
  um valor DIFERENTE por ambiente (Production vs Preview) -- é assim
  que staging aponta pro Supabase/Render de teste, e produção pro de
  verdade, com o mesmo projeto Vercel.

**Render -- 2 serviços (o free tier não tem preview por branch):**
- `habbo-gather-realtime` (produção) -- já documentado acima, segue a
  branch `main`.
- `habbo-gather-realtime-staging` (staging) -- mesmo repositório, mesmo
  build/start command (`npm run start:server`, porta via `$PORT`), só
  que apontando pra branch `staging` e com as env vars do Supabase de
  TESTE (ver abaixo).

**Supabase -- 2 projetos separados (staging tem seus próprios dados,
sem risco de misturar com o cliente de verdade):**
- O projeto atual (`Habbo-gather` / branch `principal`, já em uso)
  continua sendo produção.
- Cria um projeto NOVO no Supabase (nome sugerido: `habbo-gather-staging`),
  roda TODAS as migrations de `supabase/migrations/` nele do zero (na
  ordem, 0001 até a mais recente) -- é um banco em branco, começa do
  zero mesmo, não precisa restaurar nada de produção.
- (Se o seu plano do Supabase já tiver "Branching" liberado -- vi um
  seletor de branch no seu dashboard -- dá pra usar uma branch do MESMO
  projeto em vez de um projeto separado; funciona parecido, mas envolve
  billing, então fica a seu critério.)

**Checklist do que só você consegue fazer (login/conta):**
1. No GitHub: nada a fazer agora, só confirmar que a branch `staging`
   existe depois que eu (ou você) criar e você der o push.
2. Na Vercel: `Settings -> Environment Variables`, adicionar
   `NEXT_PUBLIC_REALTIME_HOST`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` com
   escopo "Preview" apontando pro Render/Supabase de STAGING (os de
   "Production" continuam apontando pra produção).
3. No Render: criar o segundo serviço (`habbo-gather-realtime-staging`),
   branch `staging`, com as env vars do Supabase de staging.
4. No Supabase: criar o projeto novo `habbo-gather-staging` e rodar as
   migrations nele (posso te mandar tudo junto numa pasta, ou você roda
   uma por uma como já vem fazendo).

Assim que você tiver essas 4 coisas prontas (ou mesmo só o projeto novo
do Supabase, pra eu já poder rodar as migrations de teste nele), me
avisa o `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY` de
staging que eu sigo com a Task #63 testando contra esse ambiente, sem
encostar na produção.
