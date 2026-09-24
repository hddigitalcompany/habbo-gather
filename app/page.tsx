"use client";

import dynamic from "next/dynamic";
import AuthGate from "@/components/AuthGate";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

export default function Home() {
  return (
    <main className="page">
      <AuthGate>
        {(auth) => (
          <GameRoom
            accountUserId={auth.accountUserId}
            accountProfile={auth.accountProfile}
            accountAccessToken={auth.accountAccessToken}
            onSignOut={auth.onSignOut}
          />
        )}
      </AuthGate>
    </main>
  );
}
