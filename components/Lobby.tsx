"use client";

// Lobby -- tela de entrada mostrada ANTES da sala (pedido do Douglas,
// 28/set: "nao deve abrir direto na sala, crie um lobby igual do
// habbo"). Fica entre o AuthGate (resolve quem é a pessoa) e o GameRoom
// (que só monta -- e só aí abre o WebSocket -- depois do clique em
// "Entrar na sala", ver app/page.tsx). Sem estado de jogo nenhum aqui,
// só decide SE mostra o botão de entrar; quem entra e sai da sala de
// verdade continua sendo o GameRoom.
//
// A contagem de "quem tá na sala agora" vem de GET /room/presence (ver
// server/index.js) -- endpoint HTTP público que já existia pro painel
// de membros, escolhido de propósito por não precisar abrir o
// WebSocket só pra mostrar um número no lobby.

import { useEffect, useState } from "react";
import type { AccountProfile } from "@/components/AuthGate";

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
  `://${REALTIME_HOST}`;

type PresenceInfo = { totalOnline: number } | null;

export default function Lobby({
  accountProfile,
  onEnter,
  onSignOut,
}: {
  accountProfile: Partial<AccountProfile> | null;
  onEnter: () => void;
  onSignOut: (() => void) | null;
}) {
  const [presence, setPresence] = useState<PresenceInfo>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${REALTIME_HTTP_BASE}/room/presence`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setPresence({ totalOnline: Number(data.totalOnline) || 0 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const displayName = accountProfile?.name?.trim() || "visitante";
  const presenceText =
    presence === null
      ? "Verificando quem tá na sala…"
      : presence.totalOnline === 0
        ? "Ninguém na sala agora -- seja o primeiro a entrar."
        : presence.totalOnline === 1
          ? "1 pessoa na sala agora."
          : `${presence.totalOnline} pessoas na sala agora.`;

  return (
    <div className="lobby-backdrop">
      <div className="lobby-card">
        <div className="lobby-sign">
          <span className="lobby-sign-text">SALA VIRTUAL</span>
        </div>
        <p className="lobby-greeting">Bem-vindo(a), {displayName}!</p>
        <p className="lobby-presence">
          <span className={`lobby-presence-dot${presence && presence.totalOnline > 0 ? " lobby-presence-dot-active" : ""}`} />
          {presenceText}
        </p>
        <button type="button" className="lobby-enter-btn" onClick={onEnter}>
          Entrar na sala
        </button>
        {onSignOut && (
          <button type="button" className="lobby-signout-btn" onClick={onSignOut}>
            Sair da conta
          </button>
        )}
      </div>
    </div>
  );
}
