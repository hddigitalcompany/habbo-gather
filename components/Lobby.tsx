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

import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountProfile } from "@/components/AuthGate";
import { resolveUserId } from "@/lib/identity";
import SettingsPanel from "@/components/SettingsPanel";
import ContactsPanel, { type ContactUser } from "@/components/ContactsPanel";
import {
  getStoredMicOn,
  getStoredCamOn,
  getStoredMicDeviceId,
  getStoredCamDeviceId,
  getStoredSpeakerDeviceId,
  setStoredMicOn,
  setStoredCamOn,
  setStoredMicDeviceId,
  setStoredCamDeviceId,
  setStoredSpeakerDeviceId,
} from "@/lib/mediaPrefs";

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
// Setinha do seletor "Meus espaços" na barra de topo (ver comentário
// grande onde spacesMenuOpen é declarado).
function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 9l7 7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// MESMO mapeamento de STATUS_OPTIONS/statusMeta em GameRoom.tsx
// (copiado, não importado -- mesmo motivo dos ícones acima) -- usado
// no "card" da conta (ver accountCardOpen mais abaixo).
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  online: "Online",
  away: "Ausente",
  focus: "Foco",
};

// "card" da Empresa selecionada -- pedido do Douglas: "nesse canto
// quero o card da Empresa selecionada" (print de referência: card
// estilo perfil do X/Twitter de uma marca real, "Obrazur"). Copiei o
// LAYOUT/estilo exatamente (fundo claro em cima com frase de efeito,
// ícones sociais + botão "Seguir", metade preta embaixo com logo,
// nome + selo verificado, @arroba, bio, seguidores/seguindo, link) --
// mas troquei o CONTEÚDO da Obrazur (nome, @arroba, bio e números de
// verdade dela) por um exemplo/molde: reproduzir a identidade real de
// outra empresa (nome, @arroba, contagem de seguidores, selo
// verificado) aqui dentro passaria a impressão de que ela é
// patrocinadora/parceira do habbo-gather, o que não é verdade. Quando
// existir uma empresa de verdade cadastrada (ver "Empresas
// Posicionadas" na barra, ainda sem backend), esses campos viram dado
// real vindo dela, não mais esse molde fixo.
const FEATURED_COMPANY = {
  name: "Empresa Exemplo",
  handle: "empresaexemplo",
  tagline: "MARCA EM DESTAQUE",
  taglineEnd: "AQUI VOCÊ BRILHA.",
  bio: "Espaço reservado para a empresa patrocinadora em destaque na plataforma.",
  following: 0,
  followers: 0,
  link: "habbo-gather.com/empresas",
};

function XSocialIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.9 2H22l-7.6 8.7L23.3 22H16.6l-5.2-6.8L5.4 22H2.3l8.1-9.3L1.5 2h6.9l4.7 6.2L18.9 2Zm-1.2 18h1.7L7.4 4h-1.8l12.1 16Z" />
    </svg>
  );
}

function LinkedInSocialIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm7 0h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.75V21h-4v-5.6c0-1.34-.02-3.06-1.87-3.06-1.87 0-2.16 1.46-2.16 2.96V21h-4V9Z" />
    </svg>
  );
}

function ButterflySocialIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 6.2C10.6 3.9 7.4 2.3 4.9 2c-.5 2.9.3 6.6 2.8 8.4-2 .1-3.9 1.1-3.9 3.4 0 2.3 2.1 3 3.6 3-1 .6-1.4 1.5-.9 2.6 1.7-.2 3.6-1.2 4.5-2.7.9 1.5 2.8 2.5 4.5 2.7.5-1.1.1-2-.9-2.6 1.5 0 3.6-.7 3.6-3 0-2.3-1.9-3.3-3.9-3.4 2.5-1.8 3.3-5.5 2.8-8.4-2.5.3-5.7 1.9-7.1 4.2Z" />
    </svg>
  );
}

function VerifiedBadge() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="company-card-verified">
      <path
        d="m12 2 2.4 1.4 2.8-.3 1.1 2.6 2.6 1.1-.3 2.8L22 12l-1.4 2.4.3 2.8-2.6 1.1-1.1 2.6-2.8-.3L12 22l-2.4-1.4-2.8.3-1.1-2.6-2.6-1.1.3-2.8L2 12l1.4-2.4-.3-2.8 2.6-1.1 1.1-2.6 2.8.3L12 2Z"
        fill="#3897f0"
      />
      <path d="m8.2 12.2 2.4 2.4 5-5.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M9.5 14.5 14.5 9.5M8 17l-2.5 2.5a3.5 3.5 0 0 1-5-5L3 12M16 7l2.5-2.5a3.5 3.5 0 0 1 5 5L21 12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

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

// Ícone do botão "Contatos" -- pedido do Douglas: "quero agora, mais
// um icone de contatos" (28/set), MESMO ícone/mesma ideia do botão
// "Contatos" de dentro da sala (copiado de GameRoom.tsx).
function ContactsIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="8.5" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 16c.4-1.8 1.6-2.7 3-2.7s2.6.9 3 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.5 9.5h5M13.5 12.5h5M13.5 15.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// MESMOS ícones de mic/câmera/tela/engrenagem da av-bar de dentro da
// sala (copiados de GameRoom.tsx, mesmo motivo do ChatIcon/AgendaIcon
// acima) -- pedido do Douglas vendo a av-bar de dentro da sala: "cade
// o restante, configuracoes, audio, video, tela".
function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {off && <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

function CamIcon({ off }: { off: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m15.5 10.8 4.4-2.6a.8.8 0 0 1 1.2.7v6.2a.8.8 0 0 1-1.2.7l-4.4-2.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {off && <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

// "tela" (compartilhar tela) -- SEM função aqui no Lobby de propósito
// (ver comentário grande onde o botão é usado): não tem ninguém pra
// ver a tela compartilhada antes de entrar na sala, então o ícone
// aparece pra bater com a barra de dentro da sala, mas fica desligado.
function ScreenIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4.5" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 20h7M12 16.5V20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6M17.7 17.7l-1.6-1.6M7.9 7.9 6.3 6.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
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
  initialActiveId,
}: {
  myUserId: string;
  myName: string;
  conversations: ConversationSummary[] | null;
  onClose: () => void;
  onSent: (conversationId: string, message: ChatMessage) => void;
  // pré-seleciona uma conversa ao abrir -- pedido do Douglas: "quero
  // agora, mais um icone de contatos" (28/set), clicar em "Conversar"
  // no painel de Contatos já abre DIRETO a conversa com a pessoa, sem
  // passar pela lista. Só lido no useState inicial (ver abaixo) porque
  // esse painel inteiro só existe montado enquanto chatPanelOpen é
  // true (desmonta ao fechar, ver componente Lobby mais abaixo) --
  // cada abertura é um mount novo, então dá pra usar como valor
  // inicial sem precisar sincronizar com um efeito.
  initialActiveId?: string | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(initialActiveId ?? null);
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
  // Contatos (28/set, pedido do Douglas: "quero agora, mais um icone
  // de contatos") -- diretório platform-wide via GET /users/directory
  // (mesma fonte de chatStore.listAllUsers que o WS manda como
  // "users:list" de dentro da sala, ver comentário grande em
  // ContactsPanel.tsx). openChatConversationId é a "ponte" pra abrir o
  // LobbyChatPanel JÁ na conversa certa ao clicar "Conversar" (ver
  // handleStartConversation mais abaixo).
  const [directory, setDirectory] = useState<ContactUser[] | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [openChatConversationId, setOpenChatConversationId] = useState<string | null>(null);

  // Barra de topo (28/set, pedido do Douglas com print de referência
  // do site da Pepsi -- só a DIAGRAMAÇÃO, canto superior esquerdo:
  // logo à esquerda, abas na mesma linha) -- "Meus espaços" é a
  // primeira aba, com setinha seletora: hoje só existe UMA sala no
  // ambiente todo (STORE_SLUG "sala-principal", ver server/chatStore.js
  // -- ainda não existe conceito de múltiplas salas/organizações no
  // backend), então o menu lista só ela; o dropdown já fica pronto pra
  // quando existir mais de uma (aí lista o nome de cada organização,
  // como o Douglas pediu).
  const [spacesMenuOpen, setSpacesMenuOpen] = useState(false);

  // "card" da conta do cliente -- pedido do Douglas (28/set, print de
  // referência de um card "Hello! I'm Max"): "aqui nesse canto, faca o
  // card da conta do cliente" + "faca o 'card' do perfil do usuario
  // aberto". Fica no canto direito da barra (3ª coluna do grid, que já
  // tava vazia/reservada, ver comentário grande em app/globals.css).
  const [accountCardOpen, setAccountCardOpen] = useState(false);

  // "card" da Empresa selecionada -- pedido do Douglas (28/set, print
  // de referência do card "Obrazur" de X/Twitter): "nesse canto quero
  // o card da Empresa selecionada". Sem backend de empresas ainda
  // (mesmo estado de "Empresas Posicionadas" na barra, ver
  // lobby-topbar-tab-inert) -- valores abaixo são só EXEMPLO/molde
  // pra mostrar o card funcionando; quando existir uma empresa de
  // verdade cadastrada, isso vira dado real vindo do backend em vez
  // de constante fixa.
  const [companyCardOpen, setCompanyCardOpen] = useState(false);
  const [agendaPanelOpen, setAgendaPanelOpen] = useState(false);

  // --- mic/câmera do Lobby (28/set, pedido do Douglas vendo a av-bar
  // de dentro da sala: "cade o restante, configuracoes, audio, video,
  // tela") -- os botões aqui só guardam a PREFERÊNCIA (localStorage,
  // ver lib/mediaPrefs.ts), sem pedir câmera/mic de verdade -- Douglas
  // pediu pra tirar a prévia de vídeo do Lobby ("tira isso do lobby",
  // reagindo à caixa "Sem acesso à câmera/microfone"), então voltamos
  // ao princípio original: só pede permissão quando a pessoa entra na
  // sala de verdade (ver requestMedia em GameRoom.tsx), que aplica essa
  // mesma preferência salva aqui. Trocar de aparelho em "Configurações"
  // ainda pede stream (só naquele clique, ação explícita). ---
  const [micOn, setMicOn] = useState(() => getStoredMicOn());
  const [camOn, setCamOn] = useState(() => getStoredCamOn());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState(() => getStoredMicDeviceId());
  const [selectedCamId, setSelectedCamId] = useState(() => getStoredCamDeviceId());
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => getStoredSpeakerDeviceId());
  const localStreamRef = useRef<MediaStream | null>(null);

  const myUserId = useMemo(() => resolveUserId(accountUserId), [accountUserId]);
  const myName = accountProfile?.name?.trim() || "Visitante";

  useEffect(() => {
    return () => {
      // solta qualquer stream aberta (só existe se a pessoa mexeu em
      // "Configurações" pra testar um aparelho, ver switchMicDevice/
      // switchCamDevice) ao sair do Lobby de qualquer jeito.
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Sem stream ativa no Lobby por padrão -- os botões só trocam a
  // preferência salva (aplicada de verdade quando entra na sala, ver
  // requestMedia em GameRoom.tsx).
  function toggleMic() {
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !micOn));
    setMicOn((v) => {
      setStoredMicOn(!v);
      return !v;
    });
  }

  function toggleCam() {
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !camOn));
    setCamOn((v) => {
      setStoredCamOn(!v);
      return !v;
    });
  }

  // MESMA ideia de switchMicDevice/switchCamDevice em GameRoom.tsx, só
  // que bem mais simples: sem peers/WebRTC nenhum aqui pra reencaminhar
  // a track nova, é só trocar o preview local mesmo.
  async function switchMicDevice(deviceId: string) {
    if (!deviceId || deviceId === selectedMicId) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) return;
      newTrack.enabled = micOn;
      const stream = localStreamRef.current;
      const oldTrack = stream?.getAudioTracks()[0];
      if (stream && oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
        stream.addTrack(newTrack);
      } else {
        localStreamRef.current = fresh;
      }
      setSelectedMicId(deviceId);
      setStoredMicDeviceId(deviceId);
    } catch (e) {
      console.warn("Não deu pra trocar de microfone", e);
    }
  }

  async function switchCamDevice(deviceId: string) {
    if (!deviceId || deviceId === selectedCamId) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return;
      newTrack.enabled = camOn;
      const stream = localStreamRef.current;
      const oldTrack = stream?.getVideoTracks()[0];
      if (stream && oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
        stream.addTrack(newTrack);
      } else {
        localStreamRef.current = fresh;
      }
      setSelectedCamId(deviceId);
      setStoredCamDeviceId(deviceId);
    } catch (e) {
      console.warn("Não deu pra trocar de câmera", e);
    }
  }

  function switchSpeakerDevice(deviceId: string) {
    setSelectedSpeakerId(deviceId);
    setStoredSpeakerDeviceId(deviceId);
  }

  function handleEnter() {
    // solta a câmera/mic do Lobby ANTES de entrar -- o GameRoom pede a
    // dele própria (ver requestMedia lá), sem isso os dois ficariam
    // segurando o mesmo dispositivo ao mesmo tempo por um instante.
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    onEnter();
  }

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

  // Diretório de Contatos -- não depende de myUserId pra listar (todo
  // mundo cadastrado), só pra filtrar "eu mesmo" (ver ContactsPanel.tsx).
  useEffect(() => {
    let cancelled = false;
    fetch(`${REALTIME_HTTP_BASE}/users/directory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setDirectory(Array.isArray(data?.users) ? data.users : []);
      })
      .catch(() => {
        if (!cancelled) setDirectory([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // "Conversar" no painel de Contatos -- cria (ou acha) a conversa
  // direta via POST /chat/direct (sem WebSocket, mesma arquitetura do
  // resto do Lobby, ver comentário grande no topo do arquivo), soma o
  // resultado na lista de conversas (upsert por id, pra não duplicar
  // se já existia) e manda o LobbyChatPanel abrir JÁ nela.
  async function handleStartConversation(targetUserId: string) {
    if (!myUserId || contactsBusy) return;
    setContactsBusy(true);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/chat/direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: myUserId, userName: myName, targetUserId }),
      });
      if (res.ok) {
        const data = await res.json();
        const conv = data?.conversation as ConversationSummary | undefined;
        if (conv) {
          setConversations((prev) => {
            const rest = (prev ?? []).filter((c) => c.id !== conv.id);
            return [conv, ...rest];
          });
          setOpenChatConversationId(conv.id);
          setContactsOpen(false);
          setChatPanelOpen(true);
        }
      }
    } catch {
      // rede caiu -- painel de Contatos continua aberto, pessoa tenta de novo
    } finally {
      setContactsBusy(false);
    }
  }

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
  // "card" da conta (ver accountCardOpen) -- campos que a conta JÁ tem
  // de verdade, sem inventar nada que o print de referência mostrava
  // mas a gente não coleta (idade, skills, localização).
  const accountBio = accountProfile?.bio?.trim() || "";
  const accountInstagram = accountProfile?.instagram?.trim().replace(/^@/, "") || "";
  const accountInitial = displayName.charAt(0).toUpperCase() || "?";
  const accountStatusId = accountProfile?.status || "online";
  const accountStatusLabel = ACCOUNT_STATUS_LABELS[accountStatusId] || ACCOUNT_STATUS_LABELS.online;
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
      {/* barra de topo -- pedido do Douglas (28/set, com print de
          referência do layout da Pepsi): logo no canto esquerdo
          superior + abas na mesma linha, começando por "Meus
          espaços". */}
      <div className="lobby-topbar">
        <div className="lobby-topbar-logo-group">
          {/* semáforo decorativo removido -- pedido do Douglas (28/set):
              "tire isso, esses pontinhos". */}
          <span className="lobby-topbar-logo">Habbo-gather</span>
        </div>
        <nav className="lobby-topbar-nav">
          <div className="lobby-topbar-tab-wrap">
            <button
              type="button"
              // sempre "active" -- é a seção atual (mesma ideia da
              // bolinha atrás de "PRODUCTS" no print de referência,
              // que marca a aba selecionada, não se o menu tá aberto;
              // aberto/fechado é só a setinha girar, ver
              // lobby-topbar-chevron logo abaixo).
              className="lobby-topbar-tab active"
              onClick={() => setSpacesMenuOpen((v) => !v)}
              aria-expanded={spacesMenuOpen}
            >
              <span className="lobby-topbar-tab-label">Meus espaços</span>
              <span className={spacesMenuOpen ? "lobby-topbar-chevron open" : "lobby-topbar-chevron"}>
                <ChevronIcon />
              </span>
            </button>
            {spacesMenuOpen && (
              <>
                <div className="lobby-topbar-dropdown-backdrop" onClick={() => setSpacesMenuOpen(false)} />
                <div className="lobby-topbar-dropdown">
                  <button type="button" className="lobby-topbar-dropdown-item active">
                    Sala principal
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 28/set, pedido do Douglas: "meus espacos | espacos
              publicos | eventos | Empresas Posicionadas" -- essas três
              ainda não têm tela nenhuma por trás (ver comentário
              grande de .lobby-topbar-tab-inert em app/globals.css),
              então ficam visíveis pra fechar o menu pedido mas não
              fazem nada ainda -- mesmo espírito do botão de tela do
              av-bar (ScreenIcon), inclusive sem usar `disabled` nativo
              de propósito, pra não sumir o tooltip. */}
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Espaços públicos</span>
          </button>
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Eventos</span>
          </button>
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Empresas Posicionadas</span>
          </button>
        </nav>

        {/* 3ª coluna do grid (canto direito): card da empresa em
            destaque + card da conta do cliente lado a lado. */}
        <div className="lobby-topbar-right-group">
          {/* "card" da Empresa selecionada -- pedido do Douglas: "nesse
              canto quero o card da Empresa selecionada / Copie
              EXATAMENTE TUDO". Ver comentário do FEATURED_COMPANY acima
              sobre por que o conteúdo é um molde/exemplo, não os dados
              reais da referência. */}
          <div className="lobby-topbar-company-wrap">
            <button
              type="button"
              className="lobby-topbar-company-chip"
              onClick={() => setCompanyCardOpen((v) => !v)}
              aria-expanded={companyCardOpen}
            >
              <span className="lobby-topbar-company-chip-logo">{FEATURED_COMPANY.name.charAt(0)}</span>
              <span className="lobby-topbar-company-chip-name">{FEATURED_COMPANY.name}</span>
            </button>
            {companyCardOpen && (
              <>
                <div className="company-card-backdrop" onClick={() => setCompanyCardOpen(false)} />
                <div className="company-card">
                  <div className="company-card-top">
                    <p className="company-card-tagline">
                      {FEATURED_COMPANY.tagline}
                      <br />
                      {FEATURED_COMPANY.taglineEnd}
                    </p>
                    <div className="company-card-logo-box">{FEATURED_COMPANY.name.charAt(0)}</div>
                    <div className="company-card-socials">
                      <span className="company-card-social-icon">
                        <XSocialIcon />
                      </span>
                      <span className="company-card-social-icon">
                        <LinkedInSocialIcon />
                      </span>
                      <span className="company-card-social-icon">
                        <ButterflySocialIcon />
                      </span>
                      <span className="company-card-follow-btn">Seguir</span>
                    </div>
                  </div>
                  <div className="company-card-bottom">
                    <p className="company-card-name">
                      {FEATURED_COMPANY.name}
                      <VerifiedBadge />
                    </p>
                    <p className="company-card-handle">@{FEATURED_COMPANY.handle}</p>
                    <p className="company-card-bio">{FEATURED_COMPANY.bio}</p>
                    <p className="company-card-stats">
                      <span>
                        <strong>{FEATURED_COMPANY.following}</strong> Seguindo
                      </span>
                      <span>
                        <strong>{FEATURED_COMPANY.followers}</strong> Seguidores
                      </span>
                    </p>
                    <p className="company-card-link">
                      <LinkIcon />
                      {FEATURED_COMPANY.link}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* "card" da conta do cliente -- pedido do Douglas (28/set,
              print de referência de um card "Hello! I'm Max"): "aqui
              nesse canto, faca o card da conta do cliente" + "faca o
              'card' do perfil do usuario aberto". */}
          <div className="lobby-topbar-account-wrap">
            <button
              type="button"
              className="lobby-topbar-account"
              onClick={() => setAccountCardOpen((v) => !v)}
              aria-expanded={accountCardOpen}
            >
              <span className="lobby-topbar-account-avatar">
                {accountProfile?.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={accountProfile.photoUrl} alt="" />
                ) : (
                  accountInitial
                )}
              </span>
              <span className="lobby-topbar-account-name">{displayName}</span>
            </button>
            {accountCardOpen && (
              <>
                <div className="lobby-account-card-backdrop" onClick={() => setAccountCardOpen(false)} />
                <div className="lobby-account-card">
                  {/* pedido do Douglas: "tire o olha sou deixe apenas o nome". */}
                  <p className="lobby-account-card-greeting">{displayName}</p>
                  {accountBio && <p className="lobby-account-card-bio">{accountBio}</p>}
                  <div className="lobby-account-card-tags">
                    <span className="lobby-account-card-tag lobby-account-card-tag-status">
                      <span className={`lobby-account-card-status-dot ${accountStatusId}`} />
                      {accountStatusLabel}
                    </span>
                    {accountInstagram && (
                      <a
                        className="lobby-account-card-tag"
                        href={`https://instagram.com/${accountInstagram}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        @{accountInstagram}
                      </a>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

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

        <button type="button" className="lobby-enter-btn" onClick={handleEnter}>
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
          className={micOn ? "av-btn" : "av-btn off"}
          onClick={toggleMic}
          aria-label={micOn ? "Desligar microfone" : "Ligar microfone"}
          data-tooltip={micOn ? "Desligar mic" : "Ligar mic"}
        >
          <MicIcon off={!micOn} />
        </button>
        <button
          type="button"
          className={camOn ? "av-btn" : "av-btn off"}
          onClick={toggleCam}
          aria-label={camOn ? "Desligar câmera" : "Ligar câmera"}
          data-tooltip={camOn ? "Desligar câmera" : "Ligar câmera"}
        >
          <CamIcon off={!camOn} />
        </button>
        {/* "tela" -- pedido do Douglas: "cade o restante... tela",
            mas compartilhar tela SÓ FAZ SENTIDO com alguém do outro
            lado pra ver (WebRTC de verdade, ver toggleScreenShare em
            GameRoom.tsx) -- não existe isso no Lobby. Ícone fica pra
            bater com a barra de dentro da sala, desabilitado com
            tooltip explicando em vez de fingir que funciona. */}
        <button
          type="button"
          className="av-btn lobby-av-btn-inert"
          onClick={(e) => e.preventDefault()}
          aria-disabled="true"
          data-tooltip="Compartilhar tela só dentro da sala"
        >
          <ScreenIcon />
        </button>
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
        <button
          type="button"
          className={contactsOpen ? "av-btn on" : "av-btn"}
          onClick={() => setContactsOpen((v) => !v)}
          aria-label={contactsOpen ? "Fechar contatos" : "Abrir contatos"}
          data-tooltip={contactsOpen ? "Fechar contatos" : "Contatos"}
        >
          <ContactsIcon />
        </button>
        <button
          type="button"
          className={settingsOpen ? "av-btn on" : "av-btn"}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label={settingsOpen ? "Fechar configurações" : "Configurações"}
          data-tooltip={settingsOpen ? "Fechar configurações" : "Configurações"}
        >
          <GearIcon />
        </button>
      </div>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          micOn={micOn}
          camOn={camOn}
          selectedMicId={selectedMicId}
          selectedCamId={selectedCamId}
          selectedSpeakerId={selectedSpeakerId}
          onSelectMic={switchMicDevice}
          onSelectCam={switchCamDevice}
          onSelectSpeaker={switchSpeakerDevice}
          spaceVolume={1}
          onChangeSpaceVolume={() => {}}
          remoteUsers={[]}
          remoteVolumes={{}}
          onChangeRemoteVolume={() => {}}
        />
      )}

      {chatPanelOpen && (
        <LobbyChatPanel
          myUserId={myUserId}
          myName={myName}
          conversations={conversations}
          onClose={() => {
            setChatPanelOpen(false);
            setOpenChatConversationId(null);
          }}
          onSent={handleMessageSent}
          initialActiveId={openChatConversationId}
        />
      )}
      {contactsOpen && (
        <ContactsPanel
          users={directory ?? []}
          myUserId={myUserId}
          onStartConversation={(targetUserId) => handleStartConversation(targetUserId)}
          onClose={() => setContactsOpen(false)}
          loading={directory === null}
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
