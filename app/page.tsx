"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import AuthGate from "@/components/AuthGate";
import Lobby from "@/components/Lobby";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

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
  // criar um...)". Default "sala-principal" (Mapa Publicada, mesmo
  // valor de sempre) -- só muda de verdade quando o Lobby manda um
  // slug diferente pra onEnter.
  const [roomSlug, setRoomSlug] = useState("sala-principal");

  return (
    <main className="page">
      <AuthGate>
        {(auth) =>
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
            />
          )
        }
      </AuthGate>
    </main>
  );
}
