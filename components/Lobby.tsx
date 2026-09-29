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
//
// 29/set: pedido do Douglas "quero uma setinha do lado do card da
// empresa, abrindo a aba de edicao: Nome fantasia / cnpj / permissoes
// de exibicao" + "e editar foto de perfil, e foto de banner do card
// da empresa" -- virou estado editável (companyProfile/
// setCompanyProfile) em vez de const fixa, pra edição realmente
// refletir no card ao vivo. Continua tudo local (useState, sem
// persistir em lugar nenhum) pelo MESMO motivo do comentário acima:
// não tem backend de empresa ainda -- quando existir, isso troca pra
// vir/salvar no banco em vez de só na memória da aba.
type CompanyProfile = {
  name: string;
  cnpj: string;
  handle: string;
  bio: string;
  following: number;
  followers: number;
  link: string;
  logoUrl: string;
  bannerUrl: string;
  // "Permitir exibicao do nome da empresa do perfil dos
  // colaboradores?" -- também só fica guardado localmente por
  // enquanto (mesmo motivo acima); o perfil dos colaboradores ainda
  // não lê esse valor de lugar nenhum.
  showNameOnEmployeeProfiles: boolean;
};

const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  name: "Empresa Exemplo",
  cnpj: "",
  handle: "empresaexemplo",
  bio: "Espaço reservado para a empresa patrocinadora em destaque na plataforma.",
  following: 24,
  followers: 57,
  link: "habbo-gather.com/empresas",
  logoUrl: "",
  bannerUrl: "",
  showNameOnEmployeeProfiles: true,
};

// digita só número, mostra formatado (00.000.000/0000-00) -- mesma
// ideia de "formata enquanto digita" de qualquer campo de CPF/CNPJ
// brasileiro; nunca deixa passar de 14 dígitos.
function formatCnpj(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 14);
  let out = digits;
  if (digits.length > 12) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{1,2})$/, "$1.$2.$3/$4-$5");
  else if (digits.length > 8) out = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{1,4})$/, "$1.$2.$3/$4");
  else if (digits.length > 5) out = digits.replace(/^(\d{2})(\d{3})(\d{1,3})$/, "$1.$2.$3");
  else if (digits.length > 2) out = digits.replace(/^(\d{2})(\d{1,3})$/, "$1.$2");
  return out;
}

// mesma ideia de compressPhotoToDataUrl em GameRoom.tsx (recorta
// quadrado central, reamostra, exporta JPEG pequeno) -- copiada (não
// importada, GameRoom não exporta essa função, mesmo motivo dos
// ícones acima) e reaproveitada pra logo/foto de perfil da empresa.
function compressSquarePhotoToDataUrl(file: File, target = 240): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error("Não deu pra ler a imagem"));
      img.onload = () => {
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        const finalSize = Math.min(target, size);
        const canvas = document.createElement("canvas");
        canvas.width = finalSize;
        canvas.height = finalSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, sx, sy, size, size, 0, 0, finalSize, finalSize);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// variante SEM recorte quadrado, pro banner (retangular, largo) --
// só reamostra pra caber num teto de largura/altura, mantendo a
// proporção original da foto (o CSS do card usa background-size:cover
// pra preencher a faixa clara de cima, então não precisa vir
// pré-cortada num formato exato).
function compressBannerPhotoToDataUrl(file: File, maxWidth = 640, maxHeight = 320): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error("Não deu pra ler a imagem"));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// MESMO ícone de "trocar foto" (profile-photo-edit) do editor de
// perfil dentro da sala em GameRoom.tsx -- copiado (não importada,
// mesmo motivo de sempre) pros botões de trocar logo/banner aqui.
function BrushIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 20c0-3.2 1.3-5 4-5s3 1.8 3 3.5S9.5 21 8 21c-1.8 0-2.4-1-4-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="m10.5 14.5 7.3-7.3a2 2 0 0 0 0-2.8l-.2-.2a2 2 0 0 0-2.8 0L7.5 11.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
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

  // card da Empresa selecionada é sempre visível (ver
  // .lobby-company-card-pin lá embaixo, perto de .lobby-card) -- mas
  // agora tem uma aba de EDIÇÃO (companyEditOpen), aberta pela
  // setinha do lado do card (ver DEFAULT_COMPANY_PROFILE/CompanyProfile
  // lá em cima pra entender por que os dados ficam em state em vez de
  // const fixa).
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(DEFAULT_COMPANY_PROFILE);
  const [companyEditOpen, setCompanyEditOpen] = useState(false);
  const companyLogoInputRef = useRef<HTMLInputElement>(null);
  const companyBannerInputRef = useRef<HTMLInputElement>(null);

  async function handleCompanyLogoChange(file: File) {
    try {
      const dataUrl = await compressSquarePhotoToDataUrl(file);
      setCompanyProfile((prev) => ({ ...prev, logoUrl: dataUrl }));
    } catch (e) {
      console.warn("Não deu pra processar a foto de perfil da empresa", e);
    }
  }

  async function handleCompanyBannerChange(file: File) {
    try {
      const dataUrl = await compressBannerPhotoToDataUrl(file);
      setCompanyProfile((prev) => ({ ...prev, bannerUrl: dataUrl }));
    } catch (e) {
      console.warn("Não deu pra processar o banner da empresa", e);
    }
  }

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

        {/* canto direito do topbar: só o card da conta agora -- o card
            da Empresa saiu daqui (ver .lobby-company-card-pin logo
            abaixo de .lobby-topbar) porque o Douglas apontou que a
            posição certa dele é fixa no canto ESQUERDO da tela, não um
            dropdown do lado direito. */}
        <div className="lobby-topbar-right-group">
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

      {/* card da Empresa selecionada -- pedido do Douglas: "nesse canto
          quero o card da Empresa selecionada / Copie EXATAMENTE TUDO"
          + depois, ao ver o print de referência de novo: "nao e ali
          que e pra ele estar" (não era pra ficar como dropdown no
          canto direito, do lado da conta). Fixo no canto ESQUERDO da
          tela, sempre visível (sem clique pra abrir) -- combina com o
          nome da aba "Empresas Posicionadas" no topbar: é uma vitrine
          fixa, não um menu. Ver comentário do CompanyProfile lá em
          cima sobre por que o conteúdo é um molde/exemplo, não os
          dados reais da referência (Obrazur).

          29/set: + a setinha do lado que abre a aba de edição (ver
          companyEditOpen/DEFAULT_COMPANY_PROFILE lá em cima). */}
      <div className="lobby-company-card-pin">
        <div className="company-card">
          {/* 29/set: pedido do Douglas "a frase no caso e a imagem do
              banner, nao e um texto" -- tirei o texto/frase de efeito
              que eu tinha desenhado por cima (era conteúdo INVENTADO
              meu, o print de referência só tinha aquele texto porque
              fazia parte do design ORIGINAL do banner da Obrazur, não
              porque o app deveria desenhar um texto ali). Essa faixa
              clara agora é só a moldura da foto de banner mesmo (ver
              companyProfile.bannerUrl) -- sem overlay/tinta em cima
              (não tem mais texto pra proteger a legibilidade de). */}
          <div
            className="company-card-top"
            style={companyProfile.bannerUrl ? { backgroundImage: `url(${companyProfile.bannerUrl})` } : undefined}
          >
            <div className="company-card-logo-box">
              {companyProfile.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={companyProfile.logoUrl} alt="" />
              ) : (
                companyProfile.name.charAt(0)
              )}
            </div>
          </div>
          <div className="company-card-bottom">
            <p className="company-card-name">
              {companyProfile.name}
              <VerifiedBadge />
            </p>
            <p className="company-card-handle">@{companyProfile.handle}</p>
            <p className="company-card-bio">{companyProfile.bio}</p>
            <p className="company-card-stats">
              <span>
                <strong>{companyProfile.following}</strong> Seguindo
              </span>
              <span>
                <strong>{companyProfile.followers}</strong> Seguidores
              </span>
            </p>
            <p className="company-card-link">
              <LinkIcon />
              {companyProfile.link}
            </p>
          </div>
        </div>

        <button
          type="button"
          className="company-card-edit-trigger"
          onClick={() => setCompanyEditOpen(true)}
          aria-expanded={companyEditOpen}
          title="Editar empresa"
          data-tooltip="Editar empresa"
        >
          <ChevronRightIcon />
        </button>
      </div>

      {companyEditOpen && (
        <div className="items-panel-backdrop" onClick={() => setCompanyEditOpen(false)}>
          <div className="items-panel company-edit-panel" onClick={(e) => e.stopPropagation()}>
            <div className="items-panel-header">
              <h2>Editar empresa</h2>
              <button type="button" className="items-panel-close" onClick={() => setCompanyEditOpen(false)} title="Fechar">
                ✕
              </button>
            </div>

            <section className="items-panel-section">
              <h3>Fotos</h3>

              <div className="company-edit-photo-row">
                <div className="company-edit-photo-field">
                  <div className="company-edit-photo-preview company-edit-photo-preview-logo">
                    {companyProfile.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={companyProfile.logoUrl} alt="" />
                    ) : (
                      <span>{companyProfile.name.charAt(0)}</span>
                    )}
                    <button
                      type="button"
                      className="company-edit-photo-btn"
                      onClick={() => companyLogoInputRef.current?.click()}
                      title="Trocar foto de perfil"
                    >
                      <BrushIcon />
                    </button>
                  </div>
                  <input
                    ref={companyLogoInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCompanyLogoChange(file);
                      e.target.value = "";
                    }}
                  />
                  <span className="company-edit-photo-label">Foto de perfil</span>
                </div>

                <div className="company-edit-photo-field company-edit-photo-field-banner">
                  <div className="company-edit-photo-preview company-edit-photo-preview-banner">
                    {companyProfile.bannerUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={companyProfile.bannerUrl} alt="" />
                    ) : (
                      <span>Sem banner</span>
                    )}
                    <button
                      type="button"
                      className="company-edit-photo-btn"
                      onClick={() => companyBannerInputRef.current?.click()}
                      title="Trocar foto de banner"
                    >
                      <BrushIcon />
                    </button>
                  </div>
                  <input
                    ref={companyBannerInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCompanyBannerChange(file);
                      e.target.value = "";
                    }}
                  />
                  <span className="company-edit-photo-label">Foto de banner</span>
                </div>
              </div>
            </section>

            <section className="items-panel-section">
              <h3>Dados da empresa</h3>

              <label className="settings-field">
                <span>Nome fantasia</span>
                <input
                  className="items-panel-input"
                  value={companyProfile.name}
                  maxLength={60}
                  onChange={(e) => setCompanyProfile((prev) => ({ ...prev, name: e.target.value }))}
                />
              </label>

              <label className="settings-field">
                <span>CNPJ</span>
                <input
                  className="items-panel-input"
                  value={companyProfile.cnpj}
                  placeholder="00.000.000/0000-00"
                  inputMode="numeric"
                  maxLength={18}
                  onChange={(e) => setCompanyProfile((prev) => ({ ...prev, cnpj: formatCnpj(e.target.value) }))}
                />
              </label>
            </section>

            <section className="items-panel-section">
              <h3>Permissões de exibição</h3>

              <label className="settings-hint settings-hint-check">
                <input
                  type="checkbox"
                  checked={companyProfile.showNameOnEmployeeProfiles}
                  onChange={(e) =>
                    setCompanyProfile((prev) => ({ ...prev, showNameOnEmployeeProfiles: e.target.checked }))
                  }
                />
                Permitir exibição do nome da empresa no perfil dos colaboradores?
              </label>
            </section>
          </div>
        </div>
      )}

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
