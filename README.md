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
