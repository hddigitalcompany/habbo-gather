"use client";

// Lobby -- tela de entrada mostrada ANTES da sala (pedido do Douglas,
// 28/set: "nao deve abrir direto na sala, crie um lobby igual do
// habbo" + depois "quero ali no centro a previa da sala da pessoa,
// como no gather"). Fica entre o AuthGate (resolve quem é a pessoa) e
// o GameRoom (que só monta -- e só aí abre o WebSocket -- depois do
// clique em "Entrar na sala", ver app/page.tsx). Sem estado de jogo
// nenhum aqui, só decide SE mostra o botão de entrar; quem entra e sai
// da sala de verdade continua sendo o GameRoom.
//
// A prévia central (RoomPreview) busca piso/parede/mobília pelos MESMOS
// GETs públicos que o GameRoom usa (GET /room/floor, /room/walls,
// /room/furniture em server/index.js -- não exigem dono, só leitura) e
// desenha um grid top-down simplificado em SVG: não é a arte de verdade
// (texturas/sprites, isso só o Phaser dentro do GameRoom sabe montar),
// é um "mapinha" abstrato só pra dar uma ideia do formato/tamanho da
// sala antes de entrar -- mesma ideia da prévia do Gather, sem precisar
// carregar o motor do jogo inteiro só pra isso.
//
// A contagem de "quem tá na sala agora" vem de GET /room/presence (ver
// server/index.js) -- endpoint HTTP público que já existia pro painel
// de membros, escolhido de propósito por não precisar abrir o
// WebSocket só pra mostrar um número no lobby.
//
// Chat/agenda (28/set, pedido do Douglas: "chat, agenda, configuracoes
// nao ficam presas apenas a sala, acompanha cada pessoa por toda
// plataforma") -- resumo buscado por GET /chat/summary e
// GET /agenda/summary (novos, ver server/index.js), MESMOS dados que
// o GameRoom pede por WebSocket ("chat:list"/"agenda:list"), só que
// sem precisar abrir o socket/entrar na sala pra ver que já tem
// conversa ou compromisso marcado -- é o que fazia essas duas coisas
// PARECEREM presas à sala (só apareciam depois de "Entrar"). Usa o
// MESMO userId que o GameRoom usa (ver lib/identity.ts) pra ser
// literalmente a mesma pessoa/histórico dos dois lados. Responder
// mensagem, criar/editar compromisso e abrir chamada continuam só
// dentro da sala (dependem do WebSocket/WebRTC de verdade, ver
// ChatDrawer/AgendaDrawer em GameRoom.tsx) -- aqui é só "prévia",
// igual o RoomPreview abaixo.

import { useEffect, useState } from "react";
import type { AccountProfile } from "@/components/AuthGate";
import { resolveUserId } from "@/lib/identity";

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
  `://${REALTIME_HOST}`;

type PresenceInfo = { totalOnline: number } | null;

type ConversationSummary = {
  id: string;
  name: string;
  kind: "direct" | "group";
  participants: { id: string; name?: string }[];
  lastMessage: { senderName: string; kind: string; text: string; ts: number } | null;
};

type CallSummary = {
  id: string;
  title: string;
  startTs: number;
  participants: { id: string; status: string }[];
};

type FloorTile = { col: number; row: number; styleId: string };
type FurnitureItem = { col: number; row: number; type: string };
type WallSegment = { col: number; row: number; side: "rowPlus" | "colPlus" };

type RoomShape = {
  floor: FloorTile[];
  furniture: FurnitureItem[];
  walls: WallSegment[];
} | null;

const PREVIEW_W = 264;
const PREVIEW_H = 168;
const PREVIEW_PAD = 10;

/** Cor do piso é só decorativa aqui (não é a textura de verdade, ver
 * comentário grande no topo do arquivo) -- hasheia o styleId (mesmo uuid
 * usado no piso de verdade) pra pelo menos variar entre 3 tons
 * violeta, dando uma sensação de "tem mais de um tipo de piso" sem
 * precisar buscar o catálogo (GET /floor-items) só pra isso. */
const FLOOR_TONES = ["#3a2f57", "#42355f", "#372c52"];
function floorTone(styleId: string): string {
  let h = 0;
  for (let i = 0; i < styleId.length; i++) h = (h * 31 + styleId.charCodeAt(i)) >>> 0;
  return FLOOR_TONES[h % FLOOR_TONES.length];
}

/** Desenha o "mapinha" da sala -- ver comentário grande no topo do
 * arquivo pra entender por que é abstrato (não usa os sprites de
 * verdade). Sem piso nenhum carregado ainda (fetch em andamento ou
 * sala vazia de propósito), mostra um placeholder simples em vez de um
 * SVG vazio esquisito. */
function RoomPreview({ room, loading }: { room: RoomShape; loading: boolean }) {
  if (loading) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span>Carregando prévia da sala…</span>
      </div>
    );
  }
  if (!room || room.floor.length === 0) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span>Sala ainda sem piso desenhado.</span>
      </div>
    );
  }

  const cols = room.floor.map((t) => t.col);
  const rows = room.floor.map((t) => t.row);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const gridW = maxCol - minCol + 1;
  const gridH = maxRow - minRow + 1;

  const cell = Math.min((PREVIEW_W - PREVIEW_PAD * 2) / gridW, (PREVIEW_H - PREVIEW_PAD * 2) / gridH);
  const offsetX = (PREVIEW_W - gridW * cell) / 2;
  const offsetY = (PREVIEW_H - gridH * cell) / 2;
  const x = (col: number) => offsetX + (col - minCol) * cell;
  const y = (row: number) => offsetY + (row - minRow) * cell;

  return (
    <div className="lobby-preview">
      <svg width={PREVIEW_W} height={PREVIEW_H} viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}>
        {room.floor.map((t, i) => (
          <rect
            key={`f-${i}`}
            x={x(t.col)}
            y={y(t.row)}
            width={cell}
            height={cell}
            fill={floorTone(t.styleId)}
            stroke="rgba(0,0,0,0.25)"
            strokeWidth={0.5}
          />
        ))}
        {room.walls.map((w, i) => {
          const x1 = w.side === "rowPlus" ? x(w.col) : x(w.col + 1);
          const y1 = w.side === "rowPlus" ? y(w.row + 1) : y(w.row);
          const x2 = w.side === "rowPlus" ? x(w.col + 1) : x(w.col + 1);
          const y2 = w.side === "rowPlus" ? y(w.row + 1) : y(w.row + 1);
          return (
            <line
              key={`w-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#a893f0"
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        })}
        {room.furniture.map((f, i) => (
          <rect
            key={`m-${i}`}
            x={x(f.col) + cell * 0.18}
            y={y(f.row) + cell * 0.18}
            width={cell * 0.64}
            height={cell * 0.64}
            rx={cell * 0.14}
            fill="#7c5cff"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={0.6}
          />
        ))}
      </svg>
    </div>
  );
}

export default function Lobby({
  accountUserId,
  accountProfile,
  onEnter,
  onSignOut,
}: {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  onEnter: () => void;
  onSignOut: (() => void) | null;
}) {
  const [presence, setPresence] = useState<PresenceInfo>(null);
  const [room, setRoom] = useState<RoomShape>(null);
  const [roomLoading, setRoomLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [nextCall, setNextCall] = useState<CallSummary | null | undefined>(undefined);

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

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${REALTIME_HTTP_BASE}/room/floor`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/walls`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/furniture`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([floorData, wallsData, furnitureData]) => {
        if (cancelled) return;
        setRoom({
          floor: Array.isArray(floorData?.items) ? floorData.items : [],
          walls: Array.isArray(wallsData?.items) ? wallsData.items : [],
          furniture: Array.isArray(furnitureData?.items) ? furnitureData.items : [],
        });
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      })
      .finally(() => {
        if (!cancelled) setRoomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const userId = resolveUserId(accountUserId);
    if (!userId) {
      setConversations([]);
      setNextCall(null);
      return;
    }
    fetch(`${REALTIME_HTTP_BASE}/chat/summary?userId=${encodeURIComponent(userId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setConversations(Array.isArray(data?.conversations) ? data.conversations : []);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    fetch(`${REALTIME_HTTP_BASE}/agenda/summary?userId=${encodeURIComponent(userId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const calls: CallSummary[] = Array.isArray(data?.calls) ? data.calls : [];
        const now = Date.now();
        const upcoming = calls
          .filter((c) => c.startTs >= now)
          .filter((c) => c.participants.find((p) => p.id === userId)?.status !== "declined")
          .sort((a, b) => a.startTs - b.startTs);
        setNextCall(upcoming[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setNextCall(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);

  const displayName = accountProfile?.name?.trim() || "visitante";
  const presenceText =
    presence === null
      ? "Verificando quem tá na sala…"
      : presence.totalOnline === 0
        ? "Ninguém na sala agora -- seja o primeiro a entrar."
        : presence.totalOnline === 1
          ? "1 pessoa na sala agora."
          : `${presence.totalOnline} pessoas na sala agora.`;

  // "prévia" de chat/agenda -- ver comentário grande no topo do arquivo.
  // conversations null = ainda buscando; [] = já sabe que não tem
  // nenhuma (não mostra a linha à toa). Ordena por updatedAt (já vem
  // assim do servidor, ver chatStore.listConversationsForUser) e pega
  // só a mais recente pra caber numa linha.
  const latestConversation = conversations && conversations.length > 0 ? conversations[0] : null;
  const chatText =
    conversations === null
      ? null
      : conversations.length === 0
        ? "Nenhuma conversa ainda."
        : latestConversation?.lastMessage
          ? `${conversations.length === 1 ? "1 conversa" : `${conversations.length} conversas`} · última de ${
              latestConversation.lastMessage.senderName || "alguém"
            }: ${
              latestConversation.lastMessage.kind === "text"
                ? latestConversation.lastMessage.text.slice(0, 60)
                : "anexo enviado"
            }`
          : `${conversations.length === 1 ? "1 conversa" : `${conversations.length} conversas`} salva${
              conversations.length === 1 ? "" : "s"
            }.`;

  const agendaText =
    nextCall === undefined
      ? null
      : nextCall === null
        ? "Nenhum compromisso agendado."
        : `Próximo compromisso: "${nextCall.title}" em ${new Date(nextCall.startTs).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}.`;

  return (
    <div className="lobby-backdrop">
      <div className="lobby-card">
        <div className="lobby-sign">
          <span className="lobby-sign-text">SALA VIRTUAL</span>
        </div>
        <p className="lobby-greeting">Bem-vindo(a), {displayName}!</p>
        <RoomPreview room={room} loading={roomLoading} />
        <p className="lobby-presence">
          <span className={`lobby-presence-dot${presence && presence.totalOnline > 0 ? " lobby-presence-dot-active" : ""}`} />
          {presenceText}
        </p>
        {(chatText || agendaText) && (
          <div className="lobby-status">
            {chatText && <p className="lobby-status-line">💬 {chatText}</p>}
            {agendaText && <p className="lobby-status-line">📅 {agendaText}</p>}
          </div>
        )}
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
