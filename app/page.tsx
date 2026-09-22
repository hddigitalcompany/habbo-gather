"use client";

import dynamic from "next/dynamic";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

export default function Home() {
  return (
    <main className="page">
      <h1>Sala Virtual — Protótipo</h1>
      <GameRoom />
      <p className="hint">
        Use as setas ou WASD para andar. Chegue perto de outra pessoa para
        ligar câmera e microfone automaticamente.
      </p>
    </main>
  );
}
