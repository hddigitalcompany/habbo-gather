"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import AuthGate, { type AccountProfile } from "@/components/AuthGate";
import Lobby from "@/components/Lobby";
import { usePlatformChat } from "@/components/usePlatformChat";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

type AuthResult = {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken: string | null;
  onSignOut: (() => void) | null;
};

// 1/out -- pedido direto do Douglas ("pega o chat de dentro e
// transforma ele em CHAT que acompanha toda a plataforma"): esse
// componente existe só pra montar usePlatformChat (ver comentário
// grande nele) UMA VEZ, acima da troca Lobby<->GameRoom, com os dados
// de conta que só existem DENTRO do render-prop do AuthGate
// (`(auth) => ...`) -- chamar o hook direto dentro dessa função
// anônima violaria as Regras dos Hooks (o AuthGate só invoca essa
// função depois que `stage.kind === "ready"`, ver AuthGate.tsx: antes
// disso ele nem é chamada, então o hook apareceria/sumiria entre
// renders do PRÓPRIO AuthGate). Um componente de verdade aqui resolve
// isso -- ele é QUEM monta/desmonta (uma vez só, quando o login resolve),
// não um número variável de hooks dentro do fiber do AuthGate.
function PlatformChatHost({
  auth,
  children,
}: {
  auth: AuthResult;
  children: (chat: ReturnType<typeof usePlatformChat>) => React.ReactNode;
}) {
  const chat = usePlatformChat({
    accountUserId: auth.accountUserId,
    accountProfile: auth.accountProfile,
    accountAccessToken: auth.accountAccessToken,
  });
  return <>{children(chat)}</>;
}

export default function Home() {
  // pedido do Douglas (28/set): "nao deve abrir direto na sala, crie
  // um lobby igual do habbo" -- entered começa false pra TODO mundo
  // (conta ou visitante), então o GameRoom (que abre o WebSocket assim
  // que monta) só monta depois do clique em "Entrar na sala" no Lobby.
  // Reseta pra false de novo se a pessoa sair da conta (onSignOut),
  // senão voltaria direto pro Lobby só pra clicar Entrar de novo com
  // outra conta -- mais natural já cair no portão de login.
  const [entered, setEntered] = useState(false);
  // qual sala foi escolhida em "Meus espaços" antes de clicar "Entrar
  // na sala" (ver ROOM_SLUGS/selectedRoomSlug em Lobby.tsx) -- pedido
  // do Douglas (29/set): "Mapa publicada (essa) / Mapa modelo (ja pode
  // criar um...)". Default "mapa-publicado" (Mapa Publicada, mesmo
  // valor de sempre) -- só muda de verdade quando o Lobby manda um
  // slug diferente pra onEnter.
  const [roomSlug, setRoomSlug] = useState("mapa-publicado");

  return (
    <main className="page">
      <AuthGate>
        {(auth) => (
          <PlatformChatHost auth={auth}>
            {(chat) =>
              entered ? (
                <GameRoom
                  accountUserId={auth.accountUserId}
                  accountProfile={auth.accountProfile}
                  accountAccessToken={auth.accountAccessToken}
                  onSignOut={auth.onSignOut}
                  roomSlug={roomSlug}
                  // pedido do Douglas (29/set (8)): o X do topo vira link
                  // de volta pro Lobby -- mesma troca de tela que
                  // onEnter faz no sentido contrário (ver comentário
                  // grande de `entered` lá em cima).
                  onBackToLobby={() => setEntered(false)}
                  // GameRoom.tsx ainda não foi migrado pra consumir o
                  // motor único (ver usePlatformChat) -- continua com a
                  // própria implementação de chat por enquanto (ver
                  // comentário grande no topo de usePlatformChat.ts).
                  // `chat` (usePlatformChat) fica montado aqui do mesmo
                  // jeito (mesma conexão viva), só ainda sem consumidor
                  // do lado da sala.
                />
              ) : (
                <Lobby
                  accountUserId={auth.accountUserId}
                  accountProfile={auth.accountProfile}
                  accountAccessToken={auth.accountAccessToken}
                  onEnter={(slug) => {
                    setRoomSlug(slug);
                    setEntered(true);
                  }}
                  onSignOut={
                    auth.onSignOut
                      ? () => {
                          setEntered(false);
                          auth.onSignOut?.();
                        }
                      : null
                  }
                  platformChat={chat}
                />
              )
            }
          </PlatformChatHost>
        )}
      </AuthGate>
    </main>
  );
}
