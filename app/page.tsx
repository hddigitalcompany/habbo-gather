"use client";

import dynamic from "next/dynamic";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

export default function Home() {
  return (
    <main className="page">
      <GameRoom />
    </main>
  );
}
