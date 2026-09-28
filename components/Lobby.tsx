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
// plataforma" -- depois, vendo só o resumo em texto: "cade o botao das
// conversas e da agenda? mantenha igual de dentro da sala") -- os
// ícones aqui são os MESMOS ChatIcon/AgendaIcon da av-bar do GameRoom
// (copiados, ver comentário deles abaixo) e abrem um painel de verdade
// (ler mensagens, RESPONDER, aceitar/recusar compromisso), não só
// texto. A diferença de "dentro da sala": aqui NÃO existe WebSocket
// (entrar no Lobby não pode virar presença fantasma na sala pra quem
// já tá lá dentro, ver comentário grande em server/index.js sobre
// broadcast de "join" assim que uma conexão abre) -- então tudo aqui
// usa REST simples (GET /chat/summary, /chat/messages, POST
// /chat/send, GET /agenda/summary, POST /agenda/respond, todos novos
// em server/index.js, reaproveitando as MESMAS funções de
// chatStore/agendaStore que o WebSocket usa). Quem estiver com a sala
// aberta em outra aba recebe a mensagem/resposta em tempo real do
// mesmo jeito (o servidor empurra por sendToUser); só quem só tem o
// Lobby aberto não recebe push -- teria que reabrir a conversa. Criar
// conversa nova, anexo e chamada de voz/vídeo continuam só dentro da
// sala (dependem de WebRTC/WebSocket de verdade, ver ChatDrawer em
// GameRoom.tsx).

import { useEffect, useMemo, useState } from "react";
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
  lastMessage: { senderId: string; senderName: string; kind: string; text: string; ts: number } | null;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  kind: string;
  text: string;
  ts: number;
  deleted?: boolean;
};

type CallParticipant = { id: string; name: string; status: string };
type CallSummary = {
  id: string;
  title: string;
  startTs: number;
  durationMinutes: number;
  participants: CallParticipant[];
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

// MESMOS ícones da av-bar de dentro da sala (copiados de GameRoom.tsx
// -- ChatIcon/AgendaIcon lá são funções locais, não exportadas, sem
// como importar direto sem virar dependência cruzada esquisita) --
// pedido do Douglas: "mantenha igual de dentro da sala".
function ChatIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.2 3.2a.5.5 0 0 1-.8-.4V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgendaIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.5 13.5h3M7.5 16.5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function formatCallWhen(startTs: number): string {
  return new Date(startTs).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Painel de chat do Lobby -- lista de conversas -> clicar abre o
 * histórico + campo de resposta. Ver comentário grande no topo do
 * arquivo pra entender o porquê de tudo aqui ser REST (sem WebSocket,
 * sem virar presença fantasma na sala). */
function LobbyChatPanel({
  myUserId,
  myName,
  conversations,
  onClose,
  onSent,
}: {
  myUserId: string;
  myName: string;
  conversations: ConversationSummary[] | null;
  onClose: () => void;
  onSent: (conversationId: string, message: ChatMessage) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!activeId) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    setMessages(null);
    fetch(
      `${REALTIME_HTTP_BASE}/chat/messages?conversationId=${encodeURIComponent(activeId)}&userId=${encodeURIComponent(myUserId)}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setMessages(Array.isArray(data?.messages) ? data.messages : []);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, myUserId]);

  const activeConversation = conversations?.find((c) => c.id === activeId) ?? null;

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, userId: myUserId, userName: myName, text }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.message) {
          setMessages((prev) => (prev ? [...prev, data.message] : [data.message]));
          onSent(activeId, data.message);
          setDraft("");
        }
      }
    } catch {
      // rede caiu no meio -- deixa o texto no campo pra pessoa tentar de novo
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="lobby-panel-backdrop" onClick={onClose}>
      <div className="lobby-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lobby-panel-header">
          {activeId && (
            <button type="button" className="lobby-panel-back" onClick={() => setActiveId(null)} title="Voltar">
              ←
            </button>
          )}
          <h3>{activeId ? conversationTitle(activeConversation) : "Conversas"}</h3>
          <button type="button" className="lobby-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        {!activeId ? (
          !conversations || conversations.length === 0 ? (
            <p className="lobby-panel-empty">Nenhuma conversa ainda. Entre na sala pra começar uma.</p>
          ) : (
            <ul className="lobby-conv-list">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button type="button" className="lobby-conv-item" onClick={() => setActiveId(c.id)}>
                    <span className="lobby-conv-name">{conversationTitle(c)}</span>
                    {c.lastMessage && (
                      <span className="lobby-conv-preview">
                        {c.lastMessage.senderId === myUserId ? "Você: " : ""}
                        {c.lastMessage.kind === "text" ? c.lastMessage.text : "anexo enviado"}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <div className="lobby-message-list">
              {messages === null ? (
                <p className="lobby-panel-empty">Carregando…</p>
              ) : messages.length === 0 ? (
                <p className="lobby-panel-empty">Nenhuma mensagem ainda.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`lobby-message${m.senderId === myUserId ? " lobby-message-own" : ""}`}>
                    {m.senderId !== myUserId && <span className="lobby-message-sender">{m.senderName}</span>}
                    <span className="lobby-message-text">
                      {m.deleted ? "Mensagem apagada" : m.kind === "text" ? m.text : "anexo enviado"}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="lobby-compose">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendMessage();
                }}
                placeholder="Escreva uma mensagem…"
                maxLength={2000}
              />
              <button type="button" onClick={sendMessage} disabled={!draft.trim() || sending}>
                Enviar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function conversationTitle(c: ConversationSummary | null | undefined): string {
  if (!c) return "Conversa";
  if (c.kind === "group") return c.name || "Grupo";
  return c.participants[0]?.name || "Conversa";
}

/** Painel de agenda do Lobby -- lista de compromissos, com Aceitar/
 * Recusar pra quem ainda tá pendente (mesma trava de participante do
 * agendaStore, ver POST /agenda/respond em server/index.js). */
function LobbyAgendaPanel({
  myUserId,
  calls,
  onClose,
  onResponded,
}: {
  myUserId: string;
  calls: CallSummary[] | null;
  onClose: () => void;
  onResponded: (call: CallSummary) => void;
}) {
  const [respondingId, setRespondingId] = useState<string | null>(null);

  async function respond(callId: string, status: "approved" | "declined") {
    if (respondingId) return;
    setRespondingId(callId);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/agenda/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, userId: myUserId, status }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.call) onResponded(data.call);
      }
    } catch {
      // rede caiu -- pessoa tenta de novo, botão volta a ficar clicável
    } finally {
      setRespondingId(null);
    }
  }

  const sorted = calls ? [...calls].sort((a, b) => a.startTs - b.startTs) : null;

  return (
    <div className="lobby-panel-backdrop" onClick={onClose}>
      <div className="lobby-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lobby-panel-header">
          <h3>Agenda</h3>
          <button type="button" className="lobby-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        {!sorted || sorted.length === 0 ? (
          <p className="lobby-panel-empty">Nenhum compromisso agendado.</p>
        ) : (
          <ul className="lobby-call-list">
            {sorted.map((call) => {
              const mine = call.participants.find((p) => p.id === myUserId);
              return (
                <li key={call.id} className="lobby-call-item">
                  <p className="lobby-call-title">{call.title}</p>
                  <p className="lobby-call-when">
                    {formatCallWhen(call.startTs)} · {call.durationMinutes} min
                  </p>
                  {mine?.status === "pending" ? (
                    <div className="lobby-call-actions">
                      <button
                        type="button"
                        className="lobby-call-accept"
                        disabled={respondingId === call.id}
                        onClick={() => respond(call.id, "approved")}
                      >
                        Aceitar
                      </button>
                      <button
                        type="button"
                        className="lobby-call-decline"
                        disabled={respondingId === call.id}
                        onClick={() => respond(call.id, "declined")}
                      >
                        Recusar
                      </button>
                    </div>
                  ) : (
                    <p className="lobby-call-status">
                      {mine?.status === "declined"
                        ? "Você recusou"
                        : mine?.status === "approved"
                          ? "Confirmado"
                          : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
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
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [agendaPanelOpen, setAgendaPanelOpen] = useState(false);

  const myUserId = useMemo(() => resolveUserId(accountUserId), [accountUserId]);
  const myName = accountProfile?.name?.trim() || "Visitante";

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
    if (!myUserId) {
      setConversations([]);
      setCalls([]);
      return;
    }
    fetch(`${REALTIME_HTTP_BASE}/chat/summary?userId=${encodeURIComponent(myUserId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setConversations(Array.isArray(data?.conversations) ? data.conversations : []);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    fetch(`${REALTIME_HTTP_BASE}/agenda/summary?userId=${encodeURIComponent(myUserId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCalls(Array.isArray(data?.calls) ? data.calls : []);
      })
      .catch(() => {
        if (!cancelled) setCalls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [myUserId]);

  // atualiza a prévia da conversa na lista (lastMessage) na hora,
  // sem esperar reabrir o painel -- mesma ideia do "chat:conversation"
  // que o WebSocket manda de dentro da sala.
  function handleMessageSent(conversationId: string, message: ChatMessage) {
    setConversations((prev) =>
      prev
        ? prev
            .map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    lastMessage: {
                      senderId: message.senderId,
                      senderName: message.senderName,
                      kind: message.kind,
                      text: message.text,
                      ts: message.ts,
                    },
                  }
                : c
            )
            .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0))
        : prev
    );
  }

  function handleCallResponded(updated: CallSummary) {
    setCalls((prev) => (prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev));
  }

  const displayName = accountProfile?.name?.trim() || "visitante";
  const presenceText =
    presence === null
      ? "Verificando quem tá na sala…"
      : presence.totalOnline === 0
        ? "Ninguém na sala agora -- seja o primeiro a entrar."
        : presence.totalOnline === 1
          ? "1 pessoa na sala agora."
          : `${presence.totalOnline} pessoas na sala agora.`;

  const pendingCallCount = useMemo(
    () => (calls ?? []).filter((c) => c.participants.find((p) => p.id === myUserId)?.status === "pending").length,
    [calls, myUserId]
  );

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

        <button type="button" className="lobby-enter-btn" onClick={onEnter}>
          Entrar na sala
        </button>
        {onSignOut && (
          <button type="button" className="lobby-signout-btn" onClick={onSignOut}>
            Sair da conta
          </button>
        )}
      </div>

      {/* pedido do Douglas (28/set, com print da av-bar de dentro da
          sala): "quero em balao assim, no canto esquerdo mesmo lugar
          que esta" -- MESMA classe .av-bar (pilula de vidro fosco,
          canto inferior esquerdo) que a barra de dentro da sala usa,
          não uma cópia -- fica igual de verdade, não só parecido. Fora
          do .lobby-card de propósito (esse aqui é "absolute" relativo
          à tela inteira, igual dentro da sala; dentro do card ficaria
          preso ao centro). */}
      <div className="av-bar">
        <button
          type="button"
          className={chatPanelOpen ? "av-btn on" : "av-btn"}
          onClick={() => setChatPanelOpen((v) => !v)}
          aria-label={chatPanelOpen ? "Fechar chat" : "Abrir chat"}
          data-tooltip={chatPanelOpen ? "Fechar chat" : "Chat"}
        >
          <span className="lobby-badge-wrap">
            <ChatIcon />
            {conversations && conversations.length > 0 && (
              <span className="lobby-icon-badge">{conversations.length}</span>
            )}
          </span>
        </button>
        <button
          type="button"
          className={agendaPanelOpen ? "av-btn on" : "av-btn"}
          onClick={() => setAgendaPanelOpen((v) => !v)}
          aria-label={agendaPanelOpen ? "Fechar agenda" : "Abrir agenda"}
          data-tooltip={agendaPanelOpen ? "Fechar agenda" : "Agenda"}
        >
          <span className="lobby-badge-wrap">
            <AgendaIcon />
            {pendingCallCount > 0 && <span className="lobby-icon-badge">{pendingCallCount}</span>}
          </span>
        </button>
      </div>

      {chatPanelOpen && (
        <LobbyChatPanel
          myUserId={myUserId}
          myName={myName}
          conversations={conversations}
          onClose={() => setChatPanelOpen(false)}
          onSent={handleMessageSent}
        />
      )}
      {agendaPanelOpen && (
        <LobbyAgendaPanel
          myUserId={myUserId}
          calls={calls}
          onClose={() => setAgendaPanelOpen(false)}
          onResponded={handleCallResponded}
        />
      )}
    </div>
  );
}
