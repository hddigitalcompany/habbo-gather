"use client";

import dynamic from "next/dynamic";
import PartySocket from "partysocket";

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
// plataforma") -- os ícones aqui são os MESMOS ChatIcon/AgendaIcon da
// av-bar do GameRoom (copiados, ver comentário deles abaixo) e abrem o
// MESMO painel de verdade que a sala usa (ChatDrawer/AgendaDrawer),
// alimentado pelo MESMO motor único (usePlatformChat.ts -- UMA conexão
// de plataforma, mantida desde o login, independente de Lobby/sala, ver
// comentário grande no topo de usePlatformChat.ts). Virou assim em duas
// etapas: chat em 1/out (pedido do Douglas: "pega o chat de dentro e
// transforma ele em CHAT que acompanha toda a plataforma") e agenda em
// 2/out (pedido do Douglas: "quero ela [a agenda] toda isolada tambem,
// e sistema unico, assim como o chat, funcionando acima de tudo, acima
// de lobby acima de jogo") -- antes disso cada um tinha sua própria
// reimplementação REST só pro Lobby (LobbyChatPanel/LobbyAgendaPanel,
// ambos removidos), sem WebSocket nenhum aqui. Esse arquivo não abre
// conexão própria nenhuma mais: conversar, marcar/responder compromisso,
// anexo -- tudo passa pelo `chat` recebido via prop (platformChat, ver
// Home() em app/page.tsx). Só entrar numa CHAMADA de voz/vídeo de
// verdade (WebRTC) continua exigindo estar dentro da sala.

import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import type { AccountProfile } from "@/components/AuthGate";
import { resolveUserId } from "@/lib/identity";
import {
  SPACE_VOLUME_STORAGE_KEY,
  CALL_VOLUME_STORAGE_KEY,
  getStoredVolume,
  setStoredVolume,
  getStoredNotificationPrefs,
  setStoredNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/settingsPrefs";
import SettingsPanel from "@/components/SettingsPanel";
import FriendsPanel, { type ContactUser } from "@/components/FriendsPanel";
import ProfileViewCard from "@/components/ProfileViewCard";
import AccountCard from "@/components/AccountCard";
// 1/out, pedido do Douglas ("eu quero a mesma estrutura nao que seja
// separado", depois de "o layout do chat de fora tem que ser igual ao
// de dentro, ja falei isso MIL VEZES") -- o chat de fora (LobbyChatPanel
// mais abaixo) PAROU de ter sua própria gaveta/JSX duplicada e passou a
// renderizar o MESMO ChatDrawer que a sala usa (components/GameRoom.tsx
// chama ele igual, ver chatDrawerProps lá) -- só os DADOS vêm de
// fontes diferentes (REST aqui, WebSocket lá, ver comentário grande no
// topo do arquivo sobre esse painel ser REST-only), a tela/estrutura é
// uma só agora. Os tipos (Conversation/ChatMsg/ChatMsgKind) só type-only
// (apagados na compilação, não puxam o módulo de GameRoom.tsx pro bundle
// -- quem puxa de verdade é o próprio ChatDrawer, mesma peça que a sala
// já carrega hoje) -- usados só pra converter ConversationSummary/
// ChatMessage (formato leve que o REST devolve) pro formato que o
// ChatDrawer espera, ver toDrawerConversation/toDrawerMessage abaixo.
// dynamic (ssr:false) de propósito, NÃO import estático: GameRoom.tsx
// inteiro (Phaser/engine do jogo) só carrega hoje atrás do próprio
// dynamic() dele em app/page.tsx (ver const GameRoom = dynamic(...)) --
// como o ChatDrawer importa valores de verdade de lá (ícones/helpers,
// ver topo de components/ChatDrawer.tsx), um import ESTÁTICO aqui
// arrastaria esse módulo inteiro pro bundle do Lobby (que carrega ANTES
// de entrar na sala) e, pior, pro RENDER NO SERVIDOR da "/" (Next tenta
// pré-renderizar a Home) -- GameRoom.tsx nunca foi escrito pra rodar no
// servidor (quebrava o build com "window is not defined" antes dessa
// troca pra dynamic). Os TIPOS (Conversation/ChatMsg/ChatMsgKind) continuam
// import normal -- type-only é apagado na compilação, não carrega nada
// de verdade (ver comentário grande de sempre sobre isso).
const ChatDrawer = dynamic(() => import("@/components/ChatDrawer").then((m) => m.ChatDrawer), {
  // sem loading customizado de propósito: ao contrário de entrar na
  // sala (GameRoom.tsx, troca de TELA inteira, por isso tem "Carregando
  // sala..."), abrir o chat é um painел pequeno por cima do Lobby --
  // um placeholder com posição própria ia precisar saber pinMode
  // (flutuante vs fixado) pra não ficar torto por meio segundo, e o
  // dynamic() não repassa isso pro componente de loading. Fica null
  // (padrão) -- carrega rápido (chunk pequeno) e só acontece na
  // PRIMEIRA vez que a pessoa abre o chat na sessão.
  ssr: false,
});
import type { Conversation, ChatMsg, ChatMsgKind, ChatCallParticipant, ChatTypingEntry, CallEvent } from "@/components/GameRoom";
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
// 1/out -- motor único de chat (ver comentário grande dele),
// montado uma vez em app/page.tsx e passado aqui via prop
// `platformChat` (mesma instância que a sala vai consumir quando
// ela também migrar, ver comentário em app/page.tsx).
import { usePlatformChat } from "@/components/usePlatformChat";
type PlatformChat = ReturnType<typeof usePlatformChat>;

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
  `://${REALTIME_HOST}`;

// 1/out, pedido do Douglas ("pega o chat de dentro e transforma ele em
// CHAT que acompanha toda a plataforma") -- Lobby não tem mais chat/
// chamada/socket próprios: tudo (conversas, chamada, digitando...) vem
// de usePlatformChat (ver import no topo do arquivo e `chat` logo no
// começo do componente Lobby), a MESMA conexão/engine que a sala vai
// consumir. Só sobra aqui a preferência de UI (flutuante x encaixado)
// de onde esse painel fica.
const LOBBY_CHAT_PINNED_STORAGE_KEY = "habbo-gather-lobby-chat-pinned";

type PresenceInfo = { totalOnline: number } | null;

// CallParticipant/CallSummary saíram daqui (2/out) -- a "previa da
// agenda" abaixo agora usa CallEvent direto (type-only import de
// GameRoom.tsx, mesmo padrão de Conversation/ChatMsg acima), MESMO tipo
// que o motor único (usePlatformChat.ts) já produz -- sem redefinir um
// tipo paralelo só pra Lobby.

type FloorTile = { col: number; row: number; styleId: string };
type FurnitureItem = { col: number; row: number; type: string };
type WallSegment = { col: number; row: number; side: "rowPlus" | "colPlus" };

type RoomShape = {
  floor: FloorTile[];
  furniture: FurnitureItem[];
  walls: WallSegment[];
} | null;

// espaços FIXOS do TIME do Douglas em "Meus espaços" (ver dropdown
// mais abaixo) -- CORRIGIDO 29/set: "seguinte o cliente so vai ver
// Mapa modelo, apenas eu vejo o Mapa Publicado... Cada cliente vai ter
// a sua sala, nao só essa que eu crio... O cara entra, ele tem a sala
// dele la que ele escolher dentre os modelos... A minha e so minha,
// minha equipe vai entrar na minha sala por link de convidado". Isso
// muda o que "Mapa modelo" significa aqui: ele NÃO é mais uma sala
// compartilhada que qualquer visitante entra direto -- é a área onde
// o Douglas (e o time dele) CONSTRÓI/decora os modelos que os
// clientes só COPIAM (ver "Criar minha sala" mais abaixo, POST
// /api/room/create-from-template) -- por isso teamOnly:true nos DOIS
// agora, igual "Sala principal". Um "visitor" de verdade (cliente sem
// convite pro time) não vê NENHUM dos dois aqui -- ele ganha a PRÓPRIA
// sala (myRoom, ver fetch de /api/room/mine mais abaixo) e, antes
// disso, o fluxo de "Criar minha sala" (templateChoices, GET
// /api/room/templates). role "owner" (o Douglas) e "member" (quem
// redimiu o convite dele, ver app/api/room/invite/redeem/route.ts --
// esse convite JÁ existe, não é feature nova) continuam vendo os 2
// daqui, mesmo comportamento de sempre. Isso é só visibilidade de
// TELA (o dropdown não lista/oferece o botão) -- não é uma trava de
// servidor nova (o servidor sempre aceitou qualquer slug, ver
// comentário grande "MULTI-SALA" em server/roomStore.js), então não é
// uma garantia de segurança de verdade contra alguém client-side
// forçando a URL/room manualmente -- é o mesmo nível de confiança que
// canEditRoom em GameRoom.tsx já usa pra esconder o editor de espaço.
const ROOM_SLUGS: { slug: string; label: string; teamOnly: boolean }[] = [
  // 29/set (9), pedido do Douglas: "mude la encima no meu / SAla
  // principal, Mapa Publicado" -- só o RÓTULO em "Meus espaços"
  // mudou, o slug continua "mapa-publicado" (fixo no servidor
  // WebSocket, ver DEFAULT_ROOM_SLUG em server/roomStore.js e
  // STORE_SLUG em chatStore.js/agendaStore.js).
  { slug: "mapa-publicado", label: "Mapa Publicado", teamOnly: true },
  // 29/set (6), pedido do Douglas: "ok renomeie Sala Modelo" -- só o
  // RÓTULO mudou (label), o slug continua "mapa-modelo" (usado em
  // vários lugares no servidor/banco, ver comentário grande acima).
  { slug: "mapa-modelo", label: "Sala Modelo", teamOnly: true },
];

// um modelo publicado (ver GET /api/room/templates) -- é o que aparece
// pro cliente escolher em "Criar minha sala".
type RoomTemplate = { id: string; name: string; room_slug: string };
// a sala PRÓPRIA do cliente, se ele já tiver uma (ver GET
// /api/room/mine) -- criada por ele mesmo a partir de um RoomTemplate
// (POST /api/room/create-from-template).
type MyRoom = { id: string; name: string; room_slug: string };
// uma sala de OUTRA pessoa que essa conta já visitou por link (ver
// POST /api/room/visit / GET /api/room/visits) -- mesmo formato de
// MyRoom acima, é literalmente uma linha de `rooms` (nome/slug
// atuais, não uma cópia congelada no momento da visita).
type VisitedRoom = { id: string; name: string; room_slug: string };

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
  // 29/set (2): Douglas mandou o print de referência de novo, agora
  // apontando direto pro card "Entrar na sala": "copie exatamente o
  // que tem aqui... estilo fonte, cores, blur, tudo" -- a caixa de
  // prévia no print é um placeholder de câmera (ícone grande + fundo
  // escuro com um brilho suave desfocado atrás), não o mapinha
  // abstrato de piso/paredes. Só troquei o CONTEÚDO desses dois
  // estados vazios (sem piso ainda / carregando) pelo ícone -- o
  // mapinha de verdade (piso+paredes+móveis, abaixo) continua intocado,
  // ele é a prévia de verdade quando já tem dado real pra mostrar.
  if (loading) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span className="lobby-preview-empty-glow" />
        <CamIcon off={false} size={40} />
      </div>
    );
  }
  if (!room || room.floor.length === 0) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span className="lobby-preview-empty-glow" />
        <CamIcon off={false} size={40} />
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

// mesmo pacote de ícones do chat de dentro da sala (copiado, não
// importado, ver GameRoom.tsx) -- anexo/gravar/parar/apagar/arquivo.
function AttachIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M16.5 6.5 8.9 14.1a3 3 0 0 0 4.24 4.24l7.6-7.6a5 5 0 0 0-7.07-7.07l-7.6 7.6a7 7 0 0 0 9.9 9.9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 7h14M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M7 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h5a1.5 1.5 0 0 0 1.5-1.4L17 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3.5V8h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

// 1/out, pedido do Douglas (espelhar no chat de fora os mesmos ícones
// novos do chat de dentro da sala, ver ChatMessageRow/ChatDrawer em
// components/GameRoom.tsx) -- reação/fixar/painel de arquivos/
// @menção. Copiados (não importados, mesmo motivo de sempre nesse
// arquivo), MESMO traçado/tamanho dos de lá.
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}>
      <path
        d="M14.5 3.5 20.5 9.5 17 13l.5 5-3-2.5-4 4-1-1 4-4L11 12l3.5-3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 15 4 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SmileIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.3 14c.9 1.3 2.1 2 3.7 2s2.8-.7 3.7-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 10.2h.01M15 10.2h.01" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 3.5v12.5M7 11l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 19.5h15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AtIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M16.2 12v1.3a2.3 2.3 0 0 0 4.6 0V12a8.8 8.8 0 1 0-3.5 7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M20 20l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// mesmo conjunto fixo de emoji rápidos do chat de dentro da sala (ver
// QUICK_REACTION_EMOJIS em GameRoom.tsx).
const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "👏"];
// mesmas opções de "tempo de fixação" do chat de dentro da sala (ver
// PIN_DURATION_OPTIONS em GameRoom.tsx) -- durationMs null = sem
// prazo.
const PIN_DURATION_OPTIONS: { label: string; durationMs: number | null }[] = [
  { label: "1 hora", durationMs: 60 * 60 * 1000 },
  { label: "6 horas", durationMs: 6 * 60 * 60 * 1000 },
  { label: "24 horas", durationMs: 24 * 60 * 60 * 1000 },
  { label: "7 dias", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "Sem prazo", durationMs: null },
];

// "card" da Empresa selecionada -- pedido do Douglas: "nesse canto
// quero o card da Empresa selecionada" (print de referência: card
// estilo perfil do X/Twitter de uma marca real, "Obrazur"). Copiei o
// LAYOUT/estilo exatamente (fundo claro em cima com frase de efeito,
// ícones sociais + botão "Seguir", metade preta embaixo com logo,
// nome + selo verificado, @arroba, bio, seguidores/seguindo, link).
//
// 29/set: pedido do Douglas "quero uma setinha do lado do card da
// empresa, abrindo a aba de edicao: Nome fantasia / cnpj / permissoes
// de exibicao" + "e editar foto de perfil, e foto de banner do card
// da empresa" (CNPJ removido depois) -- virou estado editável
// (companyProfile/setCompanyProfile).
//
// 29/set (7): pedido do Douglas "quero cada card de empresa atrelado
// a um espaco" -- até aqui era um MOLDE fixo (localStorage, mesmo
// navegador, sem ligação com qual sala era qual, ver
// COMPANY_PROFILE_STORAGE_KEY antigo). Virou de VERDADE: cada ESPAÇO
// (linha de rooms, colunas company_*, ver migration
// 0040_room_company_profile.sql e app/api/room/company-profile) tem
// o próprio card, buscado pelo `selectedRoomSlug` atual (mesma
// seleção de "Meus espaços"/"Espaços visitados" -- troca de espaço
// selecionado busca outro card). `name` (Nome fantasia) É a mesma
// `rooms.name` de sempre (aparece em "Meus espaços"/aba "Empresa" do
// chat) -- editar aqui reescreve ela direto no servidor, então nunca
// mais diverge (substitui o sync manual de antes). Só o DONO do
// espaço selecionado pode editar (companyProfileCanEdit, calculado
// pelo servidor em cima do token -- ver rota); quem só tá olhando
// (visitante, ou outro espaço) vê o card mas sem a setinha de editar.
type CompanyProfile = {
  name: string;
  handle: string;
  // "Tagline" (frase de impacto) -- pedido do Douglas, 30/set (17):
  // "e a frase de impacto da empresa, ela aparecera assim no card,
  // logo acima do quem somos" + "essa frase, aparecera no perfil do
  // membro ao lado do icone da empresa" (ver company-card-tagline em
  // app/globals.css e ProfileViewCard.tsx).
  tagline: string;
  bio: string;
  followers: number;
  link: string;
  logoUrl: string;
  bannerUrl: string;
  // "Posicione a sua empresa:" (categoria/segmento) -- multi-select,
  // Douglas pediu pra poder marcar varias opcoes. Ver COMPANY_CATEGORIES
  // logo abaixo.
  category: string[];
  // "Permitir exibicao do nome da empresa do perfil dos
  // colaboradores?" -- guardado no banco (company_show_name_on_employee_profiles),
  // o perfil dos colaboradores ainda não lê esse valor de lugar
  // nenhum (fica pronto pra quando isso existir).
  showNameOnEmployeeProfiles: boolean;
  // "Tornar os founders visíveis no perfil da empresa?" -- pedido do
  // Douglas, 30/set (13): "vai aparecer no card da empresa a foto de
  // perfil dos founders com link clicavel pro perfil pessoal". Roster
  // À PARTE de Membros/colaboradores (companyMembers/company_members
  // mais abaixo) -- pedido do Douglas, 30/set (14), corrigindo a
  // primeira versão disso: "somente founders ninguem aqui falou
  // membros [...] a empresa nao divulga eles apenas os founders". É
  // dona + public.company_founders (ver migration 0046), o GET/POST
  // de app/api/room/company-profile já manda pronta em `founders`, só
  // quando esse toggle tá ligado (senão vem []).
  showFoundersOnCard: boolean;
  founders: { userId: string; name: string; photoUrl: string }[];
  // selo de verdade (pedido do Douglas, 30/set (2)) -- antes o ícone
  // verificado em .company-card-name era FIXO, sempre aparecia (ver
  // VerifiedBadge/uso mais abaixo). Vem de rooms.company_verified, só
  // liga com um pedido de "Selo de verificação > Empresa" aprovado pra
  // ESSE espaço (ver migration 0043_company_verification_per_room.sql
  // e app/api/account/verification/route.ts).
  verified: boolean;
};

// estado "em branco" -- usado enquanto o card de verdade ainda não
// chegou do servidor (fetch em andamento/sem espaço selecionado
// ainda) ou quando o espaço ainda não tem NENHUM campo preenchido
// (sala nova, ninguém abriu "Editar Empresa" ainda). Sem molde/dado
// inventado nenhum (era isso que "Empresa Exemplo" fazia antes) --
// os campos vazios aparecem em branco no card mesmo (ver JSX,
// placeholders nos inputs de edição cobrem esse caso).
const BLANK_COMPANY_PROFILE: CompanyProfile = {
  name: "",
  handle: "",
  tagline: "",
  bio: "",
  followers: 0,
  link: "",
  logoUrl: "",
  bannerUrl: "",
  category: [],
  showNameOnEmployeeProfiles: true,
  showFoundersOnCard: false,
  founders: [],
  verified: false,
};

// pedido do Douglas: "uma caixa de selecao, escrita Posicione a sua
// empresa:" + a lista de categorias exata que ele mandou.
const COMPANY_CATEGORIES = [
  "Direct Response",
  "Dropshipping",
  "E-commerce",
  "Disparos SMS",
  "E-mail Marketing",
  "Marketing Digital",
  "Agência de Marketing",
  "Agência de Publicidade",
  "Social Media",
  "Tráfego Pago",
  "Copywriting",
  "Infoprodutos",
  "Afiliados",
  "SaaS",
  "Software / Tecnologia",
  "Desenvolvimento de Software",
  "Desenvolvimento Web",
  "Desenvolvimento de Apps",
  "Inteligência Artificial",
  "Automação",
  "Telecomunicações",
  "Call Center",
  "BPO",
  "Empresas Remotas",
  "Consultoria",
  "Assessoria",
  "Contabilidade",
  "Jurídico",
  "Recursos Humanos",
  "Recrutamento",
  "Educação",
  "Cursos Online",
  "Saúde",
  "Estética e Beleza",
  "Fitness",
  "Alimentação",
  "Restaurantes",
  "Moda e Vestuário",
  "Varejo",
  "Atacado",
  "Distribuidora",
  "Importação e Exportação",
  "Logística",
  "Transportes",
  "Imobiliário",
  "Construção Civil",
  "Arquitetura",
  "Engenharia",
  "Serviços Financeiros",
  "Fintech",
  "Seguros",
  "Turismo",
  "Hotelaria",
  "Eventos",
  "Entretenimento",
  "Games",
  "Produtora Audiovisual",
  "Design",
  "Indústria",
  "Agronegócio",
  "Energia",
  "Serviços Profissionais",
  "Outros",
];

// "Cargo" de cada Membro -- pedido do Douglas, 30/set (16): "adicione
// essas opcoes de cargos dentro da sala pro founder rotular", lista
// exata que ele mandou. Sem validação contra essa lista no servidor
// (mesmo padrão de COMPANY_CATEGORIES acima -- lista fixa só do lado
// do cliente, ver comentário em app/api/room/company-members).
const CARGO_OPTIONS = [
  "Gestor de Tráfego Júnior",
  "Gestor de Tráfego Pleno",
  "Gestor de Tráfego Sênior",
  "Media Buyer Júnior",
  "Media Buyer Pleno",
  "Media Buyer Sênior",
  "Copywriter Júnior",
  "Copywriter Pleno",
  "Copywriter Sênior",
  "Editor de Vídeo Júnior",
  "Editor de Vídeo Pleno",
  "Editor de Vídeo Sênior",
  "Designer Júnior",
  "Designer Pleno",
  "Designer Sênior",
  "Creative Strategist Júnior",
  "Creative Strategist Pleno",
  "Creative Strategist Sênior",
  "Social Media Júnior",
  "Social Media Pleno",
  "Social Media Sênior",
  "Web Designer Júnior",
  "Web Designer Pleno",
  "Web Designer Sênior",
  "Desenvolvedor Front-end",
  "Desenvolvedor Back-end",
  "Desenvolvedor Full Stack",
  "Especialista em CRO",
  "Analista de CRO",
  "Analista de Dados",
  "Analista de Performance",
  "Especialista em Tracking",
  "Especialista em Automação",
  "Especialista em CRM",
  "E-mail Marketing Specialist",
  "Funil Builder",
  "Landing Page Builder",
  "VSL Producer",
  "Roteirista de VSL",
  "Head de Copy",
  "Head de Criação",
  "Head de Performance",
  "Head de Marketing",
  "Diretor de Marketing / CMO",
  "Diretor de Operações / COO",
  "Project Manager",
  "Product Manager",
  "Account Manager",
  "Customer Success",
  "Assistente Administrativo",
  "Financeiro",
  "RH / People",
  "Recrutador",
  "Founder",
];

// pedido do Douglas: 4 artes (gradientes) que ele subiu pra por de
// fundo dos "quadradinhos" de posicionamento -- e "faca sorteio
// aleatório" pra decidir qual arte vai em cada quadradinho. Sorteio
// ESTÁVEL (não Math.random() puro): cada categoria sempre cai na
// mesma arte (senão reembaralha a cada digitação/re-render, ficando
// piscando). O "aleatório" está em qual arte cada categoria pegou --
// isso sim foi sorteado (índice inicial abaixo), não numa ordem óbvia
// tipo "primeira categoria = primeira arte".
const COMPANY_POSITION_BACKGROUNDS = [
  "/assets/positions/position-bg-green.jpg",
  "/assets/positions/position-bg-purple.jpg",
  "/assets/positions/position-bg-red.jpg",
  "/assets/positions/position-bg-orange.jpg",
];

function companyPositionBackgroundFor(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return COMPANY_POSITION_BACKGROUNDS[hash % COMPANY_POSITION_BACKGROUNDS.length];
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
//
// 29/set: pedido do Douglas "1200x400 me parece grande demais pro
// tamanho do banner no card" -- 1200x400 (proporção 3:1) era bem mais
// largo/achatado que a faixa de verdade do card (.company-card-top,
// 290px de largura x 130px de altura mínima = proporção ~2.23:1).
// 580x260 é EXATAMENTE 2x esse tamanho real (retina), então
// recomendado/teto de compressão agora batem com o card de verdade.
function compressBannerPhotoToDataUrl(file: File, maxWidth = 580, maxHeight = 260): Promise<string> {
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

// mesma seta, apontando pro outro lado -- vira o ícone da setinha do
// card da Empresa quando a aba de edição já tá aberta (fecha em vez
// de abrir).
function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ícone de câmera -- pedido do Douglas: print de referência da aba de
// edição usa esse ícone (não um pincel) nos botões de trocar foto de
// perfil/banner. `size` opcional porque é usado em dois tamanhos: nos
// botõezinhos redondos de canto e no convite grande centralizado em
// cima do banner.
function CameraIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// MESMO ícone de "trocar foto" (profile-photo-edit) do editor de
// perfil dentro da sala em GameRoom.tsx -- copiado (não importada,
// mesmo motivo de sempre) pros botões de trocar logo/banner aqui.
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

// 29/set (12), pedido do Douglas: "QUERO O CHAT DE FORA IGUAL AO CHAT
// DE DENTRO, ATE NA POSICAO, IGUAL" -- copiados de ChatDrawer/
// ChatMessageRow em components/GameRoom.tsx (mesmo motivo do resto
// dos ícones dessa barra, ver comentário grande no topo do arquivo:
// esse componente não importa nada de GameRoom.tsx, que é gigante e
// só deveria carregar depois que a pessoa entra na sala).
function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.6" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
      <path d="M15.2 12.3A4.6 4.6 0 0 1 20.5 16.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 12 20 4l-6.5 16-3-6.5L4 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 29/set, pedido do Douglas: "nao ta igual ainda eu nao tenho opcao de
// criar nova conversa na aba da empresa" -- MESMO PlusIcon de
// components/GameRoom.tsx (botão "Nova conversa" no cabeçalho).
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// 29/set (13), pedido do Douglas: "quero a logo da empresa em que ele
// abriu o chat" -- MESMO CompanyIcon de components/GameRoom.tsx
// (fallback do .chat-conv-company-logo quando a empresa não tem
// company_logo_url ainda).
function CompanyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 20.5V4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16M14 20.5h5a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-5M8 8h2M8 11.5h2M8 15h2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
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

function CamIcon({ off, size = 19 }: { off: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
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

// formatCallWhen/pad2/localDateStr/localTimeStr/combineLocalDateTime
// saíram daqui (2/out) -- só existiam pro formulário REST do
// LobbyAgendaPanel (removido, ver comentário grande mais abaixo onde
// ele morava); o formulário de criar/editar compromisso agora é só o
// AgendaDrawer (components/AgendaDrawer.tsx), que já importa essas
// mesmas funções de GameRoom.tsx.

// pedido do Douglas: "faca uma previa da agenda conforme a foto
// enviada" -- print de referência com 3 cards (um por dia com
// compromisso), cada um com um "selo" de data (29 Set / Terça-feira)
// + a lista de eventos daquele dia. Formatação em pt-BR sem depender
// de toLocaleDateString({month:"short"}) pra não vir com ponto/"de"
// (ex: "29 de set."), que não bate com o print ("29 Set").
const AGENDA_MONTH_ABBR_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function formatAgendaDayBadge(ts: number): { day: string; month: string; weekday: string } {
  const d = new Date(ts);
  const weekdayRaw = d.toLocaleDateString("pt-BR", { weekday: "long" });
  return {
    day: String(d.getDate()).padStart(2, "0"),
    month: AGENDA_MONTH_ABBR_PT[d.getMonth()],
    weekday: weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1),
  };
}

function formatAgendaEventTime(startTs: number, durationMinutes: number): string {
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(new Date(startTs))} - ${fmt(new Date(startTs + durationMinutes * 60000))}`;
}

/** Painel de chat do Lobby -- lista de conversas -> clicar abre o
 * histórico + campo de resposta. Ver comentário grande no topo do
 * arquivo pra entender o porquê de tudo aqui ser REST (sem WebSocket,
 * sem virar presença fantasma na sala). */
// ---------------------------------------------------------------
// 1/out -- Douglas rejeitou a unificação "só de aparência" entre o
// chat de fora (aqui) e o de dentro (GameRoom.tsx): "nao tem que ter
// chat de fora chat de dentro, tem que ter CHAT ... pega o chat de
// dentro e transforma ele em CHAT que acompanha toda a plataforma".
// Esse painel PARA de ter qualquer estado/REST próprio (listar via
// GET /chat/summary, abrir via POST /chat/open, mandar via POST
// /chat/send, etc, tudo isso REMOVIDO) e passa a só DESENHAR o que o
// motor único (usePlatformChat, montado uma vez em app/page.tsx, ver
// comentário grande dele) já mantém -- é o MESMO hook, a MESMA
// conexão, os MESMOS dados que a sala usa, não uma cópia parecida.
// Sobra aqui só o que é genuinamente deste PAINEL (não do chat em si):
// visualizar perfil de quem apareceu numa conversa, e o input de
// arquivo escondido que aciona o anexo.
// ---------------------------------------------------------------
function LobbyChatPanel({
  pinMode,
  onToggleSidePin,
  myUserId,
  myRoomName,
  myRoomLogoUrl,
  accountAccessToken,
  callVolume,
  camOn,
  onClose,
  chat,
}: {
  pinMode: "float" | "side";
  onToggleSidePin: () => void;
  myUserId: string;
  myRoomName: string | null;
  myRoomLogoUrl: string | null;
  accountAccessToken?: string | null;
  callVolume: number;
  camOn: boolean;
  onClose: () => void;
  chat: PlatformChat;
}) {
  const [viewingProfileUserId, setViewingProfileUserId] = useState<string | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  // espelha "tô literalmente vendo essa conversa agora" pro motor
  // único (ver updateReadingState/readingConversationIdRef em
  // usePlatformChat.ts) -- MESMO conceito de readingConversationIdRef
  // em GameRoom.tsx, só que escrito de fora (o hook não sabe sozinho
  // se o painel que o usa tá mesmo visível na tela).
  useEffect(() => {
    chat.updateReadingState(chat.chatView === "thread");
    return () => chat.updateReadingState(false);
  }, [chat.chatView, chat.activeConversationId]);

  function handleChatFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    chat.sendChatAttachment(file, file.name, file.type.startsWith("image/") ? "image" : "file");
  }

  const activeId = chat.activeConversationId;
  const chatDrawerEl = (
    <ChatDrawer
      view={chat.chatView}
      onChangeView={chat.setChatView}
      conversations={chat.conversations}
      activeConversationId={activeId}
      onOpenConversation={chat.openConversation}
      messages={activeId === null ? [] : chat.messagesByConv[activeId] ?? []}
      unreadSinceTs={activeId === null ? null : chat.unreadSinceTsByConv[activeId] ?? null}
      // o Lobby não tem Sala/"quem ta por perto" nenhuma (ver hasRoom
      // abaixo) -- roomChatLog fica sempre vazio, nunca é lido de
      // verdade.
      roomChatLog={[]}
      hasRoom={false}
      myUserId={myUserId}
      onlinePlayers={[]}
      roomCompanyName={myRoomName}
      roomCompanyLogoUrl={myRoomLogoUrl}
      accountAccessToken={accountAccessToken}
      callVolume={callVolume}
      newConvMode={chat.newConvMode}
      onChangeNewConvMode={chat.changeNewConvMode}
      newConvSelection={chat.newConvSelection}
      onToggleNewConvSelection={chat.toggleNewConvSelection}
      newConvName={chat.newConvName}
      onChangeNewConvName={chat.setNewConvName}
      onSubmitNewConversation={chat.submitNewConversation}
      newConvFilter={chat.newConvFilter}
      onChangeNewConvFilter={chat.setNewConvFilter}
      newConvQuery={chat.newConvQuery}
      onChangeNewConvQuery={chat.setNewConvQuery}
      newConvSearchResults={chat.newConvSearchResults}
      newConvFriends={chat.newConvFriends}
      renamingGroup={chat.renamingGroup}
      onStartRenameGroup={(currentName: string) => {
        chat.setGroupNameDraft(currentName);
        chat.setRenamingGroup(true);
      }}
      onCancelRenameGroup={() => chat.setRenamingGroup(false)}
      groupNameDraft={chat.groupNameDraft}
      onChangeGroupNameDraft={chat.setGroupNameDraft}
      onSubmitRenameGroup={chat.submitRenameGroup}
      composerText={chat.composerText}
      onChangeComposerText={chat.setComposerText}
      onSendComposer={chat.onSendComposer}
      onPickFile={() => chatFileInputRef.current?.click()}
      sendingAttachment={chat.sendingAttachment}
      recordingAudio={chat.recordingAudio}
      recordingElapsedSec={chat.recordingElapsedSec}
      recordedPreview={chat.recordedPreview}
      onStartRecording={chat.startVoiceRecording}
      onStopRecording={chat.stopVoiceRecording}
      onCancelRecording={chat.cancelVoiceRecording}
      onDiscardRecordedAudio={chat.discardRecordedAudio}
      onSendRecordedAudio={chat.sendRecordedAudio}
      onDeleteMessage={chat.deleteMessage}
      onSendRoomCard={chat.sendRoomCard}
      onMoveConversationLane={chat.moveConversationLane}
      onMuteConversation={chat.muteConversation}
      onDeleteConversation={chat.deleteConversation}
      replyingTo={chat.replyingTo}
      onStartReply={chat.startReplyToMessage}
      onCancelReply={chat.cancelReply}
      callParticipantsByConversation={chat.callParticipantsByConversation}
      myCallConversationId={chat.myCallConversationId}
      callRemoteStreams={chat.callRemoteStreams}
      onJoinCall={chat.joinCall}
      onLeaveCall={chat.leaveCall}
      localStreamRef={chat.callLocalStreamRef}
      camOn={camOn}
      onClose={onClose}
      pinMode={pinMode}
      onToggleSidePin={onToggleSidePin}
      // "fixar" (pedido do Douglas, 1/out: "o layout do chat de fora
      // tem que ser igual ao de dentro") -- MESMOS números de
      // top/bottom do .chat-drawer-shell-sidebar da sala, só muda o
      // NOME da classe porque o Lobby não tem o layout flex com
      // align-items:stretch que a sala tem (ver comentário grande de
      // .lobby-chat-drawer-shell-sidebar em globals.css).
      sidebarClassName="lobby-chat-drawer-shell-sidebar"
      onOpenProfile={(playerId: string) => setViewingProfileUserId(playerId)}
      pins={activeId === null ? [] : chat.pinsByConv[activeId] ?? []}
      typingUsers={activeId ? chat.typingByConv[activeId] ?? [] : []}
      lastRead={activeId === null ? {} : chat.lastReadByConv[activeId] ?? {}}
      onToggleReaction={(messageId: string, emoji: string) => chat.toggleReaction(activeId, messageId, emoji)}
      onPinMessage={(messageId: string, durationMs: number | null) => chat.pinMessage(activeId, messageId, durationMs)}
      onUnpinMessage={(messageId: string) => chat.unpinMessage(activeId, messageId)}
      onTypingNotify={() => chat.sendTypingNotification(activeId)}
      filesPanelOpen={chat.filesPanelOpen}
      filesPanelItems={chat.filesPanelItems}
      filesPanelFilter={chat.filesPanelFilter}
      onChangeFilesPanelFilter={chat.setFilesPanelFilter}
      filesPanelQuery={chat.filesPanelQuery}
      onChangeFilesPanelQuery={chat.setFilesPanelQuery}
      onOpenFilesPanel={chat.openFilesPanel}
      onCloseFilesPanel={chat.closeFilesPanel}
      onMentionAttachmentInChat={chat.mentionAttachmentInChat}
      pendingMentionIds={chat.pendingMentionIds}
      onAddPendingMentionId={(userId: string) =>
        chat.setPendingMentionIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]))
      }
    />
  );

  return (
    <>
      {pinMode === "side" ? <div className="lobby-chat-pin-anchor">{chatDrawerEl}</div> : chatDrawerEl}
      <input ref={chatFileInputRef} type="file" style={{ display: "none" }} onChange={handleChatFileChange} />
      {viewingProfileUserId && accountAccessToken && (
        <ProfileViewCard
          userId={viewingProfileUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setViewingProfileUserId(null)}
          onStartConversation={(targetUserId) => {
            setViewingProfileUserId(null);
            chat.startDirectWith(targetUserId);
          }}
        />
      )}
    </>
  );
}

// LobbyAgendaPanel saiu daqui inteiro (2/out) -- era a reimplementação
// REST (POST /agenda/respond,create,update,delete em server/index.js)
// que existia só porque o Lobby não tinha como reusar o AgendaDrawer
// de dentro da sala (função local, não-exportada, ver GameRoom.tsx
// antes dessa mudança). Pedido do Douglas: "quero ela [a agenda] toda
// isolada tambem, e sistema unico, assim como o chat, funcionando
// acima de tudo, acima de lobby acima de jogo" -- agora é o MESMO
// AgendaDrawer (components/AgendaDrawer.tsx), alimentado pelo MESMO
// estado do motor único (chat.calls/chat.agendaOpen/etc, ver
// usePlatformChat.ts), renderizado uma única vez acima de Lobby E
// GameRoom (ver PlatformAgendaHost em app/page.tsx) -- sem gaveta
// paralela nenhuma aqui.


export default function Lobby({
  accountUserId,
  accountProfile,
  accountAccessToken,
  onEnter,
  onSignOut,
  platformChat,
}: {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken?: string | null;
  onEnter: (roomSlug: string) => void;
  onSignOut: (() => void) | null;
  // motor único de chat (ver comentário grande em
  // usePlatformChat.ts) -- montado uma vez em app/page.tsx (Home()),
  // repassado aqui já pronto; esse componente NUNCA cria a própria
  // conexão/estado de chat.
  platformChat: PlatformChat;
}) {
  const chat = platformChat;
  const [presence, setPresence] = useState<PresenceInfo>(null);
  // papel na sala do Douglas (ver comentário grande "teamOnly" em
  // ROOM_SLUGS acima) -- MESMA fonte que GameRoom.tsx já usa pra
  // canEditRoom (GET /api/room/members com o access token, ver efeito
  // logo abaixo), só que buscado aqui no Lobby (ANTES de entrar em
  // sala nenhuma) porque é o que decide quais itens de "Meus espaços"
  // aparecem. Começa "visitor" de propósito (esconde "Sala principal"
  // até confirmar owner/member, nunca o contrário -- evita um flash do
  // botão aparecendo e sumindo pra quem não devia ver).
  const [roomRole, setRoomRole] = useState<"owner" | "member" | "visitor">("visitor");
  const [roomRoleLoading, setRoomRoleLoading] = useState(true);
  // "Sala principal"/"Mapa modelo" são do TIME do Douglas -- só ele
  // (owner) e quem ele convidou (member, ver comentário grande
  // "teamOnly" acima) enxergam eles em "Meus espaços". Um "visitor"
  // (cliente qualquer) nunca vê nenhum dos dois.
  const canSeeSalaPrincipal = roomRole === "owner" || roomRole === "member";
  // a sala PRÓPRIA do cliente (ver MyRoom acima/fetch de
  // /api/room/mine mais abaixo) -- null enquanto ele ainda não criou
  // uma (ver "Criar minha sala" mais abaixo).
  const [myRoom, setMyRoom] = useState<MyRoom | null>(null);
  const [myRoomLoading, setMyRoomLoading] = useState(true);
  // catálogo de modelos publicados (GET /api/room/templates) -- pra
  // tela de "Criar minha sala" escolher um. Busca sempre (é público,
  // barato), só é USADO quando needsToCreateRoom abaixo é true.
  const [templates, setTemplates] = useState<RoomTemplate[] | null>(null);
  // id do template sendo clonado agora (POST
  // /api/room/create-from-template em andamento) -- desabilita os
  // cards enquanto isso, evita clique duplo criando 2 salas.
  const [creatingFromTemplateId, setCreatingFromTemplateId] = useState<string | null>(null);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);
  // 30/set, Douglas refinou o pedido acima duas vezes: primeiro
  // "entao quando ele clica em criar novo espaco, crie uma nova tela
  // dessa com o card ali em branco, ele tendo que adicionar PRIMEIRO o
  // nome da empresa ali, e so depois criar o espaco" (só o nome, ver
  // "estou falando desse card"), depois "o card da empresa criando
  // novo espaco nao tem o negocio de edicao, na vdd, na criacao, deixa
  // ele aberto ja" -- então agora é o companyProfile/setCompanyProfile
  // de VERDADE (mesmo estado que a edição normal usa) que vira o
  // rascunho, com o PAINEL DE EDIÇÃO inteiro (banner/logo/nome/handle/
  // bio/link/categorias) já aberto, sem precisar da setinha -- ver
  // .company-edit-panel mais abaixo. Só confirma o passo (revela o
  // catálogo de modelos) depois que o nome tiver algo digitado.
  const [newRoomNameConfirmed, setNewRoomNameConfirmed] = useState(false);
  // "Espaços visitados" (pedido do Douglas, 29/set: "se eu entrar na
  // sala de um amigo, a sala dele vai ficar ali, como um link rapido")
  // -- salas de OUTRAS pessoas que essa conta já visitou por link (ver
  // POST /api/room/visit), mais recente primeiro (ver GET
  // /api/room/visits, efeito mais abaixo). visitSlug vem de
  // ?visitar=<slug> na URL, lido direto de window.location (não
  // useSearchParams, pra não precisar de Suspense boundary só por
  // causa disso, ver efeito logo abaixo) -- é o "link de convite" que
  // o dono de uma sala copia (ver handleCopyRoomLink mais abaixo) e
  // manda pra quem quiser, sem precisar gerar código nenhum.
  const [visitedRooms, setVisitedRooms] = useState<VisitedRoom[] | null>(null);
  const [visitedMenuOpen, setVisitedMenuOpen] = useState(false);
  const [visitSlug, setVisitSlug] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // "Página principal" -- pedido do Douglas, 30/set (20): "o cara nao
  // cai no lobby direto, ele vai cair na pagina principal / mesma
  // coisa de navegacao ali, que ela e o inicio, vai ser clicando na
  // logo cai nela, la vai ter a agenda dele tambem, mas por enquanto
  // somente isso / mantenha todos os baloes de navegacao, tanto de
  // baixo quanto de cima, e so mais uma pagina ali dentro mesmo" --
  // NÃO é uma rota nova (o "ali dentro" é literal: mesmo <Lobby/>,
  // mesmo topbar/av-bar de sempre, só troca o que aparece no meio).
  // "home" = só a agenda (.lobby-agenda-preview, que morava junto do
  // card da empresa antes, ver mais abaixo); "spaces" = o dashboard de
  // sempre (card da empresa + Entrar na sala, ver .lobby-company-card-
  // pin/.lobby-card). Logo = volta pra "home" (ver lobby-topbar-logo
  // mais abaixo); clicar em "Meus espaços"/"Espaços visitados" (aba ou
  // item do dropdown) leva pra "spaces". Chega em "home" por padrão --
  // EXCETO quando tem um link de convite (?visitar=, ver visitSlug
  // acima/efeito logo abaixo): aí vai direto pra "spaces" pra mostrar
  // a sala do convite (senão a correção do bug de convite virando
  // "criar espaço" de nada adiantaria).
  const [lobbyView, setLobbyView] = useState<"home" | "spaces">("home");
  useEffect(() => {
    if (visitSlug) setLobbyView("spaces");
  }, [visitSlug]);
  // pedido do Douglas, 30/set (20): "quando ja entrou antes, seja bem
  // vindo de volta" -- não existe "primeiro login" registrado em
  // lugar nenhum no backend (accountProfile não tem createdAt, ver
  // AuthGate.tsx), então marca por localStorage mesmo, POR CONTA
  // (accountUserId na chave -- se alguém trocar de conta no mesmo
  // navegador não herda o "já visitei" de outra pessoa). Lê e já
  // marca como visto na mesma passada -- só reflete "visitou antes"
  // de verdade a partir da SEGUNDA vez que esse accountUserId entra
  // aqui.
  const [returningVisitor, setReturningVisitor] = useState(false);
  useEffect(() => {
    if (!accountUserId || typeof window === "undefined") return;
    const key = `xtower_visited_home_${accountUserId}`;
    try {
      setReturningVisitor(window.localStorage.getItem(key) === "1");
      window.localStorage.setItem(key, "1");
    } catch {
      // localStorage pode falhar (modo privado/quota) -- sem isso só
      // perde o "de volta", não quebra a saudação.
    }
  }, [accountUserId]);
  // qual espaço tá selecionado em "Meus espaços" agora (ver dropdown
  // mais abaixo/ROOM_SLUGS acima) -- vazio até confirmar algo válido
  // (nunca cai em "mapa-modelo"/"mapa-publicado" por padrão pra quem
  // pode não ter acesso a nenhum dos dois, ver efeitos logo abaixo).
  // Vira "mapa-publicado" sozinho pro time do Douglas, ou o slug da
  // MyRoom sozinho pra quem já tem sala própria -- mas só DEPOIS de
  // confirmar (nunca busca/mostra o preview de uma sala que a pessoa
  // não devia ver, nem por um instante).
  const [selectedRoomSlug, setSelectedRoomSlug] = useState<string>("");
  // true assim que a pessoa mexe no dropdown à mão -- trava os efeitos
  // de auto-seleção acima de rodar de novo depois e atropelar uma
  // escolha manual.
  const userPickedRoomRef = useRef(false);
  const [room, setRoom] = useState<RoomShape>(null);
  const [roomLoading, setRoomLoading] = useState(true);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  // "fixar" o chat de fora da sala também na lateral (pedido do
  // Douglas, 1/out: "fixar fora da sala também") -- mesma ideia do
  // chatPinMode em GameRoom.tsx (ver comentário grande dele lá), mas
  // com chave de localStorage PRÓPRIA (o Lobby e a sala são telas
  // diferentes, a pessoa pode querer fixado numa e flutuando na
  // outra) e sem depender de layout flex com align-items:stretch
  // (que o Lobby não tem, ver .lobby-backdrop -- quase tudo aqui é
  // position:fixed solto, não um canvas+painel lado a lado como na
  // sala) -- por isso aqui vira position:fixed com top/bottom
  // próprios em vez de esticar via flex, ver .lobby-chat-drawer-shell-sidebar
  // em globals.css.
  const [chatPinMode, setChatPinMode] = useState<"float" | "side">(() => {
    if (typeof window === "undefined") return "float";
    try {
      return window.localStorage.getItem(LOBBY_CHAT_PINNED_STORAGE_KEY) === "side" ? "side" : "float";
    } catch {
      return "float";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(LOBBY_CHAT_PINNED_STORAGE_KEY, chatPinMode);
    } catch {
      // sem localStorage (modo privado etc.) -- só não lembra da próxima vez
    }
  }, [chatPinMode]);
  function toggleLobbyChatPinSide() {
    setChatPinMode((m) => (m === "side" ? "float" : "side"));
  }
  // Contatos (28/set, pedido do Douglas: "quero agora, mais um icone
  // de contatos") -- diretório platform-wide via GET /users/directory
  // (mesma fonte de chatStore.listAllUsers que o WS manda como
  // "users:list" de dentro da sala, ver comentário grande em
  // ContactsPanel.tsx). Abrir já na conversa certa ao clicar
  // "Conversar" agora é o motor único quem decide sozinho (ver
  // autoOpenNextConversationRef/startDirectWith em
  // usePlatformChat.ts) -- não precisa de ponte nenhuma daqui.
  const [directory, setDirectory] = useState<ContactUser[] | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);

  // Barra de topo (28/set, pedido do Douglas com print de referência
  // do site da Pepsi -- só a DIAGRAMAÇÃO, canto superior esquerdo:
  // logo à esquerda, abas na mesma linha) -- "Meus espaços" é a
  // primeira aba, com setinha seletora: hoje só existe UMA sala no
  // ambiente todo (STORE_SLUG "mapa-publicado", ver server/chatStore.js
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


  // card da Empresa selecionada -- pedido do Douglas (29/set (7)):
  // "quero cada card de empresa atrelado a um espaco". Busca o card
  // de VERDADE (GET /api/room/company-profile?slug=...) do espaço
  // atualmente SELECIONADO (mesmo selectedRoomSlug de "Meus
  // espaços"/"Espaços visitados" -- ver dropdown mais abaixo/mais
  // acima) -- troca de espaço selecionado busca outro card, cada um
  // com seus próprios dados (ver migration
  // 0040_room_company_profile.sql/rota, comentário grande no topo do
  // arquivo sobre CompanyProfile). companyProfileCanEdit vem do
  // servidor (é dono de verdade daquele espaço ou não) -- controla se
  // a setinha de editar aparece (ver JSX mais abaixo).
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(BLANK_COMPANY_PROFILE);
  const [companyProfileCanEdit, setCompanyProfileCanEdit] = useState(false);
  const [companyProfileLoading, setCompanyProfileLoading] = useState(false);
  const [companyEditOpen, setCompanyEditOpen] = useState(false);
  const [companySaving, setCompanySaving] = useState(false);
  const [companySaveError, setCompanySaveError] = useState<string | null>(null);
  // clicar na foto de um founder no card (ver companyProfile.founders
  // acima) abre o perfil pessoal dele -- pedido do Douglas, 30/set
  // (13): "com link clicavel pro perfil pessoal". Estado próprio
  // (diferente do viewingProfileUserId de LobbyChatPanel, que é outro
  // componente/closure -- esse aqui é escopo do Lobby principal, onde
  // o card da empresa vive).
  const [viewingFounderUserId, setViewingFounderUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRoomSlug) {
      setCompanyProfile(BLANK_COMPANY_PROFILE);
      setCompanyProfileCanEdit(false);
      return;
    }
    let cancelled = false;
    setCompanyProfileLoading(true);
    setCompanyEditOpen(false); // troca de espaço fecha a edição do card anterior
    const headers: Record<string, string> = {};
    if (accountAccessToken) headers.Authorization = `Bearer ${accountAccessToken}`;
    fetch(`/api/room/company-profile?slug=${encodeURIComponent(selectedRoomSlug)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.profile) {
          setCompanyProfile(data.profile);
          setCompanyProfileCanEdit(!!data.canEdit);
        } else {
          setCompanyProfile(BLANK_COMPANY_PROFILE);
          setCompanyProfileCanEdit(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCompanyProfile(BLANK_COMPANY_PROFILE);
          setCompanyProfileCanEdit(false);
        }
      })
      .finally(() => {
        if (!cancelled) setCompanyProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomSlug, accountAccessToken]);

  // "Salvar alterações" agora salva DE VERDADE (POST, ver rota) --
  // antes (quando isso era só localStorage) o botão só fechava o
  // painel, porque os campos já aplicavam ao vivo em memória. Chamado
  // pelo botão de salvar lá embaixo.
  async function saveCompanyProfile() {
    if (!selectedRoomSlug || !accountAccessToken || companySaving) return;
    setCompanySaving(true);
    setCompanySaveError(null);
    try {
      const res = await fetch("/api/room/company-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, ...companyProfile }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setCompanySaveError(data?.error || "não deu pra salvar, tenta de novo");
        return;
      }
      if (data?.profile) setCompanyProfile(data.profile);
      setCompanyEditOpen(false);
    } catch {
      setCompanySaveError("rede caiu no meio, tenta de novo");
    } finally {
      setCompanySaving(false);
    }
  }

  // dropdown de "Posicione a sua empresa:" -- Douglas pediu multi-seleção
  // ("deixei marcar varias opcoes"), então é um checklist dentro de um
  // dropdown, não um <select> nativo (que só permite uma opção por vez).
  const [companyCategoryOpen, setCompanyCategoryOpen] = useState(false);
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

  function toggleCompanyCategory(cat: string) {
    setCompanyProfile((prev) => {
      const already = prev.category.includes(cat);
      return {
        ...prev,
        category: already ? prev.category.filter((c) => c !== cat) : [...prev.category, cat],
      };
    });
  }

  // Membros (colaboradores) da empresa -- pedido do Douglas, 30/set
  // (8): "as empresas que a pessoa é dona/membro vao aparecer no
  // perfil dela". Perguntado como alguém vira membro de UMA empresa
  // específica (convite por link "acaba indo pra visitantes também"),
  // escolheu: "a pessoa tem que ser adicionada como membro por quem
  // tem direitos na sala" -- então é só o DONO desse espaço quem
  // adiciona/remove (mesma trava de app/api/room/company-members, ver
  // rota). Lista carregada só quando o painel de edição abre (não em
  // toda visita à sala) -- ver useEffect logo abaixo.
  const [companyMembers, setCompanyMembers] = useState<
    { userId: string; name: string; photoUrl: string; cargo: string }[] | null
  >(null);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [memberBusyUserId, setMemberBusyUserId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyEditOpen || !selectedRoomSlug || !accountAccessToken) return;
    let cancelled = false;
    fetch(`/api/room/company-members?slug=${encodeURIComponent(selectedRoomSlug)}`, {
      headers: { Authorization: `Bearer ${accountAccessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCompanyMembers(Array.isArray(data?.members) ? data.members : []);
      })
      .catch(() => {
        if (!cancelled) setCompanyMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyEditOpen, selectedRoomSlug, accountAccessToken]);

  async function addCompanyMember(targetUserId: string) {
    if (!selectedRoomSlug || !accountAccessToken || memberBusyUserId) return;
    setMemberBusyUserId(targetUserId);
    setMemberError(null);
    try {
      const res = await fetch("/api/room/company-members", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, targetUserId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMemberError(data?.error || "não deu pra adicionar, tenta de novo");
        return;
      }
      const added = directory?.find((u) => u.userId === targetUserId);
      setCompanyMembers((prev) => [
        ...(prev ?? []),
        { userId: targetUserId, name: added?.name || "", photoUrl: "", cargo: "" },
      ]);
      setMemberPickerOpen(false);
    } catch {
      setMemberError("rede caiu no meio, tenta de novo");
    } finally {
      setMemberBusyUserId(null);
    }
  }

  // "Cargo" (pedido do Douglas, 30/set (16)) -- MESMA rota de
  // adicionar/remover (POST /api/room/company-members), só que com
  // `cargo` no corpo (ver comentário grande na rota sobre upsert só
  // tocar as colunas presentes no payload). Atualiza local igual às
  // outras funções aqui -- sem recarregar a lista inteira.
  async function updateMemberCargo(targetUserId: string, cargo: string) {
    if (!selectedRoomSlug || !accountAccessToken) return;
    setMemberError(null);
    // otimista: o <select> já reflete a escolha na hora, sem esperar
    // o servidor confirmar (mesmo padrão de outros campos de
    // formulário no app) -- só desfaz se a chamada falhar de verdade.
    setCompanyMembers((prev) => (prev ?? []).map((m) => (m.userId === targetUserId ? { ...m, cargo } : m)));
    try {
      const res = await fetch("/api/room/company-members", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, targetUserId, cargo }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMemberError(data?.error || "não deu pra salvar o cargo, tenta de novo");
      }
    } catch {
      setMemberError("rede caiu no meio, tenta de novo");
    }
  }

  async function removeCompanyMember(targetUserId: string) {
    if (!selectedRoomSlug || !accountAccessToken || memberBusyUserId) return;
    setMemberBusyUserId(targetUserId);
    setMemberError(null);
    try {
      const res = await fetch("/api/room/company-members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, targetUserId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMemberError(data?.error || "não deu pra remover, tenta de novo");
        return;
      }
      setCompanyMembers((prev) => (prev ?? []).filter((m) => m.userId !== targetUserId));
    } catch {
      setMemberError("rede caiu no meio, tenta de novo");
    } finally {
      setMemberBusyUserId(null);
    }
  }

  // Founders -- pedido do Douglas, 30/set (14), corrigindo o que eu
  // tinha feito antes (mostrar os Membros/colaboradores no card
  // público): "somente founders ninguem aqui falou membros / os
  // membros podem adicionar o card da empresa no perfil deles se
  // quiserem, mas a empresa nao divulga eles apenas os founders".
  // Roster À PARTE de companyMembers acima -- mesmo padrão (só o dono
  // adiciona/remove, direto, sem convite), tabela e rota diferentes
  // (public.company_founders, ver migration 0046 e
  // app/api/room/company-founders/route.ts).
  const [companyFounders, setCompanyFounders] = useState<{ userId: string; name: string; photoUrl: string }[] | null>(null);
  const [founderPickerOpen, setFounderPickerOpen] = useState(false);
  const [founderBusyUserId, setFounderBusyUserId] = useState<string | null>(null);
  const [founderError, setFounderError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyEditOpen || !selectedRoomSlug || !accountAccessToken) return;
    let cancelled = false;
    fetch(`/api/room/company-founders?slug=${encodeURIComponent(selectedRoomSlug)}`, {
      headers: { Authorization: `Bearer ${accountAccessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCompanyFounders(Array.isArray(data?.founders) ? data.founders : []);
      })
      .catch(() => {
        if (!cancelled) setCompanyFounders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyEditOpen, selectedRoomSlug, accountAccessToken]);

  async function addCompanyFounder(targetUserId: string) {
    if (!selectedRoomSlug || !accountAccessToken || founderBusyUserId) return;
    setFounderBusyUserId(targetUserId);
    setFounderError(null);
    try {
      const res = await fetch("/api/room/company-founders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, targetUserId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFounderError(data?.error || "não deu pra adicionar, tenta de novo");
        return;
      }
      const added = directory?.find((u) => u.userId === targetUserId);
      setCompanyFounders((prev) => [...(prev ?? []), { userId: targetUserId, name: added?.name || "", photoUrl: "" }]);
      setFounderPickerOpen(false);
    } catch {
      setFounderError("rede caiu no meio, tenta de novo");
    } finally {
      setFounderBusyUserId(null);
    }
  }

  async function removeCompanyFounder(targetUserId: string) {
    if (!selectedRoomSlug || !accountAccessToken || founderBusyUserId) return;
    setFounderBusyUserId(targetUserId);
    setFounderError(null);
    try {
      const res = await fetch("/api/room/company-founders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, targetUserId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFounderError(data?.error || "não deu pra remover, tenta de novo");
        return;
      }
      setCompanyFounders((prev) => (prev ?? []).filter((m) => m.userId !== targetUserId));
    } catch {
      setFounderError("rede caiu no meio, tenta de novo");
    } finally {
      setFounderBusyUserId(null);
    }
  }

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
  // pedido do Douglas, 30/set (5): "Volume do espaco, deixe ele
  // alterar mesmo fora de um [espaço], pra que quando entre ja esteja
  // no volume certo" -- até aqui o slider daqui do Lobby era decoração
  // pura (spaceVolume={1} fixo, onChangeSpaceVolume={() => {}} não
  // fazia nada, ver git blame). Agora lê/escreve a MESMA preferência
  // persistida que GameRoom.tsx usa (ver lib/settingsPrefs.ts) -- sem
  // ninguém por perto pra ouvir de verdade aqui fora, mas o valor
  // ajustado aqui já vale assim que entrar numa sala. callVolume/
  // notificationPrefs mesma ideia.
  const [spaceVolume, setSpaceVolumeState] = useState(() => getStoredVolume(SPACE_VOLUME_STORAGE_KEY));
  const [callVolume, setCallVolumeState] = useState(() => getStoredVolume(CALL_VOLUME_STORAGE_KEY));
  const [notificationPrefs, setNotificationPrefsState] = useState<NotificationPrefs>(() => getStoredNotificationPrefs());
  function setSpaceVolume(volume: number) {
    setSpaceVolumeState(volume);
    setStoredVolume(SPACE_VOLUME_STORAGE_KEY, volume);
  }
  function setCallVolume(volume: number) {
    setCallVolumeState(volume);
    setStoredVolume(CALL_VOLUME_STORAGE_KEY, volume);
  }
  function setNotificationPrefs(prefs: NotificationPrefs) {
    setNotificationPrefsState(prefs);
    setStoredNotificationPrefs(prefs);
  }
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
    // mesmo botão também controla o mic de uma chamada de chat em
    // andamento (pedido do Douglas, 1/out) -- sem isso, mutar aqui
    // durante uma chamada não faria nada pro outro lado ouvir. A
    // track de verdade agora mora no motor único (ver
    // callLocalStreamRef em usePlatformChat.ts) -- esse botão só liga/
    // desliga, nunca é dono dela.
    chat.callLocalStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !micOn));
    setMicOn((v) => {
      setStoredMicOn(!v);
      return !v;
    });
  }

  function toggleCam() {
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !camOn));
    // mesmo motivo do toggleMic acima -- liga/desliga a câmera de uma
    // chamada em andamento também; a track já existe (joinCall sempre
    // pede vídeo junto, só com enabled=false se camOn começou desligado,
    // ver comentário grande de joinCall em usePlatformChat.ts), então
    // não precisa renegociar nada com o outro lado, só ligar/desligar
    // a track.
    chat.callLocalStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !camOn));
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
    // defesa a mais (o botão já fica disabled sem seleção, ver JSX
    // mais abaixo) -- nunca entra em sala nenhuma sem slug de verdade.
    if (!selectedRoomSlug) return;
    // solta a câmera/mic do Lobby ANTES de entrar -- o GameRoom pede a
    // dele própria (ver requestMedia lá), sem isso os dois ficariam
    // segurando o mesmo dispositivo ao mesmo tempo por um instante.
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    onEnter(selectedRoomSlug);
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

  // ?visitar=<room_slug> na URL (ver comentário grande de visitSlug
  // acima) -- lido direto de window.location em vez de useSearchParams
  // de propósito: só client-side (roda uma vez ao montar, igual todo
  // outro fetch aqui), sem exigir Suspense boundary em app/page.tsx só
  // por causa de um parâmetro que a imensa maioria das visitas ao
  // Lobby nem tem.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("visitar");
    if (v && v.trim()) setVisitSlug(v.trim());
  }, []);

  // refaz a busca do "mapinha" toda vez que a seleção em "Meus espaços"
  // muda (ver selectedRoomSlug acima) -- cada slug tem seu PRÓPRIO piso/
  // parede/mobília agora (ver comentário grande "MULTI-SALA" em
  // server/roomStore.js), então o preview precisa mandar "?room=" igual
  // GameRoom.tsx faz (ver roomApiPath lá), senão mostraria sempre o
  // preview da sala padrão mesmo com outra selecionada. selectedRoomSlug
  // vazio (ainda confirmando acesso, ver efeitos de roomRole/myRoom
  // abaixo, ou cliente sem sala nenhuma ainda) -- não busca NADA, pra
  // nunca vazar sequer o preview de uma sala que a pessoa não devia ver.
  useEffect(() => {
    if (!selectedRoomSlug) {
      setRoom(null);
      setRoomLoading(false);
      return;
    }
    let cancelled = false;
    setRoomLoading(true);
    const qs = `?room=${encodeURIComponent(selectedRoomSlug)}`;
    Promise.all([
      fetch(`${REALTIME_HTTP_BASE}/room/floor${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/walls${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/furniture${qs}`).then((r) => (r.ok ? r.json() : null)),
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
  }, [selectedRoomSlug]);

  // confere o papel na sala do Douglas (ver comentário grande "teamOnly"
  // em ROOM_SLUGS/roomRole acima) -- mesma rota que GameRoom.tsx usa pra
  // canEditRoom (GET /api/room/members), só que chamada aqui no Lobby.
  // Sem token (visitante sem conta, ou conta ainda carregando), fica
  // "visitor" na hora (nada pra esperar).
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setRoomRole("visitor");
      setRoomRoleLoading(false);
      return;
    }
    fetch("/api/room/members", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const role: "owner" | "member" | "visitor" =
          data?.role === "owner" || data?.role === "member" ? data.role : "visitor";
        setRoomRole(role);
        // owner/member (time do Douglas, convidado por link, ver
        // comentário grande "teamOnly" acima) cai direto na Sala
        // principal por padrão (comportamento de sempre), a menos que já
        // tenha escolhido algo no dropdown à mão.
        if (role !== "visitor" && !userPickedRoomRef.current) setSelectedRoomSlug("mapa-publicado");
      })
      .catch(() => {
        if (!cancelled) setRoomRole("visitor");
      })
      .finally(() => {
        if (!cancelled) setRoomRoleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // busca a sala PRÓPRIA do cliente (ver MyRoom/GET /api/room/mine
  // acima) -- sem token, nunca tem (precisa de conta, ver
  // owner_user_id em public.rooms). Pro Douglas essa rota já devolve a
  // própria Sala principal (ver comentário em app/api/room/mine),
  // então esse efeito cai direto pra ela também, sem precisar de
  // tratamento especial aqui.
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setMyRoom(null);
      setMyRoomLoading(false);
      return;
    }
    fetch("/api/room/mine", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const found: MyRoom | null =
          data?.room && typeof data.room.room_slug === "string" && typeof data.room.id === "string"
            ? { id: data.room.id, name: String(data.room.name ?? "Minha sala"), room_slug: data.room.room_slug }
            : null;
        setMyRoom(found);
        if (found && !userPickedRoomRef.current) setSelectedRoomSlug(found.room_slug);
      })
      .catch(() => {
        if (!cancelled) setMyRoom(null);
      })
      .finally(() => {
        if (!cancelled) setMyRoomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // busca a lista de "Espaços visitados" (GET /api/room/visits, ver
  // VisitedRoom acima) -- sem token, ninguém tem histórico nenhum
  // (precisa de conta, ver room_visits.user_id).
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setVisitedRooms(null);
      return;
    }
    fetch("/api/room/visits", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setVisitedRooms(Array.isArray(data?.visits) ? data.visits : []);
      })
      .catch(() => {
        if (!cancelled) setVisitedRooms([]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // resolve o ?visitar=<slug> lido acima (ver efeito de visitSlug) --
  // POST /api/room/visit confere se é uma sala de CLIENTE de verdade
  // (recusa mapa-publicado/mapa-modelo e slugs inventados, ver
  // comentário grande na rota) e só DEPOIS de confirmado é que
  // selectedRoomSlug muda -- nunca confia direto no que veio da URL.
  // Precisa de conta (sem token não tem como registrar a visita nem
  // saber se a sala existe de verdade).
  useEffect(() => {
    if (!visitSlug || !accountAccessToken) return;
    let cancelled = false;
    fetch("/api/room/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
      body: JSON.stringify({ roomSlug: visitSlug }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || typeof data?.room?.room_slug !== "string") return;
        userPickedRoomRef.current = true;
        setSelectedRoomSlug(data.room.room_slug);
        // já bota o atalho na lista na hora, sem esperar reabrir o
        // Lobby de novo pra ele aparecer em "Espaços visitados"
        // (ownRoom: é a sala de quem tá pedindo, não é "visita" --
        // não deve entrar na lista).
        if (!data.ownRoom) {
          const visited: VisitedRoom = { id: data.room.id, name: String(data.room.name ?? "Sala"), room_slug: data.room.room_slug };
          setVisitedRooms((prev) => [visited, ...(prev ?? []).filter((r) => r.id !== visited.id)]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visitSlug, accountAccessToken]);

  // catálogo de modelos publicados (GET /api/room/templates, ver
  // RoomTemplate acima) -- público/barato, busca sempre; só é
  // renderizado de fato quando needsToCreateRoom abaixo é true.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/room/templates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setTemplates(Array.isArray(data?.templates) ? data.templates : []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Copia um modelo publicado pra virar a sala PRÓPRIA do cliente (ver
   * comentário grande em app/api/room/create-from-template/route.ts) --
   * pedido do Douglas: "as pessoas so copiam a sala modelo, pra eles,
   * ai se cria o mapa pra eles vinculado ao id deles". */
  async function handleCreateRoomFromTemplate(templateId: string) {
    if (!accountAccessToken || creatingFromTemplateId || !companyProfile.name.trim()) return;
    setCreatingFromTemplateId(templateId);
    setCreateRoomError(null);
    try {
      const res = await fetch("/api/room/create-from-template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        // nome digitado no card em branco/painel de edição aberto (ver
        // companyProfile virando o rascunho, comentário grande mais
        // acima) -- vira rooms.name direto na criação.
        body: JSON.stringify({ templateId, companyName: companyProfile.name.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.room?.room_slug !== "string") {
        setCreateRoomError(typeof data?.error === "string" ? data.error : "Não deu pra criar sua sala agora.");
        return;
      }
      const created: MyRoom = { id: data.room.id, name: String(data.room.name ?? "Minha sala"), room_slug: data.room.room_slug };
      // 30/set, pedido do Douglas ("deixa ele aberto ja"): o painel de
      // edição já tava aberto ANTES da sala existir, então além do
      // nome (que create-from-template já grava em rooms.name), o
      // resto (banner/logo/handle/bio/link/categorias) que a pessoa
      // preencheu no rascunho precisa de um POST /api/room/company-
      // profile separado agora que a sala (e o slug) já existe --
      // melhor esforço: se falhar, a sala já foi criada mesmo assim
      // (não bloqueia o fluxo, a pessoa edita nesses campos depois
      // pela setinha normal).
      fetch("/api/room/company-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: created.room_slug, ...companyProfile }),
      }).catch(() => {});
      setMyRoom(created);
      setCreatingSpaceFromDropdown(false);
      userPickedRoomRef.current = true;
      setSelectedRoomSlug(created.room_slug);
      setNewRoomNameConfirmed(false);
    } catch {
      setCreateRoomError("Não deu pra criar sua sala agora.");
    } finally {
      setCreatingFromTemplateId(null);
    }
  }

  /** Copia pra área de transferência o link que qualquer conta pode
   * abrir pra visitar a sala PRÓPRIA de quem tá logado agora (ver POST
   * /api/room/visit / comentário grande de visitSlug lá em cima) --
   * pedido do Douglas: "se eu entrar na sala de um amigo, a sala dele
   * vai ficar ali, como um link rapido". Só existe botão pra isso
   * quando a sala selecionada É a própria (myRoom) -- ver JSX mais
   * abaixo -- não faz sentido "convidar" pra Sala Principal/Mapa
   * Modelo por aqui (ver RESERVED_SLUGS na rota, que recusaria mesmo
   * assim). */
  async function handleCopyRoomLink() {
    if (!myRoom || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}?visitar=${encodeURIComponent(myRoom.room_slug)}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // clipboard bloqueado (permissão do navegador, http sem TLS,
      // etc.) -- sem fallback silencioso melhor que isso hoje; a
      // pessoa pode selecionar o link manualmente se precisar.
    }
  }

  // itens do TIME do Douglas realmente mostrados no dropdown "Meus
  // espaços" (ver comentário grande "teamOnly" em ROOM_SLUGS acima) --
  // quem não é do time (owner/member) não vê nenhum dos dois.
  const visibleRoomSlugs = ROOM_SLUGS.filter((r) => !r.teamOnly || canSeeSalaPrincipal);
  // + a sala PRÓPRIA do cliente, se tiver uma (myRoom) -- exceto pro
  // Douglas, cuja "mine" já É a Sala principal (ver comentário em
  // app/api/room/mine/route.ts) -- sem esse "except" ela apareceria
  // duplicada no dropdown dele.
  //
  // 29/set (5), Douglas: "inclusive lá em meus espaços deve aparecer
  // o nome da empresa" -- já é o caso aqui: label vem de myRoom.name,
  // que é rooms.name direto do banco (ver GET /api/room/mine acima) --
  // e rooms.name agora É o nome da empresa que a pessoa digitou antes
  // de criar a sala (ver companyName em
  // app/api/room/create-from-template/route.ts), não mais o nome
  // auto-gerado de antes ("Sala de {profile.name}"). Nada pra mudar
  // aqui, só documentando que o pedido já fica resolvido por
  // consequência dessa mudança.
  // 29/set (14), pedido do Douglas ("cade a opcao de criar novo
  // espaco?"): ele testa com a conta DONA da plataforma, cujo "mine"
  // (GET /api/room/mine) cai pra Sala Principal mesmo (ver fallback
  // `rooms[0]` em app/api/room/mine/route.ts, pra quem só tem sala
  // reservada) -- "Criar espaço +"/showCreateRoomFlow abaixo usavam
  // só "!myRoom" (sem esse filtro), então achavam que ele "já tinha
  // sala própria" e escondiam a opção. myRealRoom é a MESMA regra que
  // dropdownEntries logo abaixo já usava (sala reservada não conta
  // como "sala própria de verdade") -- centralizado aqui pra não
  // desalinhar nos dois lugares de novo.
  const myRealRoom =
    myRoom && myRoom.room_slug !== "mapa-publicado" && myRoom.room_slug !== "mapa-modelo" ? myRoom : null;
  // 30/set, pedido do Douglas: "quero essa aba sempre aberta com o
  // chat, quero que eles vejam a possibilidade, sempre ali" -- logo da
  // empresa PRÓPRIA (myRealRoom.name já tem o nome, mas não a logo --
  // MyRoom não carrega esse campo, ver tipo acima) pra alimentar
  // companyOptions no ChatDrawer (roomCompanyLogoUrl, ver mais abaixo)
  // mesmo sem nenhuma conversa ainda.
  // Busca separada da do companyProfile/selectedRoomSlug mais acima
  // (aquela é do espaço SELECIONADO/visitado agora, que pode ser o de
  // outra pessoa -- essa aqui é sempre a MINHA, pro chat).
  const [myRoomLogoUrl, setMyRoomLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!myRealRoom) {
      setMyRoomLogoUrl(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/room/company-profile?slug=${encodeURIComponent(myRealRoom.room_slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setMyRoomLogoUrl(data?.profile?.logoUrl || null);
      })
      .catch(() => {
        if (!cancelled) setMyRoomLogoUrl(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myRealRoom?.room_slug]);
  // avisa o motor único (ver setRoomContext/roomContext em
  // usePlatformChat.ts) qual é "minha sala" agora, pra "convidar
  // amigo"/carimbar "Empresa" numa conversa criada daqui usarem a
  // sala certa -- MESMA informação que esse componente já buscava
  // sozinho antes (myRealRoom/myRoomLogoUrl), só agora também
  // alimenta o hook compartilhado.
  useEffect(() => {
    chat.setRoomContext(
      myRealRoom ? { slug: myRealRoom.room_slug, name: myRealRoom.name, logoUrl: myRoomLogoUrl } : null
    );
  }, [chat, myRealRoom, myRoomLogoUrl]);
  const dropdownEntries = myRealRoom
    ? [...visibleRoomSlugs, { slug: myRealRoom.room_slug, label: myRealRoom.name, teamOnly: false }]
    : visibleRoomSlugs;
  // itens do dropdown "Espaços visitados" (ver VisitedRoom acima) --
  // filtra fora qualquer coisa que já apareça em "Meus espaços" (ex:
  // visitou a própria sala em algum momento por engano, ou virou dono
  // de uma sala que também tinha visitado antes de ser dono).
  const dropdownEntriesVisited = (visitedRooms ?? []).filter(
    (r) => !dropdownEntries.some((d) => d.slug === r.room_slug)
  );
  // ainda checando acesso (papel + sala própria) -- evita mostrar "criar
  // minha sala" só pra sumir 1 segundo depois quando descobre que a
  // pessoa já é do time/já tem sala.
  const stillCheckingRoomAccess = roomRoleLoading || myRoomLoading;
  // cliente de verdade: não é do time do Douglas E ainda não tem sala
  // própria -- mostra "Criar minha sala" (ver JSX mais abaixo) no lugar
  // do preview/"Entrar na sala" normal, SEM escolha (ele não tem outro
  // espaço pra ver enquanto isso).
  //
  // 30/set (20): "o link de convite, eu envio e a pessoa quando entra,
  // cai direto em criar espaco, nao no meu lobby" -- bug: essa conta
  // não tinha `&& !visitSlug` aqui, então QUALQUER pessoa sem sala
  // própria (o caso normal de quem recebeu um link de convite, ver
  // handleCopyRoomLink/visitSlug lá em cima) caía direto nesse fluxo
  // de "criar espaço", mesmo já tendo um ?visitar=<slug> válido na URL
  // esperando pra ser resolvido -- a visita (POST /api/room/visit, ver
  // efeito de visitSlug) rodava em paralelo e acabava não servindo pra
  // nada, ninguém via o resultado dela. Com visitSlug presente, espera
  // o preview/"Entrar na sala" normais de sempre (ver JSX mais abaixo)
  // -- assim que o POST confirma, selectedRoomSlug vira a sala
  // visitada e a pessoa entra nela, não na tela de criar espaço.
  const needsToCreateRoom = !stillCheckingRoomAccess && !canSeeSalaPrincipal && !myRealRoom && !visitSlug;
  // 29/set (10), pedido do Douglas: "adicione mais um opcao: Criar
  // espaço +" -- até aqui só quem NÃO era do time (needsToCreateRoom
  // acima) conseguia criar a própria sala; o time (Douglas/membros)
  // ficava travado só com "Sala principal"/"Mapa modelo" pra sempre,
  // sem jeito de ter uma sala própria também. Esse state, ligado pelo
  // item novo "Criar espaço +" no dropdown "Meus espaços" (mais
  // abaixo), força o MESMO fluxo de needsToCreateRoom a aparecer
  // mesmo sendo do time -- ver openCreateRoomFlow no lugar do
  // dropdown. Só faz sentido enquanto ainda não tem myRoom (o mesmo
  // limite de "uma sala por conta" que sempre existiu); assim que a
  // sala nasce, myRoom passa a existir e esse flag fica sem efeito
  // (voltamos a confiar só em needsToCreateRoom, que nunca conta pra
  // quem já tem myRoom).
  const [creatingSpaceFromDropdown, setCreatingSpaceFromDropdown] = useState(false);
  const showCreateRoomFlow = needsToCreateRoom || (creatingSpaceFromDropdown && !myRealRoom);
  function openCreateRoomFlow() {
    setCreatingSpaceFromDropdown(true);
    setSpacesMenuOpen(false);
    setLobbyView("spaces");
  }

  // conversas (ver chat.conversations/usePlatformChat.ts) E agenda
  // (ver chat.calls/usePlatformChat.ts, "agenda (ver comentário grande
  // dela acima)") não precisam de nenhum fetch/polling próprio aqui --
  // chegam ao vivo pela conexão única de plataforma, MESMA fonte que a
  // sala usa (pedido do Douglas, 1/out pro chat, 2/out pra agenda:
  // "sistema unico, assim como o chat").

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

  // "Conversar" no painel de Amigos / clique num founder -- cria (ou
  // acha) a conversa direta pelo motor único (ver startDirectWith em
  // usePlatformChat.ts, MESMO fluxo que a sala usa), sem POST nenhum
  // daqui: a conversa chega via "chat:conversation" na conexão de
  // plataforma e já abre sozinha (ver autoOpenNextConversationRef no
  // hook), só precisa fechar Contatos/founder e abrir o painel.
  function handleStartConversation(targetUserId: string, lane: "private" | "company" = "private") {
    setContactsOpen(false);
    setViewingFounderUserId(null);
    chat.startDirectWith(targetUserId, lane);
    setChatPanelOpen(true);
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
    () => chat.calls.filter((c) => c.participants.find((p) => p.id === myUserId)?.status === "pending").length,
    [chat.calls, myUserId]
  );

  // badge de "tem mensagem não vista" -- vem pronto do motor único
  // agora (ver totalUnreadMessages em usePlatformChat.ts, MESMO
  // cálculo que tinha aqui, soma unreadCount de cada conversa).
  const totalUnreadMessages = chat.totalUnreadMessages;

  // agrupa os compromissos futuros (calls, já vem do /agenda/summary
  // de verdade -- ver useEffect logo acima) por dia, pega os 3
  // próximos dias que têm pelo menos 1 evento, ordenados por data --
  // é a "previa da agenda" pedida pelo Douglas, mostrada no lobby.
  // 29/set (3): "mantenha os cards caso nao tenha evento do mesmo
  // jeito, so com frase, sem eventos hoje e deixe 30 dias rolavel em
  // lateral também" -- antes só listava dias que TINHAM compromisso
  // (até 3); agora é uma janela FIXA de 30 dias (hoje + 29 seguintes),
  // sempre os 30, cada um virando um card mesmo sem nada marcado (ver
  // isToday/items vazio na renderização -- mostra uma frase em vez da
  // lista). O scroll lateral pra caber os 30 já existia (ver
  // .lobby-agenda-preview, overflow-x), só precisava parar de cortar
  // em 3.
  const agendaPreviewDays = useMemo(() => {
    const byDay = new Map<string, CallEvent[]>();
    for (const call of chat.calls) {
      const d = new Date(call.startTs);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = byDay.get(key);
      if (list) list.push(call);
      else byDay.set(key, [call]);
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const days: { key: string; ts: number; isToday: boolean; items: CallEvent[] }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const items = (byDay.get(key) || []).slice().sort((a, b) => a.startTs - b.startTs);
      days.push({ key, ts: d.getTime(), isToday: i === 0, items });
    }
    return days;
  }, [chat.calls]);

  // 30/set, pedido do Douglas ("estou falando desse card" + "deixa
  // ele aberto ja") -- assim que showCreateRoomFlow liga, zera
  // companyProfile pra BLANK (rascunho limpo) em vez de deixar o
  // perfil do espaço que tava selecionado antes (ex: alguém clica
  // "Criar espaço" no dropdown com Sala Principal ainda selecionada)
  // -- sem isso editaria/mostraria por engano o card de um espaço que
  // já existe. Só zera na TRANSIÇÃO pra true (não a cada render).
  useEffect(() => {
    if (showCreateRoomFlow) {
      setCompanyProfile(BLANK_COMPANY_PROFILE);
      setCompanyProfileCanEdit(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreateRoomFlow]);

  return (
    <div className={chatPanelOpen && chatPinMode === "side" ? "lobby-backdrop lobby-backdrop-chat-pinned" : "lobby-backdrop"}>
      {/* barra de topo -- pedido do Douglas (28/set, com print de
          referência do layout da Pepsi): logo no canto esquerdo
          superior + abas na mesma linha, começando por "Meus
          espaços". */}
      <div className="lobby-topbar">
        <div className="lobby-topbar-logo-group">
          {/* semáforo decorativo removido -- pedido do Douglas (28/set):
              "tire isso, esses pontinhos". */}
          {/* logo de verdade (pedido do Douglas, 29/set: "minha logo,
              no lugar de habbo-gather / O x use a loog, o tower,
              escreve / a fonte é: Raleway") -- o "X" é a marca dele
              (public/logo-x-dark.png, recortada da logo "X Tower" que
              ele mandou, recolorida pra escuro porque o topbar aqui é
              claro -- a original é branca, feita pro fundo escuro do
              resto do app) e "Tower" é texto de verdade (não imagem),
              na fonte Raleway (ver --font-raleway em app/layout.tsx). */}
          {/* pedido do Douglas, 30/set (20): "vai ser clicando na
              logo cai nela" (na página principal) -- logo era só
              decorativo até aqui (span sem onClick nenhum). */}
          <button type="button" className="lobby-topbar-logo" onClick={() => setLobbyView("home")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-x-dark.png" alt="" className="lobby-topbar-logo-mark" />
            <span className="lobby-topbar-logo-text">Tower</span>
          </button>
        </div>
        <nav className="lobby-topbar-nav">
          <div className="lobby-topbar-tab-wrap">
            <button
              type="button"
              // pedido do Douglas, 30/set (20): "ta aparecendo como
              // se ele tivesse dentro do lobby, mas nao e ali, e
              // dentro do X tower, e a pagina inicial nao e o lobby
              // das salas" -- antes tava sempre "active" (a bolinha
              // atrás de "PRODUCTS" no print de referência, que marca
              // a aba selecionada) mesmo estando na página inicial
              // (home), dando a entender que home seria "dentro" de
              // Meus espaços. Só fica active de verdade quando a
              // página atual REALMENTE é a de espaços (lobbyView,
              // ver mais acima) -- aberto/fechado do dropdown é só a
              // setinha girar, ver lobby-topbar-chevron logo abaixo,
              // continua independente disso.
              className={lobbyView === "spaces" ? "lobby-topbar-tab active" : "lobby-topbar-tab"}
              // pedido do Douglas, 30/set (20): "cliquei em meus
              // espacos e ele ja pulou direto, nao e assim, ele tem
              // que selecionar o espaco primeiro" -- clicar na ABA só
              // abre o dropdown (como sempre foi); navegar pra
              // "spaces" só acontece quando escolhe um item de
              // verdade dentro dele (ver onClick dos itens mais
              // abaixo, que já tinham ganhado setLobbyView).
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
                  {/* 29/set, pedido do Douglas -- espaços clicáveis
                      aqui (ver ROOM_SLUGS/dropdownEntries no topo do
                      arquivo), no lugar do único botão fixo "Sala
                      principal" de antes (não reagia a clique nenhum).
                      "Sala principal"/"Mapa modelo" só aparecem pro
                      time do Douglas; a sala PRÓPRIA do cliente
                      (myRoom, quando existe) entra na lista também.
                      Clicar troca só a SELEÇÃO (selectedRoomSlug) --
                      entrar de verdade continua sendo o botão "Entrar
                      na sala" lá embaixo (handleEnter), mesmo fluxo de
                      sempre. Lista vazia (cliente sem time/sala ainda)
                      -- ver "Criar minha sala" no card principal, não
                      aqui. */}
                  {dropdownEntries.length === 0 ? (
                    <p className="lobby-topbar-dropdown-empty">
                      {stillCheckingRoomAccess ? "Carregando…" : "Crie sua sala pra ela aparecer aqui."}
                    </p>
                  ) : (
                    dropdownEntries.map((r) => (
                      <button
                        key={r.slug}
                        type="button"
                        className={
                          r.slug === selectedRoomSlug
                            ? "lobby-topbar-dropdown-item active"
                            : "lobby-topbar-dropdown-item"
                        }
                        onClick={() => {
                          userPickedRoomRef.current = true;
                          setSelectedRoomSlug(r.slug);
                          setSpacesMenuOpen(false);
                          setLobbyView("spaces");
                        }}
                      >
                        {r.label}
                      </button>
                    ))
                  )}
                  {/* 29/set (10), pedido do Douglas: "adicione mais um
                      opcao: Criar espaço +" -- até aqui só quem não
                      era do time ganhava esse fluxo (forçado, tela
                      inteira, ver needsToCreateRoom). Item extra no
                      fim da lista, sempre que a conta ainda não tem
                      sala própria (mesmo sendo do time) -- abre o
                      MESMO fluxo de nomear empresa + escolher modelo
                      (ver openCreateRoomFlow/showCreateRoomFlow mais
                      acima, JSX no .lobby-card mais abaixo). */}
                  {accountAccessToken && !stillCheckingRoomAccess && !myRealRoom && (
                    <button
                      type="button"
                      className="lobby-topbar-dropdown-item lobby-topbar-dropdown-item-create"
                      onClick={openCreateRoomFlow}
                    >
                      Criar espaço +
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 29/set, pedido do Douglas: "aqui encima, do lado de meus
              espacos, cria uma nova / espacos visitados" -- salas de
              OUTRAS pessoas que essa conta já visitou por link (ver
              VisitedRoom/dropdownEntriesVisited acima e POST
              /api/room/visit). Mesmo padrão de dropdown de "Meus
              espaços" acima (clicar troca só a seleção, "Entrar na
              sala" continua sendo o botão lá embaixo), só que NUNCA
              "active" (não é uma seção fixa como "Meus espaços", só
              mais uma aba clicável, igual visualmente às inertes ao
              lado até ter algo pra mostrar). */}
          <div className="lobby-topbar-tab-wrap">
            <button
              type="button"
              className="lobby-topbar-tab"
              // mesmo motivo do "Meus espaços" acima -- só abre o
              // dropdown, não navega sozinho.
              onClick={() => setVisitedMenuOpen((v) => !v)}
              aria-expanded={visitedMenuOpen}
            >
              <span className="lobby-topbar-tab-label">Espaços visitados</span>
              <span className={visitedMenuOpen ? "lobby-topbar-chevron open" : "lobby-topbar-chevron"}>
                <ChevronIcon />
              </span>
            </button>
            {visitedMenuOpen && (
              <>
                <div className="lobby-topbar-dropdown-backdrop" onClick={() => setVisitedMenuOpen(false)} />
                <div className="lobby-topbar-dropdown">
                  {!accountAccessToken ? (
                    <p className="lobby-topbar-dropdown-empty">Crie uma conta pra guardar espaços visitados.</p>
                  ) : dropdownEntriesVisited.length === 0 ? (
                    <p className="lobby-topbar-dropdown-empty">
                      {visitedRooms === null ? "Carregando…" : "Nenhum espaço visitado ainda."}
                    </p>
                  ) : (
                    dropdownEntriesVisited.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={
                          r.room_slug === selectedRoomSlug
                            ? "lobby-topbar-dropdown-item active"
                            : "lobby-topbar-dropdown-item"
                        }
                        onClick={() => {
                          userPickedRoomRef.current = true;
                          setSelectedRoomSlug(r.room_slug);
                          setVisitedMenuOpen(false);
                          setLobbyView("spaces");
                        }}
                      >
                        {r.name}
                      </button>
                    ))
                  )}
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
          {/* card da conta -- virou componente à parte (ver
              components/AccountCard.tsx), pedido do Douglas 30/set:
              "esse card, mantenha ele em toda tela que o usuario vai
              inclusive no jogo" (ver o mesmo <AccountCard /> dentro de
              GameRoom.tsx agora). Os 3 itens novos (perfil público/
              dados da conta/selo) moram dentro dele. */}
          <AccountCard
            accountUserId={accountUserId}
            accountProfile={accountProfile}
            accountAccessToken={accountAccessToken ?? null}
            onStartConversation={(targetUserId) => handleStartConversation(targetUserId)}
            onSignOut={onSignOut}
          />
        </div>
      </div>

      {/* card da Empresa selecionada -- pedido do Douglas: "nesse canto
          quero o card da Empresa selecionada / Copie EXATAMENTE TUDO"
          + depois, ao ver o print de referência de novo: "nao e ali
          que e pra ele estar" (não era pra ficar como dropdown no
          canto direito, do lado da conta). Fixo no canto ESQUERDO da
          tela, sempre visível (sem clique pra abrir) -- combina com o
          nome da aba "Empresas Posicionadas" no topbar: é uma vitrine
          fixa, não um menu (ver comentário grande do CompanyProfile
          lá em cima -- agora dado real por espaço, não mais molde).

          29/set: + a setinha do lado que abre a aba de edição (só pro
          dono, ver companyProfileCanEdit lá em cima). */}
      {/* pedido do Douglas, 30/set (20): card da empresa + painel de
          edição (ver fechamento logo depois do company-edit-panel
          abaixo) só aparecem na página "spaces" (Meus espaços) agora
          -- ver lobbyView lá em cima. O card "Entrar na sala"
          (.lobby-card, mais abaixo) tem o MESMO guard, só que
          separado (a agenda entra no meio dos dois e foi pra "home"). */}
      {lobbyView === "spaces" && (
        <>
      <div className="lobby-company-card-pin">
        <div className={companyEditOpen ? "company-card company-card-attached" : "company-card"}>
          {/* 29/set: pedido do Douglas "a frase no caso e a imagem do
              banner, nao e um texto" -- tirei o texto/frase de efeito
              que eu tinha desenhado por cima (era conteúdo INVENTADO
              meu, o print de referência só tinha aquele texto porque
              fazia parte do design ORIGINAL do banner da Obrazur, não
              porque o app deveria desenhar um texto ali). Essa faixa
              clara agora é só a moldura da foto de banner mesmo (ver
              companyProfile.bannerUrl) -- sem overlay/tinta em cima (não
              tem mais texto pra proteger a legibilidade de). */}
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
              {companyProfile.verified && <VerifiedBadge />}
            </p>
            <p className="company-card-handle">@{companyProfile.handle.replace(/^@/, "")}</p>
            {/* "Tagline" -- pedido do Douglas, 30/set (17): "logo
                acima do quem somos, com essa mesma caixa de
                texto/fonte" (print de referência: texto grande, caixa
                alta, negrito, branco). Só mostra quando tiver uma
                definida. */}
            {companyProfile.tagline && <p className="company-card-tagline">{companyProfile.tagline}</p>}
            {/* pedido do Douglas, 30/set (11): "No card da empresa,
                bio vira Quem somos / E a frse quem somos fica no card
                tambem titulando a bio" -- rótulo fixo em cima do texto
                da bio (campo continua sendo companyProfile.bio por
                baixo, só o rótulo exibido no card + na edição vira
                "Quem somos"). Só mostra o bloco quando tem bio pra
                titular (senão ficava um "Quem somos" solto sem nada
                embaixo). */}
            {companyProfile.bio && (
              <div className="company-card-bio-block">
                <p className="company-card-bio-label">Quem somos</p>
                <p className="company-card-bio">{companyProfile.bio}</p>
              </div>
            )}
            {/* pedido do Douglas: "so vai ter Seguidores (o perfil da
                empresa nao segue ninguem)" -- perfil de empresa não
                segue outras contas, então só faz sentido mostrar
                Seguidores (tirei "Seguindo" e o campo `following`
                inteiro do CompanyProfile). */}
            <p className="company-card-stats">
              <span>
                <strong>{companyProfile.followers}</strong> Seguidores
              </span>
            </p>
            <p className="company-card-link">
              <LinkIcon />
              {companyProfile.link}
            </p>

            {/* pedido do Douglas (print de referência com cards
                empilhados tipo carrossel): "abaixo do link, crie cards
                com os posicionamentos da empresa, que rolam pro lado
                direito caso tenha mais de um, com nomes em negrito,
                quadradinhos, e eu vou subir artes pra por de fundo dos
                quadradinhos" -- um quadradinho por categoria marcada
                em companyProfile.category (ver "Posicione a sua
                empresa:" no painel de edição). Por enquanto sem arte
                de fundo (isso o Douglas falou que sobe depois), só o
                fundo placeholder + nome em negrito; quando ele subir
                as artes dá pra plugar via background-image igual já
                é feito com bannerUrl/logoUrl acima. Rola só se não
                couber tudo (overflow-x + nowrap), sem crescer a altura
                do card. */}
            {companyProfile.category.length > 0 && (
              <div className="company-card-positions">
                {companyProfile.category.map((cat) => (
                  <div
                    key={cat}
                    className="company-card-position-card"
                    style={{ backgroundImage: `url(${companyPositionBackgroundFor(cat)})` }}
                  >
                    <span className="company-card-position-name">{cat}</span>
                  </div>
                ))}
              </div>
            )}

            {/* pedido do Douglas, 30/set (13): "vai aparecer no card
                da empresa a foto de perfil dos founders com link
                clicavel pro perfil pessoal" -- só aparece com o
                toggle "Tornar os founders visíveis" ligado (ver painel
                de edição acima); companyProfile.founders já vem
                PRONTO do servidor nesse caso (dona primeiro, depois
                Membros), então aqui é só desenhar. Clique abre
                ProfileViewCard (ver viewingFounderUserId acima),
                mesmo padrão de qualquer outra foto clicável no app. */}
            {/* "Founders:" -- pedido do Douglas, 30/set (19): "antes
                do nome dos founders, titulo de apresentacao / Founders:"
                -- mesmo padrão visual de "Quem somos" (rótulo fixo, sem
                vir de campo nenhum), só que aqui SEM bloco/wrapper
                próprio (a lista já tem margin-top: 14px sozinha, ver
                .company-card-founders em app/globals.css). */}
            {companyProfile.showFoundersOnCard && companyProfile.founders.length > 0 && (
              <>
                <p className="company-card-founders-label">Founders:</p>
                <div className="company-card-founders">
                {companyProfile.founders.map((f) => (
                  <button
                    key={f.userId}
                    type="button"
                    className="company-card-founder"
                    title={f.name || "(sem nome)"}
                    onClick={() => setViewingFounderUserId(f.userId)}
                  >
                    <span
                      className="company-card-founder-avatar"
                      style={{ backgroundImage: f.photoUrl ? `url(${f.photoUrl})` : undefined }}
                    >
                      {!f.photoUrl && (f.name || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    {/* pedido do Douglas, 30/set (20): "cade o nome? poe
                        o nome da empresa nos dois" -> virou balãozinho
                        no hover -> "cade? nome fixo" -- Douglas queria
                        de volta um nome SEMPRE visível (balão some no
                        toque/mobile, também não aparece parado numa
                        screenshot). Pra não voltar a truncar feio
                        ("Hualison ...") o layout virou uma LISTA
                        vertical (avatar + nome lado a lado, uma linha
                        por founder, ver .company-card-founders abaixo)
                        em vez da fileira horizontal de avatares
                        espremidos -- o nome tem a largura inteira do
                        card pra respirar/quebrar linha se precisar. */}
                    <span className="company-card-founder-name">{f.name || "(sem nome)"}</span>
                  </button>
                ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* 29/set: pedido do Douglas, com print de referência de uma
            aba "Editar Empresa" (Nome fantasia/CNPJ/permissão/fotos):
            "quero o card de edicao saindo dessa forma da imagem por
            baixo do card da empresa, todo em blur escurecido" -- não é
            mais um modal centralizado com fundo escurecendo a tela
            inteira (era assim antes); agora é um painel ENCOSTADO no
            card, mesma altura (o :50%/translateY abaixo é em relação a
            .lobby-company-card-pin, que já tem a altura certa via
            top+bottom, ver comentário lá em cima), saindo de trás dele
            -- .company-card-attached tira o arredondamento do lado
            direito do card enquanto isso tá aberto, pra emendar sem
            quina com .company-edit-panel (que já nasce só arredondado
            do lado direito). Seta vira pra esquerda (fecha) quando já
            tá aberto. */}
        {/* 29/set (7): só o DONO do espaço selecionado vê a setinha
            de editar (companyProfileCanEdit vem do servidor, ver
            fetch de /api/room/company-profile mais acima) -- antes
            era sempre visível (o card era um molde só seu, sem
            "espaço de outra pessoa" pra sequer existir). */}
        {companyProfileCanEdit && !showCreateRoomFlow && (
          <button
            type="button"
            className="company-card-edit-trigger"
            onClick={() => setCompanyEditOpen((v) => !v)}
            aria-expanded={companyEditOpen}
            title={companyEditOpen ? "Fechar edição" : "Editar empresa"}
            data-tooltip={companyEditOpen ? "Fechar edição" : "Editar empresa"}
          >
            {companyEditOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          </button>
        )}
      </div>

      {/* 30/set, pedido do Douglas: "o card da empresa criando novo
          espaco nao tem o negocio de edicao, na vdd, na criacao, deixa
          ele aberto ja" -- enquanto showCreateRoomFlow tá true, esse
          painel fica SEMPRE aberto (sem depender de companyEditOpen/
          companyProfileCanEdit, que exigem um espaço já existente) --
          a pessoa preenche nome/logo/banner/bio etc. aqui mesmo, ANTES
          de criar a sala (ver companyProfile virando BLANK_COMPANY_PROFILE
          nesse modo, no useEffect de showCreateRoomFlow mais acima, e
          o POST extra em handleCreateRoomFromTemplate que persiste tudo
          isso assim que a sala nasce). */}
      {(showCreateRoomFlow || (companyEditOpen && companyProfileCanEdit)) && (
        <>
          {/* clique fora fecha -- mas SEM escurecer o resto da tela
              (o pedido foi só o painel em si ficar "em blur
              escurecido", não a sala toda por trás dele). Sem clique-
              fora nenhum durante showCreateRoomFlow -- não tem "fechar",
              é obrigatório preencher pra criar a sala. */}
          {!showCreateRoomFlow && <div className="company-edit-click-catcher" onClick={() => setCompanyEditOpen(false)} />}
          <div className="company-edit-panel" onClick={(e) => e.stopPropagation()}>
            <div className="company-edit-header-row">
              <div>
                <h2 className="company-edit-title">{showCreateRoomFlow ? "Sua empresa" : "Editar Empresa"}</h2>
                <p className="company-edit-subtitle">
                  {showCreateRoomFlow
                    ? "Preencha os dados da sua empresa -- eles já nascem junto com a sua sala."
                    : "Atualize as informações da sua empresa que serão exibidas na plataforma."}
                </p>
              </div>
              {!showCreateRoomFlow && (
                <button type="button" className="items-panel-close" onClick={() => setCompanyEditOpen(false)} title="Fechar">
                  ✕
                </button>
              )}
            </div>

            <div className="company-edit-section">
              <div className="company-edit-section-head">
                <h3>Foto de banner</h3>
                <span className="company-edit-hint">Tamanho recomendado: 580 x 260</span>
              </div>
              <button
                type="button"
                className="company-edit-banner-drop"
                onClick={() => companyBannerInputRef.current?.click()}
                style={companyProfile.bannerUrl ? { backgroundImage: `url(${companyProfile.bannerUrl})` } : undefined}
              >
                <span className="company-edit-banner-drop-overlay">
                  <CameraIcon size={22} />
                  <strong>Alterar banner</strong>
                  <span>Clique para enviar uma imagem</span>
                </span>
              </button>
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
            </div>

            <div className="company-edit-section">
              <div className="company-edit-section-head">
                <h3>Foto de perfil</h3>
                <span className="company-edit-hint">Tamanho recomendado: 400 x 400</span>
              </div>

              <div className="company-edit-profile-row">
                <div className="company-edit-logo-drop-wrap">
                  <button type="button" className="company-edit-logo-drop" onClick={() => companyLogoInputRef.current?.click()}>
                    {companyProfile.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={companyProfile.logoUrl} alt="" />
                    ) : (
                      <span>{companyProfile.name.charAt(0)}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="company-edit-logo-drop-btn"
                    onClick={() => companyLogoInputRef.current?.click()}
                    title="Trocar foto de perfil"
                  >
                    <CameraIcon />
                  </button>
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
                </div>

                <div className="company-edit-fields">
                  <label className="company-edit-field">
                    <span>Nome fantasia *</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.name}
                      maxLength={60}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, name: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "inclusive adiciona preencher
                      o @ nas config" -- campo novo, faltava dar pra
                      editar o @arroba mostrado no card (antes só vinha
                      do molde fixo). Mesmo padrão do campo de
                      Instagram em GameRoom.tsx: guarda como a pessoa
                      digitou (com ou sem @), só tira o @ na hora de
                      EXIBIR (ver company-card-handle acima). */}
                  <label className="company-edit-field">
                    <span>Rede social da empresa</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.handle}
                      placeholder="empresaexemplo"
                      maxLength={30}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, handle: e.target.value }))}
                    />
                  </label>

                  {/* "Tagline" -- pedido do Douglas, 30/set (17): "a
                      frase de impacto da empresa, ela aparecera assim
                      no card, logo acima do quem somos, com essa
                      mesma caixa de texto/fonte" (print de referência:
                      texto grande, caixa alta, negrito, branco -- ver
                      company-card-tagline no card abaixo). */}
                  <label className="company-edit-field">
                    <span>Tagline</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.tagline}
                      placeholder="A frase de impacto da sua empresa"
                      maxLength={120}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, tagline: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "o link da empresa tambem,
                      campo pra adicionar" -- companyProfile.link já
                      existia e já aparecia no card (ver
                      company-card-link, ícone + texto embaixo dos
                      stats), só faltava um jeito de editar; antes só
                      vinha do molde fixo. */}
                  <label className="company-edit-field">
                    <span>Link da empresa</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.link}
                      placeholder="habbo-gather.com/empresas"
                      maxLength={80}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, link: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "faltou o campo da bio
                      tambem: Descreve o propósito da sua empresa" --
                      companyProfile.bio já existia e já aparecia no
                      card (company-card-bio), só faltava editar; sem
                      campo nenhum antes, vinha só do molde fixo.
                      Textarea (não input de uma linha) -- mesmo padrão
                      do campo "Bio" do perfil pessoal em
                      GameRoom.tsx. */}
                  <label className="company-edit-field">
                    <span>Quem somos</span>
                    <textarea
                      className="company-edit-input company-edit-textarea"
                      value={companyProfile.bio}
                      placeholder="Descreve o propósito da sua empresa"
                      maxLength={200}
                      rows={3}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, bio: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "uma caixa de selecao, escrita
                      Posicione a sua empresa:" com a lista de ~61
                      categorias -- e depois "deixei marcar varias
                      opcoes", ou seja é multi-seleção (não dá pra usar
                      um <select> nativo, que só permite 1 valor).
                      Dropdown custom: botão mostra as categorias
                      escolhidas (ou um placeholder), clique abre um
                      checklist com todas as opções de
                      COMPANY_CATEGORIES (definida lá em cima, perto de
                      BLANK_COMPANY_PROFILE). Mesmo padrão de
                      catcher/stopPropagation já usado pro próprio
                      painel de edição (company-edit-click-catcher). */}
                  <label className="company-edit-field">
                    <span>Posicione a sua empresa:</span>
                    <div className="company-edit-category-select">
                      <button
                        type="button"
                        className="company-edit-input company-edit-category-trigger"
                        onClick={() => setCompanyCategoryOpen((v) => !v)}
                        aria-expanded={companyCategoryOpen}
                      >
                        <span className="company-edit-category-trigger-text">
                          {companyProfile.category.length > 0
                            ? companyProfile.category.join(", ")
                            : "Selecione uma ou mais categorias"}
                        </span>
                        <ChevronIcon />
                      </button>
                      {companyCategoryOpen && (
                        <>
                          <div className="company-edit-category-catcher" onClick={() => setCompanyCategoryOpen(false)} />
                          <div className="company-edit-category-list" onClick={(e) => e.stopPropagation()}>
                            {COMPANY_CATEGORIES.map((cat) => (
                              <label key={cat} className="company-edit-category-option">
                                <input
                                  type="checkbox"
                                  checked={companyProfile.category.includes(cat)}
                                  onChange={() => toggleCompanyCategory(cat)}
                                />
                                <span>{cat}</span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="company-edit-divider" />

            <label className="company-edit-permission-row">
              <div className="company-edit-permission-text">
                <p className="company-edit-permission-question">
                  Permitir exibição do nome da empresa do perfil dos colaboradores?
                </p>
                <p className="company-edit-permission-hint">
                  Quando ativado, o nome da sua empresa será exibido no perfil dos colaboradores.
                </p>
              </div>
              <span className="company-edit-toggle">
                <input
                  type="checkbox"
                  checked={companyProfile.showNameOnEmployeeProfiles}
                  onChange={(e) =>
                    setCompanyProfile((prev) => ({ ...prev, showNameOnEmployeeProfiles: e.target.checked }))
                  }
                />
                <span className="company-edit-toggle-track">
                  <span className="company-edit-toggle-thumb" />
                </span>
              </span>
            </label>

            <div className="company-edit-divider" />

            {/* Membros (colaboradores) -- pedido do Douglas, 30/set
                (8): "a pessoa tem que ser adicionada como membro por
                quem tem direitos na sala" (ver companyMembers/
                addCompanyMember/removeCompanyMember acima,
                public.company_members). Reaproveita `directory`
                (mesmo diretório platform-wide do convite de "Convidar
                pessoas" da Agenda, lá em cima) pra escolher quem
                adicionar -- clique já adiciona na hora, sem
                checklist/confirmar. */}
            <div className="company-edit-field">
              <span>Membros (colaboradores)</span>
              <div className="company-edit-category-select">
                <button
                  type="button"
                  className="company-edit-input company-edit-category-trigger"
                  onClick={() => setMemberPickerOpen((v) => !v)}
                  aria-expanded={memberPickerOpen}
                  disabled={!directory}
                >
                  <span className="company-edit-category-trigger-text">
                    {!directory ? "Carregando pessoas…" : "Adicionar membro"}
                  </span>
                  <ChevronIcon />
                </button>
                {memberPickerOpen && directory && (
                  <>
                    <div className="company-edit-category-catcher" onClick={() => setMemberPickerOpen(false)} />
                    <div className="company-edit-category-list" onClick={(e) => e.stopPropagation()}>
                      {directory.filter((u) => u.userId !== myUserId && !companyMembers?.some((m) => m.userId === u.userId))
                        .length === 0 ? (
                        <p className="lobby-agenda-invited-readonly">Ninguém mais pra adicionar.</p>
                      ) : (
                        directory
                          .filter((u) => u.userId !== myUserId && !companyMembers?.some((m) => m.userId === u.userId))
                          .map((u) => (
                            <label
                              key={u.userId}
                              className="company-edit-category-option"
                              onClick={() => addCompanyMember(u.userId)}
                            >
                              <span>{u.name}</span>
                            </label>
                          ))
                      )}
                    </div>
                  </>
                )}
              </div>
              {memberError && <p className="company-edit-save-error">{memberError}</p>}
              {companyMembers === null ? (
                <p className="company-edit-members-empty">Carregando membros...</p>
              ) : companyMembers.length === 0 ? (
                <p className="company-edit-members-empty">Nenhum membro ainda -- só você (dona).</p>
              ) : (
                <div className="company-edit-members-list">
                  {companyMembers.map((m) => (
                    // "Cargo" (pedido do Douglas, 30/set (16)) -- wrapper
                    // à parte SÓ aqui (Founders logo abaixo continua
                    // usando .company-edit-member-row direto, sem esse
                    // wrapper) pra não mexer no layout de quem não tem
                    // cargo nenhum.
                    <div key={m.userId} className="company-edit-member-item">
                      <div className="company-edit-member-row">
                        <span
                          className="company-edit-member-avatar"
                          style={{ backgroundImage: m.photoUrl ? `url(${m.photoUrl})` : undefined }}
                        >
                          {!m.photoUrl && (m.name || "?").trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="company-edit-member-name">{m.name || "(sem nome)"}</span>
                        <button
                          type="button"
                          className="company-edit-member-remove"
                          disabled={memberBusyUserId === m.userId}
                          onClick={() => removeCompanyMember(m.userId)}
                        >
                          Remover
                        </button>
                      </div>
                      <select
                        className="company-edit-input company-edit-member-cargo"
                        value={m.cargo}
                        onChange={(e) => updateMemberCargo(m.userId, e.target.value)}
                      >
                        <option value="">Sem cargo definido</option>
                        {CARGO_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="company-edit-divider" />

            {/* Founders -- pedido do Douglas, 30/set (14): roster À
                PARTE de "Membros (colaboradores)" acima (ver
                comentário grande em companyFounders/public.company_founders).
                Mesmo componente visual (reaproveita as mesmas classes
                company-edit-members e company-edit-category de
                Membros, só trocando a fonte de dados/funções pra
                founder), pra não inventar CSS novo pra algo que já
                tem a cara idêntica. */}
            <div className="company-edit-field">
              <span>Founders</span>
              <div className="company-edit-category-select">
                <button
                  type="button"
                  className="company-edit-input company-edit-category-trigger"
                  onClick={() => setFounderPickerOpen((v) => !v)}
                  aria-expanded={founderPickerOpen}
                  disabled={!directory}
                >
                  <span className="company-edit-category-trigger-text">
                    {!directory ? "Carregando pessoas…" : "Adicionar founder"}
                  </span>
                  <ChevronIcon />
                </button>
                {founderPickerOpen && directory && (
                  <>
                    <div className="company-edit-category-catcher" onClick={() => setFounderPickerOpen(false)} />
                    <div className="company-edit-category-list" onClick={(e) => e.stopPropagation()}>
                      {directory.filter((u) => u.userId !== myUserId && !companyFounders?.some((f) => f.userId === u.userId))
                        .length === 0 ? (
                        <p className="lobby-agenda-invited-readonly">Ninguém mais pra adicionar.</p>
                      ) : (
                        directory
                          .filter((u) => u.userId !== myUserId && !companyFounders?.some((f) => f.userId === u.userId))
                          .map((u) => (
                            <label
                              key={u.userId}
                              className="company-edit-category-option"
                              onClick={() => addCompanyFounder(u.userId)}
                            >
                              <span>{u.name}</span>
                            </label>
                          ))
                      )}
                    </div>
                  </>
                )}
              </div>
              {founderError && <p className="company-edit-save-error">{founderError}</p>}
              {companyFounders === null ? (
                <p className="company-edit-members-empty">Carregando founders...</p>
              ) : companyFounders.length === 0 ? (
                <p className="company-edit-members-empty">Nenhum founder ainda -- só você (dona).</p>
              ) : (
                <div className="company-edit-members-list">
                  {companyFounders.map((f) => (
                    <div key={f.userId} className="company-edit-member-row">
                      <span
                        className="company-edit-member-avatar"
                        style={{ backgroundImage: f.photoUrl ? `url(${f.photoUrl})` : undefined }}
                      >
                        {!f.photoUrl && (f.name || "?").trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="company-edit-member-name">{f.name || "(sem nome)"}</span>
                      <button
                        type="button"
                        className="company-edit-member-remove"
                        disabled={founderBusyUserId === f.userId}
                        onClick={() => removeCompanyFounder(f.userId)}
                      >
                        Remover
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="company-edit-divider" />

            {/* pedido do Douglas, 30/set (13): "no editor do card da
                empresa coloque Tornar os founders visiveis no perfil
                da empresa? vai aparecer no card da empresa a foto de
                perfil dos founders com link clicavel pro perfil
                pessoal" -- mesmo padrão do toggle de nome logo acima,
                só que "founders" aqui é a lista de cima (dona +
                company_founders, ver companyProfile.founders, montada
                pelo servidor só quando esse toggle tá ligado, ver
                comentário grande em app/api/room/company-profile). */}
            <label className="company-edit-permission-row">
              <div className="company-edit-permission-text">
                <p className="company-edit-permission-question">Tornar os founders visíveis no perfil da empresa?</p>
                <p className="company-edit-permission-hint">
                  Quando ativado, a foto de quem é dona/membro aparece no card, com link pro perfil pessoal.
                </p>
              </div>
              <span className="company-edit-toggle">
                <input
                  type="checkbox"
                  checked={companyProfile.showFoundersOnCard}
                  onChange={(e) => setCompanyProfile((prev) => ({ ...prev, showFoundersOnCard: e.target.checked }))}
                />
                <span className="company-edit-toggle-track">
                  <span className="company-edit-toggle-thumb" />
                </span>
              </span>
            </label>

            <div className="company-edit-divider" />

            {/* 29/set (7): agora salva DE VERDADE no espaço (POST
                /api/room/company-profile, ver saveCompanyProfile
                acima) -- antes só fechava o painel (era só
                localStorage, já salvo a cada tecla). 30/set: durante
                showCreateRoomFlow não tem sala pra salvar AINDA (ver
                comentário grande no topo desse painel) -- some o botão
                de salvar, o "Continuar" logo abaixo no modal que
                confirma o nome (e handleCreateRoomFromTemplate que
                persiste o resto assim que a sala existe). */}
            {!showCreateRoomFlow && (
              <>
                {companySaveError && <p className="company-edit-save-error">{companySaveError}</p>}
                <div className="company-edit-save-row">
                  <button
                    type="button"
                    className="company-edit-save-btn"
                    onClick={saveCompanyProfile}
                    disabled={companySaving}
                  >
                    {companySaving ? "Salvando…" : "Salvar alterações"}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
        </>
      )}

      {/* pedido do Douglas: "remova o botao abrir minha agenda,
          mantenha apenas os cards da agenda, alinhe os cards com o
          card da empresa embaixo, mantenha a altura fixa, se passar
          de 3 eventos, scrol ativa dentro do card" + (29/set 3)
          "mantenha os cards caso nao tenha evento do mesmo jeito, so
          com frase, sem eventos hoje e deixe 30 dias rolavel em
          lateral também" + "use o estilo blur do editar empresa" --
          janela FIXA de 30 dias (agendaPreviewDays acima, sempre 30,
          mesmo os sem nada marcado -- esses mostram só uma frase em
          vez da lista de "Próximos"). Saiu do fluxo do flex de
          .lobby-backdrop (virou position:fixed, mesmo esquema de
          .lobby-company-card-pin) pra alinhar a borda de BAIXO com o
          card da empresa (bottom:100px nos dois -- mesma distância do
          av-bar). Altura de cada card é FIXA (.lobby-agenda-day-card)
          -- a lista de eventos rola por dentro (overflow-y) quando
          passa de 3, e os 30 cards rolam de lado (overflow-x, ver
          .lobby-agenda-preview). Visual do card copiado de
          .company-edit-panel (fundo escuro + blur mais forte), em vez
          do degradê roxo claro de antes. Dados reais, mesmo `chat.calls`
          de sempre (motor único, ver comentário grande acima). */}
      {/* pedido do Douglas, 30/set (20): "la vai ter a agenda dele
          tambem mas por enquanto somente isso" -- essa é a página
          "home" inteira, por enquanto (ver lobbyView lá em cima). Saiu
          de perto do card da empresa (onde morava antes, mostrando
          junto) -- agora só aparece em home, o card da empresa só
          aparece em spaces.

          30/set (20) (2): "coloca um titulo na agenda / Minha
          agenda:" -- título fixo (mesmo padrão de "Founders:"/"Quem
          somos" no resto do app, só maior -- é título de página, não
          rótulo de campo). O position:fixed que morava direto em
          .lobby-agenda-preview subiu pra esse wrapper novo
          (.lobby-agenda-home), que empilha título + fileira de cards
          em coluna -- .lobby-agenda-preview virou só a fileira
          (flex-row) de dentro, sem se preocupar mais com a própria
          posição na tela.

          30/set (20) (3): "pagina inicial coloca um texto grande nas
          letras do card / Seja bem vindo (a), Fulano" -- saudação
          grande no topo da home, mesmo displayName já usado em
          .lobby-greeting (ver handleEnter/RoomPreview mais abaixo),
          só que essa versão é a manchete da página, bem maior. */}
      {lobbyView === "home" && (
      <>
        <p className="lobby-home-welcome">
          Seja bem-vindo(a){returningVisitor ? " de volta" : ""}, {displayName} 😉
        </p>
      <div className="lobby-agenda-home">
        <p className="lobby-agenda-title">Minha agenda:</p>
      <div className="lobby-agenda-preview">
        {agendaPreviewDays.map((day) => {
          const badge = formatAgendaDayBadge(day.ts);
          return (
            <div key={day.key} className="lobby-agenda-day-card">
              {/* 29/set (3): Douglas mandou o print de novo, agora
                  reto: "quero o card de data exatamente igual!!!" --
                  no print a coluna da esquerda inteira é um painel
                  escuro (não um "quadradinho" de número + resto
                  claro, como eu tinha) e "X eventos" tem uma setinha
                  (vira botão de verdade agora, abre a agenda completa
                  -- setinha sem função seria só decoração morta). */}
              <div className="lobby-agenda-day-left">
                <div className="lobby-agenda-day-num-wrap">
                  <span className="lobby-agenda-day-badge-num">{badge.day}</span>
                  <span className="lobby-agenda-day-badge-month">{badge.month}</span>
                </div>
                <p className="lobby-agenda-day-weekday">{badge.weekday}</p>
                {day.items.length > 0 && (
                  <button
                    type="button"
                    className="lobby-agenda-day-count"
                    onClick={() => chat.setAgendaOpen(true)}
                  >
                    {day.items.length} {day.items.length === 1 ? "evento" : "eventos"}
                    <ChevronRightIcon />
                  </button>
                )}
              </div>
              <div className="lobby-agenda-day-right">
                {day.items.length > 0 ? (
                  <>
                    <span className="lobby-agenda-day-label">Próximos</span>
                    <ul className="lobby-agenda-day-events">
                      {day.items.map((call, i) => (
                        <li key={call.id} className={`lobby-agenda-event-item tone-${i % 4}`}>
                          <p className="lobby-agenda-event-title">{call.title}</p>
                          <p className="lobby-agenda-event-time">
                            {formatAgendaEventTime(call.startTs, call.durationMinutes)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="lobby-agenda-day-empty-phrase">
                    {day.isToday ? "Sem eventos hoje" : "Sem eventos"}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      </div>
      </>
      )}

      {lobbyView === "spaces" && (
      <div className="lobby-card">
        {/* 29/set (2): Douglas mandou o print de novo, agora apontando
            pro card "Entrar na sala": "copie exatamente o que tem
            aqui... estilo fonte, cores, blur, tudo" -- ícone de câmera
            na pilula (não tinha), botão preto (era roxo), setinha no
            botão (não tinha). */}
        <div className="lobby-sign">
          <CamIcon off={false} />
          <span className="lobby-sign-text">SALA VIRTUAL</span>
        </div>
        <p className="lobby-greeting">Bem-vindo(a), {displayName}!</p>

        {/* 29/set, pedido do Douglas: "Cada cliente vai ter a sua
            sala... O cara entra, ele tem a sala dele la que ele
            escolher dentre os modelos... as pessoas so copiam a sala
            modelo, pra eles, ai se cria o mapa pra eles vinculado ao id
            deles" -- um cliente de verdade (não é do time do Douglas,
            ver needsToCreateRoom acima) ainda sem sala própria vê ISSO
            no lugar do preview/"Entrar na sala" normais: escolhe um
            modelo publicado (GET /api/room/templates) e
            handleCreateRoomFromTemplate clona ele (POST
            /api/room/create-from-template) -- assim que responde,
            myRoom passa a existir e esse bloco some sozinho (needsToCreateRoom
            vira false), voltando pro fluxo normal de sempre com a sala
            nova já selecionada. */}
        {showCreateRoomFlow ? (
          <div className="lobby-create-room">
            {/* só quem chegou aqui pelo "Criar espaço +" do dropdown
                (ver openCreateRoomFlow) E já tem pra onde voltar (é do
                time, ver canSeeSalaPrincipal) ganha esse "Cancelar" --
                um cliente de verdade em needsToCreateRoom não tem
                outro lugar pra ir (é obrigado a criar a sala). */}
            {creatingSpaceFromDropdown && !needsToCreateRoom && (
              <button
                type="button"
                className="lobby-create-room-cancel-btn"
                onClick={() => {
                  setCreatingSpaceFromDropdown(false);
                  setNewRoomNameConfirmed(false);
                }}
              >
                ✕ Cancelar
              </button>
            )}
            <p className="lobby-create-room-title">Você ainda não tem uma sala</p>
            {!accountAccessToken ? (
              <p className="lobby-create-room-hint">Crie uma conta pra ganhar a sua.</p>
            ) : !newRoomNameConfirmed ? (
              // 30/set, pedido do Douglas ("estou falando desse card" +
              // "deixa ele aberto ja"): o nome (e o resto: logo/banner/
              // bio/etc.) não é digitado num campo solto aqui dentro --
              // é digitado direto no painel de edição do card fixado
              // do lado, que fica ABERTO nesse momento (ver
              // .company-edit-panel/showCreateRoomFlow mais abaixo),
              // esse trecho só confirma o passo antes de revelar o
              // catálogo.
              <>
                <p className="lobby-create-room-hint">
                  Preencha o nome da sua empresa no card fixado do lado -- ele já nasce junto com a sua sala.
                </p>
                <button
                  type="button"
                  className="lobby-create-room-company-btn"
                  disabled={!companyProfile.name.trim()}
                  onClick={() => setNewRoomNameConfirmed(true)}
                >
                  Continuar
                </button>
              </>
            ) : templates === null ? (
              <p className="lobby-create-room-hint">Carregando modelos…</p>
            ) : templates.length === 0 ? (
              <p className="lobby-create-room-hint">Nenhum modelo publicado ainda.</p>
            ) : (
              <>
                <p className="lobby-create-room-hint">
                  Escolha um modelo pra começar a sala de <strong>{companyProfile.name.trim()}</strong>:
                </p>
                <div className="lobby-create-room-templates">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="lobby-create-room-template-btn"
                      disabled={creatingFromTemplateId !== null}
                      onClick={() => handleCreateRoomFromTemplate(t.id)}
                    >
                      {creatingFromTemplateId === t.id ? "Criando…" : t.name}
                    </button>
                  ))}
                </div>
                {createRoomError && <p className="lobby-create-room-error">{createRoomError}</p>}
                <button
                  type="button"
                  className="lobby-create-room-back-btn"
                  onClick={() => setNewRoomNameConfirmed(false)}
                >
                  ← Trocar nome da empresa
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <RoomPreview room={room} loading={roomLoading} />

            <p className="lobby-presence">
              <span className={`lobby-presence-dot${presence && presence.totalOnline > 0 ? " lobby-presence-dot-active" : ""}`} />
              {presenceText}
            </p>

            <button type="button" className="lobby-enter-btn" onClick={handleEnter} disabled={!selectedRoomSlug}>
              Entrar na sala
              <ChevronRightIcon />
            </button>

            {/* só aparece com a sala PRÓPRIA selecionada (ver
                handleCopyRoomLink acima) -- é o link que qualquer amigo
                pode abrir pra entrar direto nela e virar um atalho em
                "Espaços visitados" (pedido do Douglas, 29/set). */}
            {myRoom && selectedRoomSlug === myRoom.room_slug && (
              <button type="button" className="lobby-copy-link-btn" onClick={handleCopyRoomLink}>
                {linkCopied ? "Link copiado!" : "Copiar link pra convidar"}
              </button>
            )}
          </>
        )}
        {/* pedido do Douglas, 30/set (9): "coloque o sair da conta
            dentro das opcoes que abrem clicando no balao foto+nome,
            por ultimo, e em texto vermelho" -- morava aqui, solto,
            agora é o último item do menu do <AccountCard /> acima (ver
            comentário grande lá). */}
      </div>
      )}

      {/* pedido do Douglas (28/set, com print da av-bar de dentro da
          sala): "quero em balao assim, no canto esquerdo mesmo lugar
          que esta" -- MESMA classe .av-bar (pilula de vidro fosco,
          canto inferior esquerdo) que a barra de dentro da sala usa,
          não uma cópia -- fica igual de verdade, não só parecido. Fora
          do .lobby-card de propósito (esse aqui é "absolute" relativo
          à tela inteira, igual dentro da sala; dentro do card ficaria
          preso ao centro). */}
      {/* 29/set (2): "lobby-av-bar-light" só existe pra clarear essa
          barra aqui do Lobby (ver comentário grande em .av-bar.lobby-av-bar-light
          em globals.css) -- a classe base .av-bar continua igual pra
          quando essa mesma barra aparece de dentro da sala de verdade. */}
      <div className="av-bar lobby-av-bar-light">
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
            {totalUnreadMessages > 0 && <span className="lobby-icon-badge">{totalUnreadMessages}</span>}
          </span>
        </button>
        <button
          type="button"
          className={chat.agendaOpen ? "av-btn on" : "av-btn"}
          onClick={() => chat.setAgendaOpen((v) => !v)}
          aria-label={chat.agendaOpen ? "Fechar agenda" : "Abrir agenda"}
          data-tooltip={chat.agendaOpen ? "Fechar agenda" : "Agenda"}
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
          aria-label={contactsOpen ? "Fechar amigos" : "Abrir amigos"}
          data-tooltip={contactsOpen ? "Fechar amigos" : "Amigos"}
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
          spaceVolume={spaceVolume}
          onChangeSpaceVolume={setSpaceVolume}
          remoteUsers={[]}
          remoteVolumes={{}}
          onChangeRemoteVolume={() => {}}
          callVolume={callVolume}
          onChangeCallVolume={setCallVolume}
          notificationPrefs={notificationPrefs}
          onChangeNotificationPrefs={setNotificationPrefs}
        />
      )}

      {chatPanelOpen && (
        <LobbyChatPanel
          pinMode={chatPinMode}
          onToggleSidePin={toggleLobbyChatPinSide}
          myUserId={myUserId}
          myRoomName={myRealRoom?.name ?? null}
          myRoomLogoUrl={myRoomLogoUrl}
          accountAccessToken={accountAccessToken}
          callVolume={callVolume}
          camOn={camOn}
          onClose={() => setChatPanelOpen(false)}
          chat={chat}
        />
      )}
      {contactsOpen && (
        <FriendsPanel
          accountAccessToken={accountAccessToken}
          onStartConversation={(targetUserId) => handleStartConversation(targetUserId)}
          onClose={() => setContactsOpen(false)}
        />
      )}
      {/* clique numa foto de founder no card da empresa (ver
          viewingFounderUserId/company-card-founders acima) -- pedido
          do Douglas, 30/set (13): "link clicavel pro perfil pessoal". */}
      {viewingFounderUserId && accountAccessToken && (
        <ProfileViewCard
          userId={viewingFounderUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setViewingFounderUserId(null)}
          onStartConversation={(targetUserId) => {
            setViewingFounderUserId(null);
            handleStartConversation(targetUserId);
          }}
        />
      )}
    </div>
  );
}
