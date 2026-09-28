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
            />
          ) : (
            <Lobby
              accountProfile={auth.accountProfile}
              onEnter={() => setEntered(true)}
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
