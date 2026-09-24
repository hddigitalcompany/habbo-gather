"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import PartySocket from "partysocket";
import MainScene, {
  DEFAULT_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  skinTextureKey,
  hairTextureKey,
  accessoryTextureKey,
  beardTextureKey,
  outfitTextureKey,
} from "@/game/MainScene";
import { createGameConfig } from "@/game/config";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import RoomMembersPanel from "@/components/RoomMembersPanel";
import ItemEditor from "@/components/ItemEditor";
import SettingsPanel from "@/components/SettingsPanel";
import {
  catalogEntryGroupKey,
  catalogIndicesForGroup,
  CUSTOM_ITEM_CATEGORY_TYPE,
  FURNITURE_CATALOG,
  FURNITURE_COLORS,
  FURNITURE_ROTATE_ORDER,
  FURNITURE_TYPE_CATEGORY,
  furnitureArtFile,
  furnitureColorArtFile,
  furnitureModelById,
  furnitureVariantTextureKey,
  registerCustomFurnitureModels,
  FurnitureCategoryId,
  FurnitureCatalogEntry,
  FurnitureDef,
  FurnitureModelDef,
  FurnitureSeatOffsetsMap,
  SeatTuningInfo,
} from "@/game/furniture";
import { FLOOR_CATALOG, FloorCatalogEntry, FloorTileDef } from "@/game/floor";
import type { Direction } from "@/game/grid";
import { AREA_TYPES, AreaDef, AreaTileDef, AreaType } from "@/game/areas";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  SKIN_CATALOG,
  DEFAULT_SKIN_ID,
  BEARD_CATALOG,
  DEFAULT_BEARD_ID,
  beardFileForSkin,
  ACCESSORY_CATALOG,
  DEFAULT_ACCESSORY_ID,
  OUTFIT_CATALOG,
  DEFAULT_OUTFIT_ID,
  outfitFileForSkin,
  CUSTOMIZATION_CATEGORIES,
  CustomizationCategoryId,
  AvatarGender,
  SkinOption,
  registerCustomSkins,
  HairOption,
  AccessoryOption,
  BeardOption,
  OutfitOption,
  registerCustomHair,
  registerCustomAccessories,
  registerCustomBeards,
  registerCustomOutfits,
} from "@/game/customization";

// "focus/ausente/online" -- ver caixinha de status no ProfileCard.
type ProfileStatus = "online" | "away" | "focus";

// campos do card de perfil que o PRÓPRIO jogador edita (ver ProfileCard)
// -- "role" fica de fora de propósito, é osó campo que o server atribui
// (ver PROFILE_ROLE_PLACEHOLDER em server/index.js), não tem edição aqui.
type ProfileFields = {
  name: string;
  status: ProfileStatus;
  instagram: string;
  bio: string;
  photoUrl: string;
};

// props que vêm do AuthGate (ver components/AuthGate.tsx e app/page.tsx)
// -- TODAS opcionais/com default null, pra continuar funcionando 100%
// igual (visitante anônimo por localStorage) se algum dia GameRoom for
// renderizado sem passar por ele. accountProfile é estruturalmente
// igual a ProfileFields (mesmos campos) de propósito, pra dar pra
// mesclar direto sem conversão.
type GameRoomProps = {
  accountUserId?: string | null;
  accountProfile?: Partial<ProfileFields> | null;
  accountAccessToken?: string | null;
  onSignOut?: (() => void) | null;
};

type RemoteProfile = ProfileFields & { role: string };

// cor da bolinha de status -- usada tanto no card de perfil (ver
// STATUS_OPTIONS mais abaixo) quanto no nome do boneco DENTRO do jogo
// (ver MainScene.setNameplate/setLocalProfile/upsertRemotePlayer) -- um
// lugar só pra não desalinhar as duas pontas.
const STATUS_DOT_COLORS: Record<ProfileStatus, string> = {
  online: "#4fd97a",
  away: "#9a9aa5",
  focus: "#f5c542",
};

function statusColorFor(status: string | undefined): string {
  return STATUS_DOT_COLORS[(status as ProfileStatus) ?? "online"] ?? STATUS_DOT_COLORS.online;
}

// traje inicial do boneco ao entrar na sala (ver useState(selectedOutfitId)
// mais abaixo) -- sorteia entre os trajes DE VERDADE do catálogo,
// excluindo "nenhum" (esse continua escolhível à mão no editor, só não
// faz mais sentido como padrão do spawn, ver comentário lá). Sem
// nenhum traje de verdade cadastrado ainda (catálogo vazio, só
// "nenhum"), cai pra DEFAULT_OUTFIT_ID mesmo (hoje sempre "nenhum",
// primeira entrada do catálogo).
function pickRandomOutfitId(): string {
  const real = OUTFIT_CATALOG.filter((o) => o.id !== "nenhum");
  if (real.length === 0) return DEFAULT_OUTFIT_ID;
  return real[Math.floor(Math.random() * real.length)].id;
}

// userId = identidade PERSISTENTE (ver getOrCreateUserId), diferente do
// "id" de conexão (novo a cada reconexão) -- é o que o chat direto/
// grupo usa pra saber quem é quem entre uma visita e outra (ver
// comentário grande em server/index.js).
// seatFurnitureId: móvel em que essa pessoa tá sentada agora, ou null/
// undefined se tá de pé -- vem do server (ver "seat" no protocolo de
// server/index.js), guardado igual x/y (ver checkProximity/handlePartyMessage
// mais abaixo, que repassam pra dentro da cena via scene.setRemoteSeat).
type RemotePlayer = { id: string; userId: string; x: number; y: number; color: string; seatFurnitureId?: string | null } & RemoteProfile;
type Toast = { id: string; text: string };

// --- chat de verdade (direta/grupo/histórico/anexos) -- ver comentário
// grande no topo de server/index.js e server/chatStore.js pro protocolo
// e a persistência. O chat de SALA (chatLog/chatInput/sendChat) usa o
// MESMO formato de mensagem (ChatMsgBase, com foto/arquivo/áudio) mas
// não fica salvo em disco -- ver o case "chat" em server/index.js --
// então "Sala" aparece junto na mesma gaveta (ver ChatDrawer) como só
// mais uma entrada na lista de conversas, mesmo não sendo uma de
// verdade (não tem conversationId, ninguém precisa abrir histórico).
type ChatAttachmentKind = "image" | "file" | "audio";
type ChatAttachment = { url: string; name: string; size: number; mime: string };
type ChatMsgKind = "text" | ChatAttachmentKind;
type ChatMsgBase = {
  id: string;
  senderId: string;
  senderName: string;
  kind: ChatMsgKind;
  text: string;
  attachment: ChatAttachment | null;
  ts: number;
  // true quando alguém apagou essa mensagem ("apaga pra todos") -- o
  // texto/anexo original já vem vazio do servidor nesse caso, o bubble
  // mostra só a tarja "Fulano apagou uma mensagem" (ver ChatMessageRow).
  deleted?: boolean;
};
type ChatMsg = ChatMsgBase & { conversationId: string };
// mensagem da SALA -- mesmo formato, sem conversationId (ver comentário acima)
type ChatMessage = ChatMsgBase;
type ConversationParticipant = { id: string; name: string; color: string; photoUrl: string };
type Conversation = {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  participantIds: string[];
  participants: ConversationParticipant[]; // só os OUTROS, sem mim
  updatedAt: number;
  lastMessage: { senderId: string; senderName: string; kind: ChatMsgKind; text: string; ts: number } | null;
};

// --- chamada de voz/vídeo de uma conversa (chat direto/grupo, "tipo
// discord") -- ver comentário grande em server/index.js (call:join/
// call:leave/call:state). connectionId é o que endereça o mesh de
// WebRTC (ver callPeersRef em GameRoom), userId/name/color/photoUrl são
// só pra desenhar (quem já tá dentro, o botão verde na lista, etc). ---
type ChatCallParticipant = { connectionId: string; userId: string; name: string; color: string; photoUrl: string };

// --- Agenda (marcar call: data/horário/participantes, necessidades de
// câmera/áudio/tela, aprovação dos convidados) -- ver comentário grande
// no topo de server/index.js e server/agendaStore.js pro protocolo e a
// persistência. Mora na MESMA gaveta de chat (ver ChatDrawer), como uma
// segunda aba (Conversas | Agenda). ---
type CallNeeds = { camera: boolean; audio: boolean; screen: boolean };
type CallParticipantStatus = "pending" | "approved" | "declined";
type CallParticipant = { id: string; name: string; color: string; status: CallParticipantStatus };
type CallVisibility = "public" | "private";
type CallEvent = {
  id: string;
  title: string;
  startTs: number;
  durationMinutes: number;
  needs: CallNeeds;
  createdBy: string;
  createdByName: string;
  participants: CallParticipant[];
  createdAt: number;
  // "public" (padrão) = quem pesquisar a agenda de um participante dessa
  // call vê o conteúdo; "private" = só ocupa o horário -- ver "redacted"
  // embaixo, o que chega pra quem NÃO participa de uma call privada.
  visibility: CallVisibility;
  // true só nas calls PRIVADAS de um colega que a gente pesquisou (ver
  // colleagueCalls/agenda:colleague_calls) e da qual a gente não
  // participa -- título/necessidades/participantes vêm vazios, só o
  // horário é real (ver redact() em server/agendaStore.js).
  redacted?: boolean;
  description: string;
  attachments: ChatAttachment[];
  // "travar agenda" (padrão true) = conta como ocupado pra quem tá nela
  // (ver getConflictingUserIds); false = "mostrar compromisso sem travar
  // agenda" -- ainda aparece na agenda, mas não bloqueia esse horário
  // pra outros compromissos.
  blocksAgenda: boolean;
};
// entrada da "lista de todo mundo cadastrado no ambiente" (ver allUsers/
// users:list) -- diferente de RemotePlayer, que só existe pra quem tá
// CONECTADO agora na sala; isso aqui vem do cadastro persistente do chat
// (server/chatStore.js), então inclui gente offline também.
type DirectoryUser = { userId: string; name: string; color: string; photoUrl: string };
// rascunho do formulário "Marcar call" -- fica num objeto só (em vez de
// um useState por campo) pra dar pra passar/atualizar de um jeito só
// pro ChatDrawer (ver onChangeAgendaForm).
type AgendaFormState = {
  title: string;
  date: string; // "AAAA-MM-DD", igual <input type="date">
  time: string; // "HH:MM", igual <input type="time">
  durationMinutes: number;
  participantIds: string[];
  needs: CallNeeds;
  visibility: CallVisibility;
  description: string;
  attachments: ChatAttachment[];
  blocksAgenda: boolean;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTimeStr(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Junta os campos separados de data/horário do formulário (horário
 * LOCAL do navegador, igual um <input type="datetime-local">) num
 * único epoch ms -- o que o servidor usa pra checar conflito e ordenar
 * (ver server/agendaStore.js). NaN se algum campo ainda tiver vazio. */
function combineLocalDateTime(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return NaN;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}
function formatCallDateTime(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Nome pra mostrar de uma conversa: nome do grupo se tiver, senão o
 * nome do outro participante (direta) -- usado na lista E no cabeçalho
 * da conversa aberta. */
function conversationDisplayName(conv: Conversation): string {
  if (conv.kind === "group") return conv.name || "Grupo sem nome";
  return conv.participants[0]?.name || "Sem nome";
}

/** Texto curto de preview pra lista de conversas -- mensagens com anexo
 * não têm texto (ou só uma legenda opcional), então mostra um rótulo
 * pelo tipo em vez de deixar a prévia em branco. */
function previewText(last: { kind: ChatMsgKind; text: string }): string {
  if (last.kind === "text") return last.text;
  if (last.kind === "image") return "📷 Foto";
  if (last.kind === "audio") return "🎤 Áudio";
  return "📎 Arquivo";
}

// extrai só os campos de perfil de um objeto maior (player do socket,
// ou um remoteProfiles[id] anterior mesclado com um update parcial) --
// sempre com fallback, pra nunca quebrar o card se algum campo não
// tiver chegado ainda.
function pickRemoteProfile(p: Partial<RemotePlayer> | undefined): RemoteProfile {
  return {
    name: p?.name ?? "",
    status: (p?.status as ProfileStatus) ?? "online",
    instagram: p?.instagram ?? "",
    bio: p?.bio ?? "",
    photoUrl: p?.photoUrl ?? "",
    role: p?.role ?? "",
  };
}

const PROFILE_STORAGE_KEY = "habbo-gather-profile";

function loadSavedProfile(): Partial<ProfileFields> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// APARÊNCIA do boneco (cabelo/cor do cabelo/tom de pele/barba/acessório/
// cor do acessório/traje) -- bug reportado pelo Douglas: "o avatar não
// tá salvando as edições que eu faço quando atualizo a página". Causa:
// esses campos SÓ viviam em estado do React (selectedHairId etc.),
// nunca eram persistidos em lugar nenhum -- diferente do resto do card
// de perfil (nome/status/bio/insta/foto), que já salva sozinho no
// localStorage (ver PROFILE_STORAGE_KEY/loadSavedProfile acima) desde
// sempre. Mesmo esquema aqui: chave própria, lida uma vez pro estado
// inicial (useState) e regravada em saveEditingCharacter() (ver mais
// embaixo) toda vez que a pessoa clica "Salvar" no editor de
// personagem.
const AVATAR_STORAGE_KEY = "habbo-gather-avatar";

type SavedAvatar = {
  hairId?: string;
  hairColorId?: string | null;
  skinId?: string;
  gender?: AvatarGender;
  beardId?: string;
  accessoryId?: string;
  accessoryColorId?: string | null;
  outfitId?: string;
};

// arte de item custom (móvel OU tom de pele -- ver `custom` em
// FurnitureModelDef/SkinOption) vem de dois lugares bem diferentes: um
// arquivo "de fábrica" em public/assets/ (gerado da pasta local -- só o
// NOME do arquivo, precisa do prefixo "/assets/" pra virar um caminho de
// verdade) ou uma URL PÚBLICA COMPLETA do Supabase Storage (cadastrado
// pelo Editor de Itens -- ver registerCustomFurnitureModels/
// registerCustomSkins) -- essa já é a URL inteira, prefixar "/assets/"
// na frente dela vira um caminho relativo que não existe em lugar
// nenhum ("/assets/https://..."), quebrando a miniatura/preview de
// QUALQUER item custom. Esse helper decide certo pros dois casos --
// usado em todo lugar que pode renderizar arte custom (palette-btn/
// item-preview-img/color-swatch em EditPanel, preview de tom de pele em
// ProfileCard).
function furnitureAssetUrl(file: string): string {
  return file.startsWith("http") ? file : `/assets/${file}`;
}

function loadSavedAvatar(): SavedAvatar {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// identidade PERSISTENTE do chat -- NÃO é login de verdade, só um id
// salvo no localStorage do navegador (igual o profile acima), gerado
// uma vez e reusado pra sempre NESSE navegador. É o que faz o
// histórico de conversa direta/grupo sobreviver a um F5 -- sem isso,
// cada reconexão pro servidor pareceria uma pessoa nova (ver "userId"
// vs "id" de conexão no comentário grande em server/index.js).
const USER_ID_STORAGE_KEY = "habbo-gather-user-id";
// lembrar se a gaveta de chat tá "fixada" como barra lateral (ver estado
// chatPinMode em GameRoom) -- só "float" (flutuando, padrão) ou "side"
// (barra lateral). Formato antigo guardava só "1"/"0", migrado na
// leitura (ver parsePinMode), não precisa de helper de escrita, lê/grava
// direto onde é usado.
const CHAT_PINNED_STORAGE_KEY = "habbo-gather-chat-pinned";
type PinMode = "float" | "side";
function parsePinMode(raw: string | null): PinMode {
  if (raw === "side" || raw === "1") return "side"; // "1" = formato antigo
  return "float";
}

function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(USER_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// redimensiona/comprime a foto ANTES de mandar -- vai como data-URL pela
// mesma conexão de posição/chat (ver server/index.js, MAX_MESSAGE_BYTES),
// então precisa ficar pequena. Recorta um quadrado central e reamostra
// pra no máx 240x240, exporta como JPEG ~80% (suficiente pra uma foto de
// perfil pequena, bem abaixo do limite do servidor).
function compressPhotoToDataUrl(file: File): Promise<string> {
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
        const target = Math.min(240, size);
        const canvas = document.createElement("canvas");
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, sx, sy, size, size, 0, 0, target, target);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// distância (em pixels) pra ligar e desligar o vídeo/áudio — com uma
// pequena "zona morta" entre os dois valores pra não ficar oscilando
const PROXIMITY_CONNECT = 160;
const PROXIMITY_DISCONNECT = 220;

// passo do zoom pela roda do mouse/trackpad (ver handleWheelZoom acima
// de handleRecenterCamera) -- menor que o ZOOM_STEP dos botões "+"/"-"
// (0.25, ver MainScene.ts) porque a roda dispara MUITAS vezes em
// sequência num gesto só, um passo do mesmo tamanho dos botões deixaria
// o zoom "pulando" longe demais a cada tique.
const WHEEL_ZOOM_STEP = 0.12;

// era ferramenta só de DEV (gerava código pra colar à mão em
// furniture.ts/floor.ts, não salvava nada de verdade) -- hoje móveis E
// ajuste de assento SALVAM DE VERDADE (ver GET/POST /room/furniture
// acima), então esconder isso em produção sem exceção deixava até o
// DONO da sala sem conseguir editar o próprio espaço fora do `npm run
// dev` (bug provável por trás de "cliquei em editar espaço e não abriu
// a aba dos móveis" -- ver canEditRoom mais abaixo, que agora libera
// pro dono também fora de dev). Continua ligado sozinho em dev (não
// depende de ser dono, facilita testar) e continua escondido pra
// membro/visitante em qualquer ambiente -- só o cliente final comum
// nunca vê isso, não o Douglas.
const IS_ROOM_EDITOR_ENABLED = process.env.NODE_ENV !== "production";

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
// mesmo host do WebSocket, só que em HTTP -- pro upload de foto/arquivo/
// áudio do chat (ver POST /upload em server/index.js) e pra montar a URL
// completa de um anexo já enviado (o servidor manda só o caminho
// relativo, tipo "/uploads/xxx", ver ChatAttachment).
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
  `://${REALTIME_HOST}`;

function attachmentUrl(path: string): string {
  return path.startsWith("http") ? path : `${REALTIME_HTTP_BASE}${path}`;
}

function formatFileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// "0:07", "1:23" etc -- usado no contador de gravação de áudio (ver
// recordingElapsedSec) e no preview antes de mandar.
function formatRecordingTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad2(s)}`;
}

// tenta mimeTypes em ordem de preferência -- nem todo navegador aceita
// "audio/webm;codecs=opus" (ex: Safari), então cai pro próximo que o
// MediaRecorder confirmar que suporta; undefined = deixa o navegador
// escolher sozinho (fallback do próprio construtor).
function pickSupportedAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

// "25/set", "26/set" -- ver o "strip" de dias da Minha Agenda.
const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
function dayChipLabel(dateKey: string, todayKey: string, tomorrowKey: string): string {
  if (dateKey === todayKey) return "Hoje";
  if (dateKey === tomorrowKey) return "Amanhã";
  const [, m, d] = dateKey.split("-").map(Number);
  return `${pad2(d)}/${MESES_ABREV[(m - 1 + 12) % 12]}`;
}

/** Manda o arquivo pro servidor (bytes crus no corpo, ver POST /upload
 * em server/index.js -- nada de multipart, mais simples dos dois
 * lados) e devolve a URL/nome/tamanho/mime já prontos pra entrar numa
 * mensagem de chat como anexo. */
async function uploadChatFile(file: Blob, filename: string): Promise<ChatAttachment> {
  const res = await fetch(`${REALTIME_HTTP_BASE}/upload?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": (file as File).type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`upload falhou (${res.status})`);
  return (await res.json()) as ChatAttachment;
}

export default function GameRoom({
  accountUserId = null,
  accountProfile = null,
  accountAccessToken = null,
  onSignOut = null,
}: GameRoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<MainScene | null>(null);
  const socketRef = useRef<PartySocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remotePlayersRef = useRef<Map<string, RemotePlayer>>(new Map());
  const connectedPeersRef = useRef<Set<string>>(new Set());
  const selfIdRef = useRef<string>("");
  // mesh PARALELO da chamada de chat (ver comentário grande na função
  // sendCallSignal lá embaixo) -- connectionId -> RTCPeerConnection,
  // igual peersRef mas só entre quem tá NA MESMA chamada, não por
  // proximidade. myCallConversationIdRef espelha o estado
  // myCallConversationId (ver embaixo) pra ler o valor atual de DENTRO
  // do efeito de conexão (que só roda uma vez, ver useEffect com
  // handlePartyMessage) sem cair em stale closure -- mesmo padrão já
  // usado pra agendaColleagueIdRef/myProfileRef.
  const callPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const myCallConversationIdRef = useRef<string | null>(null);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);

  // --- Configurações (ver SettingsPanel/botão de engrenagem na av-bar)
  // -- deviceId ESCOLHIDO de cada aparelho ("" = padrão do navegador,
  // não mexeu ainda), e o volume: "som do espaço" é um multiplicador
  // GERAL (afeta todo mundo de uma vez, pedido do Douglas), remoteVolumes
  // é o ajuste fino POR PESSOA (id de dentro de remoteStreams -> 0..1)
  // -- os dois se multiplicam na hora de aplicar (ver RemoteVideoTile
  // mais abaixo). Nenhum dos dois persiste entre sessões por enquanto
  // (reseta ao recarregar a página).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState("");
  const [selectedCamId, setSelectedCamId] = useState("");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [spaceVolume, setSpaceVolume] = useState(1);
  const [remoteVolumes, setRemoteVolumes] = useState<Record<string, number>>({});

  const [status, setStatus] = useState("Conectando...");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteMeta, setRemoteMeta] = useState<
    Record<string, { name: string; distance: number }>
  >({});
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);

  // --- chat de verdade (direta/grupo/histórico/anexo) -- ver os tipos
  // Conversation/ChatMsg lá em cima e o comentário grande em
  // server/index.js. myUserId é estável (localStorage), calculado uma
  // vez só (useMemo com deps vazias). activeConversationId===null
  // representa a pseudo-conversa "Sala" (o chatLog/chatInput de cima,
  // sem histórico/anexo -- ver comentário em ChatDrawer). ---
  // accountUserId (ver AuthGate.tsx) tem prioridade sobre o id gerado
  // sozinho no localStorage -- quem loga com conta de verdade usa o id
  // do Supabase (auth.users.id), confirmável pelo servidor (ver
  // server/roomAuth.js); quem entra sem conta (Supabase não
  // configurado, ou clicou "Continuar como visitante") segue no mesmo
  // fluxo anônimo de sempre.
  const myUserId = useMemo(() => accountUserId || getOrCreateUserId(), [accountUserId]);
  // ref pro token de acesso ATUAL (renovado sozinho pelo Supabase de
  // tempos em tempos, ver onAuthStateChange em AuthGate.tsx -- por
  // isso é ref e não só a prop direto: o handler de "identify" abaixo
  // roda dentro de um useEffect que conecta UMA VEZ só, precisa ler o
  // valor mais novo sem depender de re-executar o efeito inteiro,
  // mesmo motivo de myProfileRef.current logo abaixo).
  const accountAccessTokenRef = useRef(accountAccessToken);
  accountAccessTokenRef.current = accountAccessToken;
  const [chatOpen, setChatOpen] = useState(false);
  const [chatView, setChatView] = useState<"list" | "thread" | "new">("list");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMsg[]>>({});
  // chamada de voz/vídeo de uma conversa ("tipo discord") -- ver o tipo
  // ChatCallParticipant lá em cima e o mesh em callPeersRef/
  // sendCallSignal. callParticipantsByConversation cobre TODAS as
  // conversas (é o que acende o botão verde de quem ainda não entrou);
  // myCallConversationId é só a MINHA (não dá pra estar em duas ao mesmo
  // tempo -- entrar numa nova sai da anterior sozinho, ver joinCall).
  const [callParticipantsByConversation, setCallParticipantsByConversation] = useState<
    Record<string, ChatCallParticipant[]>
  >({});
  const [myCallConversationId, setMyCallConversationId] = useState<string | null>(null);
  myCallConversationIdRef.current = myCallConversationId;
  const [callRemoteStreams, setCallRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [chatComposerText, setChatComposerText] = useState("");
  const [newConvSelection, setNewConvSelection] = useState<string[]>([]);
  const [newConvName, setNewConvName] = useState("");
  const [renamingGroup, setRenamingGroup] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [recordingAudio, setRecordingAudio] = useState(false);
  // contador ao vivo (segundos) enquanto tá gravando, e o áudio já
  // parado esperando confirmação de envio (igual WhatsApp: grava, mostra
  // o tempo, PARA, e só manda quando a pessoa confirma) -- ver
  // startVoiceRecording/stopVoiceRecording/sendRecordedAudio.
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordedPreview, setRecordedPreview] = useState<{ url: string; durationSec: number } | null>(null);
  const [sendingAttachment, setSendingAttachment] = useState(false);
  // "fixar" a gaveta de chat como barra lateral fixa (esquerda), em vez
  // de flutuar sobre o jogo -- lembrado entre visitas (localStorage),
  // igual o profile. Ver render lá embaixo: quando fixo, o ChatDrawer
  // entra como IRMÃO do .room-wrapper (antes dele, pra ficar à
  // esquerda), não mais como overlay por cima do jogo.
  const [chatPinMode, setChatPinMode] = useState<PinMode>(() => {
    if (typeof window === "undefined") return "float";
    try {
      return parsePinMode(window.localStorage.getItem(CHAT_PINNED_STORAGE_KEY));
    } catch {
      return "float";
    }
  });
  const autoOpenNextConversationRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBlobRef = useRef<Blob | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef(0);
  // true só quando a pessoa CANCELOU a gravação em andamento (lixeira
  // durante a gravação) -- o onstop do MediaRecorder dispara do mesmo
  // jeito nesse caso, essa ref é o jeito dele saber que é pra descartar
  // em vez de virar preview (ver cancelVoiceRecording).
  const discardRecordingRef = useRef(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const agendaFileInputRef = useRef<HTMLInputElement>(null);
  const agendaDetailFileInputRef = useRef<HTMLInputElement>(null);

  // --- Agenda (ver tipos CallEvent/AgendaFormState lá em cima e o
  // comentário grande em server/index.js) -- gaveta PRÓPRIA, separada da
  // de chat (ver agendaOpen/AgendaDrawer), com seu próprio botão na
  // av-bar. ---
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [calls, setCalls] = useState<CallEvent[]>([]);
  // quem, dos candidatos a convidado, já tá ocupado no horário sendo
  // escolhido AGORA no formulário -- atualizado ao vivo (ver o useEffect
  // de "agenda:availability" mais abaixo), pra já desabilitar/marcar
  // "indisponível" na lista de participantes ANTES da pessoa tentar
  // selecionar (ver getConflictingUserIds em server/agendaStore.js).
  const [busyUserIds, setBusyUserIds] = useState<string[]>([]);
  const [agendaView, setAgendaView] = useState<"list" | "new" | "detail" | "colleague">("list");
  const [agendaDetailId, setAgendaDetailId] = useState<string | null>(null);
  const [agendaForm, setAgendaForm] = useState<AgendaFormState>({
    title: "",
    date: "",
    time: "",
    durationMinutes: 30,
    participantIds: [],
    needs: { camera: true, audio: true, screen: false },
    visibility: "public",
    description: "",
    attachments: [],
    blocksAgenda: true,
  });
  const [agendaError, setAgendaError] = useState<string | null>(null);
  const [sendingAgendaAttachment, setSendingAgendaAttachment] = useState(false);
  const [sendingDetailAttachment, setSendingDetailAttachment] = useState(false);
  // "hoje | amanhã | 25/set | ..." -- quais dias do strip da Minha
  // Agenda estão expandidos agora (ver renderAgendaListView). Hoje
  // começa aberto ("deve aparecer o hoje aberto").
  const [expandedAgendaDays, setExpandedAgendaDays] = useState<Set<string>>(() => new Set([localDateStr(new Date())]));
  // todo mundo já cadastrado no ambiente (ver server/chatStore.js
  // listAllUsers), online ou não -- usado no picker de participantes do
  // "Marcar compromisso" e na busca "pesquise a agenda de um colega",
  // que não devem mais depender de quem tá na sala AGORA (ver
  // users:list/handlePartyMessage).
  const [allUsers, setAllUsers] = useState<DirectoryUser[]>([]);
  const agendaCreatingRef = useRef(false);
  // "pesquise a agenda de um colega" -- campo de busca (filtrado no
  // ChatDrawer contra quem tá na sala, mesma fonte da lista de
  // participantes) + a agenda do colega escolhido, já vinda do servidor
  // (calls privadas em que eu não participo chegam tarjadas, ver
  // agenda:view_colleague em server/index.js).
  const [agendaSearchQuery, setAgendaSearchQuery] = useState("");
  const [agendaColleagueId, setAgendaColleagueId] = useState<string | null>(null);
  const [agendaColleagueName, setAgendaColleagueName] = useState("");
  const [colleagueCalls, setColleagueCalls] = useState<CallEvent[]>([]);
  // espelha agendaColleagueId pro handler de socket (definido dentro do
  // useEffect de conexão, que só roda uma vez -- ver comentário grande
  // em myProfileRef) conseguir ler o valor ATUAL sem stale closure.
  const agendaColleagueIdRef = useRef<string | null>(null);
  agendaColleagueIdRef.current = agendaColleagueId;

  // --- card de perfil: MEUS campos (editáveis) e os dos OUTROS
  // jogadores (sincronizados pelo servidor, ver mensagem "profile" em
  // server/index.js) -- persisto os meus no localStorage, então voltam
  // sozinhos na próxima visita, mas continuam só "meus" (não tem
  // login/conta de verdade aqui). ---
  const [myProfile, setMyProfile] = useState<ProfileFields>(() => ({
    name: "",
    status: "online",
    instagram: "",
    bio: "",
    photoUrl: "",
    ...loadSavedProfile(),
    // perfil da CONTA (ver AuthGate.tsx) tem a palavra final -- se
    // logou, é o que tá salvo no Supabase que manda, não o que
    // sobrou de um perfil anônimo antigo nesse navegador.
    ...(accountProfile ?? {}),
  }));
  const [remoteProfiles, setRemoteProfiles] = useState<Record<string, RemoteProfile>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const myProfileRef = useRef(myProfile);
  myProfileRef.current = myProfile;

  // toast de erro genérico -- usado nos pontos que antes falhavam
  // CALADOS (só um console.warn) pra ações como anexar arquivo/marcar
  // compromisso: "clica e não acontece nada" é o pior tipo de bug pra
  // reportar, então agora qualquer falha aparece na tela.
  function showErrorToast(text: string) {
    const toastId = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev.slice(-3), { id: toastId, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
  }

  // manda pelo socket SÓ se ele realmente tiver aberto -- antes um
  // socketRef.current?.send(...) com a conexão caída/reconectando (ex:
  // logo depois de um F5 ou de recarregar código em dev) não dava erro
  // nenhum, só não fazia nada: "clica e não acontece nada" em "Marcar
  // compromisso", mandar mensagem, etc. Agora pelo menos avisa.
  function wsSend(data: Record<string, unknown>): boolean {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showErrorToast("Sem conexão com o servidor agora -- espera reconectar e tenta de novo.");
      return false;
    }
    ws.send(JSON.stringify(data));
    return true;
  }

  // --- editor de espaço ("Editar espaço") -- modo dev: coloca/ajusta a
  // mobília ADICIONAL da sala e salva sozinho (ver GET/POST /room/furniture
  // em server/index.js), mesmo esquema autosave do piso/área logo abaixo.
  // Antes só gerava um código pra colar à mão em furniture.ts -- isso
  // não existe mais.
  const [editMode, setEditMode] = useState(false);
  // ferramentas "Apagar" e "Mover" do editor de espaço -- botões flutuantes
  // PRÓPRIOS, agrupados (ver .map-tool-group/.map-delete-btn/.map-move-btn
  // em globals.css), longe dos controles de zoom (pedido do Douglas),
  // disponíveis em QUALQUER aba de "Editar espaço" (nenhuma das duas é mais
  // uma aba de categoria dentro do painel -- "Mover" saiu de
  // EDIT_CATEGORY_TABS quando virou botão flutuante). "Apagar" ligada,
  // clicar num item já colocado apaga ele na hora (ver selectDeleteTool em
  // MainScene.ts) -- pedido do Douglas: apagar direto no espaço, não na
  // lista de linha do painel. "Mover" ligada, clicar num item já colocado
  // pega ele e um clique num tile livre solta ali (ver selectMoveTool em
  // MainScene.ts).
  const [deleteToolActive, setDeleteToolActive] = useState(false);
  const [moveToolActive, setMoveToolActive] = useState(false);

  // --- membro/visitante/dono da sala (ver supabase/migrations/0001_accounts.sql
  // e app/api/room/members) -- só quem tem conta (accountUserId, ver
  // AuthGate.tsx) tem um "role" de verdade; sem conta fica sempre
  // "visitor". roomRole decide se o botão de abrir o painel de
  // configuração aparece (só "owner"); presenceCounts é só decorativo
  // (contador na tela), aparece pra todo mundo. ---
  const [roomRole, setRoomRole] = useState<"owner" | "member" | "visitor">("visitor");
  // libera "Editar espaço" (ver IS_ROOM_EDITOR_ENABLED acima) sempre em
  // dev, e em qualquer ambiente pro DONO da sala -- membro/visitante
  // nunca, em lugar nenhum.
  const canEditRoom = IS_ROOM_EDITOR_ENABLED || roomRole === "owner";
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [presenceCounts, setPresenceCounts] = useState<{ memberCount: number; visitorCount: number } | null>(null);

  // --- Editor de Itens (móvel custom cadastrado pelo dono, ver
  // components/ItemEditor.tsx / supabase/migrations/0002_room_items.sql)
  // -- itemEditorOpen só abre pro "owner" (mesmo gate do painel de
  // membros). customItemsVersion não guarda nada -- só existe pra
  // FORÇAR o EditPanel a re-renderizar depois de registerCustomFurnitureModels
  // mutar FURNITURE_CATALOG por baixo (React não percebe sozinho que um
  // array importado mudou de conteúdo). ---
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [customItemsVersion, setCustomItemsVersion] = useState(0);
  // mesma ideia de customItemsVersion acima, só que pra tom de pele
  // CUSTOM (Editor de Itens, botão "Criar Avatar" -- ver
  // fetchAndRegisterCustomSkins/registerCustomSkins).
  const [customSkinsVersion, setCustomSkinsVersion] = useState(0);

  /**
   * Busca os itens custom no Supabase (leitura pública, ver policy em
   * supabase/migrations/0002_room_items.sql -- funciona sem login),
   * registra os modelos (registerCustomFurnitureModels, empurra pra
   * dentro de FURNITURE_MODELS/FURNITURE_CATALOG) e carrega a textura
   * de cada um na cena (loadCustomFurnitureTextures, ver
   * MainScene.ts). Chamado uma vez quando a cena fica pronta (ver
   * init() no useEffect do Phaser.Game) e de novo toda vez que o
   * Editor de Itens cadastra/EDITA/apaga algo (ver onItemsChanged no
   * ItemEditor renderizado mais abaixo) -- registerCustomFurnitureModels
   * agora faz UPSERT (ver comentário lá): item novo entra normal, item
   * EDITADO substitui o registro antigo -- só que a textura em cache e
   * os sprites já desenhados na tela não sabem disso sozinhos, por isso
   * os passos extra abaixo (removeFurnitureTextures/refreshFurnitureModel)
   * só pros ids que vieram como "atualizados".
   */
  async function fetchAndRegisterCustomFurniture(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("room_items")
        .select(
          "id, label, category, art, display_width, icon_url, offset_x, offset_y, direction_offsets, sittable, seat_offset_x, seat_offset_y"
        );
      if (error || !data || data.length === 0) return;
      const models: FurnitureModelDef[] = data.map(
        (row: {
          id: string;
          label: string;
          category: string;
          art: Partial<Record<Direction, string>>;
          display_width: number | null;
          icon_url: string | null;
          offset_x: number | null;
          offset_y: number | null;
          direction_offsets: Partial<Record<Direction, { x: number; y: number }>> | null;
          sittable: boolean | null;
          seat_offset_x: number | null;
          seat_offset_y: number | null;
        }) => ({
          id: row.id,
          type: CUSTOM_ITEM_CATEGORY_TYPE[row.category as FurnitureCategoryId] ?? "poltrona",
          label: row.label,
          colors: [{ id: "default", label: "Padrão", art: row.art }],
          // ajustado à mão no preview do Editor de Itens (ver
          // ItemEditor.tsx) -- null pra item cadastrado antes dessa
          // opção existir, cai no fallback por categoria (ver
          // addFurnitureSprite, MainScene.ts).
          displayWidth: typeof row.display_width === "number" ? row.display_width : undefined,
          iconUrl: row.icon_url ?? undefined,
          offsetX: row.offset_x ?? 0,
          offsetY: row.offset_y ?? 0,
          // "editar todos os lados" + "tem interação/posição sentado"
          // (pedido do Douglas) -- ver supabase/migrations/
          // 0007_room_items_direction_offsets_seat.sql.
          directionOffsets: row.direction_offsets ?? undefined,
          sittable: row.sittable ?? undefined,
          seatOffsetX: row.seat_offset_x ?? undefined,
          seatOffsetY: row.seat_offset_y ?? undefined,
        })
      );
      const updatedIds = registerCustomFurnitureModels(models);
      setCustomItemsVersion((v) => v + 1);
      const textureEntries: { key: string; url: string }[] = [];
      for (const model of models) {
        const color = model.colors[0];
        for (const facing of FURNITURE_ROTATE_ORDER) {
          const url = color.art[facing];
          if (!url) continue;
          const key = furnitureVariantTextureKey(model.id, color.id, facing);
          // item que já existia e mudou (ver "Editar" no Editor de
          // Itens) -- limpa a textura ANTIGA da cena antes de recarregar
          // com essa MESMA chave, senão loadCustomFurnitureTextures acha
          // que já tá carregada e ignora a arte nova.
          if (updatedIds.includes(model.id)) sceneRef.current?.removeFurnitureTextures([key]);
          textureEntries.push({ key, url });
        }
      }
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomFurnitureTextures(textureEntries, resolve);
        else resolve();
      });
      // recria na hora o sprite de todo item JÁ COLOCADO que usa um
      // modelo que acabou de ser editado -- sem isso, um item editado só
      // atualizaria visualmente (tamanho/arte/posição) depois de um F5.
      for (const modelId of updatedIds) sceneRef.current?.refreshFurnitureModel(modelId);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem item custom, sala funciona igual
    }
  }

  /**
   * Mesmo esquema de fetchAndRegisterCustomFurniture acima, só que pra
   * TOM DE PELE custom (Editor de Itens, botão "Criar Avatar" -- ver
   * supabase/migrations/0005_avatar_skins.sql, RODA JUNTO com a pasta
   * local, pedido do Douglas). Chamado nos mesmos lugares (scene-ready +
   * onItemsChanged do ItemEditor). Sem "editar tom" ainda (só criar,
   * diferente do móvel) -- um tom novo não tem sprite já desenhado com
   * arte antiga pra atualizar, então não precisa de um
   * refreshFurnitureModel-equivalente aqui.
   */
  async function fetchAndRegisterCustomSkins(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase.from("avatar_skins").select("id, label, gender, sheet_url, hex");
      if (error || !data || data.length === 0) return;
      const skins: SkinOption[] = data.map(
        (row: { id: string; label: string; gender: string; sheet_url: string; hex: string | null }) => ({
          id: row.id,
          label: row.label,
          file: row.sheet_url,
          gender: row.gender === "feminino" ? "feminino" : "masculino",
          hex: row.hex ?? undefined,
        })
      );
      registerCustomSkins(skins);
      setCustomSkinsVersion((v) => v + 1);
      const textureEntries = skins.map((skin) => ({ key: skinTextureKey(skin.id), url: skin.file }));
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomAvatarLayerTextures(textureEntries, resolve);
        else resolve();
      });
    } catch {
      // Supabase fora do ar/não configurado -- segue sem tom custom, sala funciona igual
    }
  }

  /**
   * Mesmo esquema de fetchAndRegisterCustomSkins acima, só que pras
   * OUTRAS camadas do avatar -- cabelo, acessório, barba e traje (Editor
   * de Itens, botão "Criar Avatar" > categoria correspondente, ver
   * AvatarCreatorPanel em components/ItemEditor.tsx e
   * supabase/migrations/0006_avatar_items.sql). Uma linha da tabela
   * "avatar_items" vira um item novo no catálogo certo (cabelo/
   * acessório: `file` único, sem tom -- barba/traje: `bySkin` com UM
   * tom por id em `skin_ids`, todos apontando pra MESMA folha, pedido do
   * Douglas: "podendo selecionar todos"). RODA JUNTO com a pasta local,
   * chamado nos mesmos lugares (scene-ready + onItemsChanged do
   * ItemEditor).
   */
  async function fetchAndRegisterCustomAvatarItems(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("avatar_items")
        .select("id, category, gender, label, skin_ids, sheet_url");
      if (error || !data || data.length === 0) return;

      type AvatarItemRow = {
        id: string;
        category: string;
        gender: string;
        label: string;
        skin_ids: string[] | null;
        sheet_url: string;
      };
      const rows = data as AvatarItemRow[];
      const textureEntries: { key: string; url: string }[] = [];

      const hairRows = rows.filter((r) => r.category === "cabelo");
      if (hairRows.length > 0) {
        const items: HairOption[] = hairRows.map((r) => ({ id: r.id, label: r.label, file: r.sheet_url }));
        registerCustomHair(items);
        for (const item of items) textureEntries.push({ key: hairTextureKey(item.id), url: item.file });
      }

      const accessoryRows = rows.filter((r) => r.category === "acessorio");
      if (accessoryRows.length > 0) {
        const items: AccessoryOption[] = accessoryRows.map((r) => ({ id: r.id, label: r.label, file: r.sheet_url }));
        registerCustomAccessories(items);
        for (const item of items) textureEntries.push({ key: accessoryTextureKey(item.id), url: item.file });
      }

      const beardRows = rows.filter((r) => r.category === "barba");
      if (beardRows.length > 0) {
        const items: BeardOption[] = beardRows.map((r) => ({
          id: r.id,
          label: r.label,
          bySkin: Object.fromEntries((r.skin_ids ?? []).map((skinId) => [skinId, r.sheet_url])),
        }));
        registerCustomBeards(items);
        for (const item of items) {
          for (const skinId of Object.keys(item.bySkin)) {
            textureEntries.push({ key: beardTextureKey(item.id, skinId), url: item.bySkin[skinId]! });
          }
        }
      }

      const outfitRows = rows.filter((r) => r.category === "traje");
      if (outfitRows.length > 0) {
        const items: OutfitOption[] = outfitRows.map((r) => ({
          id: r.id,
          label: r.label,
          bySkin: Object.fromEntries((r.skin_ids ?? []).map((skinId) => [skinId, r.sheet_url])),
        }));
        registerCustomOutfits(items);
        for (const item of items) {
          for (const skinId of Object.keys(item.bySkin)) {
            textureEntries.push({ key: outfitTextureKey(item.id, skinId), url: item.bySkin[skinId]! });
          }
        }
      }

      setCustomSkinsVersion((v) => v + 1);
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomAvatarLayerTextures(textureEntries, resolve);
        else resolve();
      });
    } catch {
      // Supabase fora do ar/não configurado (ou migration 0006 ainda não
      // rodada) -- segue sem esses itens custom, sala funciona igual
    }
  }

  useEffect(() => {
    if (!accountAccessToken) return;
    let cancelled = false;
    fetch("/api/room/members", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && (data.role === "owner" || data.role === "member" || data.role === "visitor")) {
          setRoomRole(data.role);
        }
      })
      .catch(() => {
        // sem Supabase configurado, ou rota fora do ar -- fica "visitor" mesmo, não é crítico
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // contador de membro/visitante ONLINE -- reaproveita GET
  // /room/presence do servidor WebSocket (ver handleGetPresence em
  // server/index.js), que já sabe quem tá conectado AGORA; polling
  // simples (10s) em vez de mais um tipo de mensagem no protocolo do
  // WS só pra isso.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`${REALTIME_HTTP_BASE}/room/presence`);
        const data = await res.json();
        if (!cancelled && res.ok) setPresenceCounts({ memberCount: data.memberCount, visitorCount: data.visitorCount });
      } catch {
        // servidor fora do ar/offline -- deixa o contador como tava, sem quebrar a UI
      }
    }
    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  const [selectedCatalogIndex, setSelectedCatalogIndex] = useState<number | null>(null);
  // cor escolhida NA HORA pro item selecionado (ver selectFurnitureColor)
  // -- separado da cor default de FURNITURE_CATALOG[selectedCatalogIndex]
  // pra sobreviver a um giro de direção (rotateSelected troca de índice
  // do catálogo, mas continua o MESMO modelo -- a cor escolhida não devia
  // resetar só por girar). Reseta pra null (cai na cor default do
  // modelo) toda vez que troca de MODELO de verdade, ver selectCatalog.
  const [selectedColorId, setSelectedColorId] = useState<string | null>(null);
  const [draftItems, setDraftItems] = useState<FurnitureDef[]>([]);
  const [furnitureSaveStatus, setFurnitureSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const furnitureLoadedRef = useRef(false);

  // --- ajuste de assento por MODELO ("Assento" na barra de categoria,
  // ver resolveSeatOffset em game/furniture.ts) -- seatOffsets é o mapa
  // completo (carregado JUNTO com a mobília, ver GET /room/furniture, e
  // salvo junto no mesmo autosave abaixo); seatTuningInfo é só o que
  // aparece no painel AGORA (null = não sentado/modo desligado, ver
  // onSeatTuningChange na cena).
  const [seatOffsets, setSeatOffsetsState] = useState<FurnitureSeatOffsetsMap>({});
  const [seatTuningInfo, setSeatTuningInfo] = useState<SeatTuningInfo | null>(null);

  // --- barra de categoria do editor de espaço -- um ícone por
  // categoria lá em cima (poltrona/sofá/mesa/planta/computador/
  // divisória/piso/área/assento, ver FURNITURE_CATEGORIES em
  // game/furniture.ts), igual ao padrão de referência que o Douglas
  // mandou. activeCategory escolhe qual grade aparece embaixo: "piso"
  // mostra TODOS os modelos de piso juntos (não separa mais por
  // porcelanato/laminado), "assento" é o ajuste de onde o boneco senta
  // (ver EDIT_CATEGORY_TABS/changeCategory), as outras filtram
  // FURNITURE_CATALOG pelo tipo/modelo de móvel daquela categoria (ver
  // FURNITURE_TYPE_CATEGORY). Sofá/mesa/planta/computador ainda não têm
  // nenhum FurnitureType/arte cadastrado -- aparecem na barra mas com a
  // grade vazia, até subir os arquivos de origem (combinado com o
  // Douglas: estrutura agora, arte depois).
  const [activeCategory, setActiveCategory] = useState<FurnitureCategoryId | "piso" | "area" | "assento">("poltrona");
  const [selectedFloorToolId, setSelectedFloorToolId] = useState<string | "erase" | null>(null);
  const [draftFloorItems, setDraftFloorItems] = useState<FloorTileDef[]>([]);
  const [floorSaveStatus, setFloorSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // true só depois que a busca inicial do piso salvo (GET /room/floor,
  // ver game.events.once(READY, ...) mais abaixo) terminar -- ver o
  // useEffect de autosave logo depois, que confere essa flag antes de
  // mandar qualquer POST.
  const floorLoadedRef = useRef(false);

  // --- área do editor de espaço (aba "Área", ver game/areas.ts) --
  // primeiro cria a área na LISTA (nome + tipo, ver createArea), DEPOIS
  // seleciona ela pra pintar (selectedAreaToolId: id da ÁREA armada pra
  // pintura, não mais um tipo fixo -- ou "erase"/null).
  const [selectedAreaToolId, setSelectedAreaToolId] = useState<string | "erase" | null>(null);
  const [draftAreaDefs, setDraftAreaDefs] = useState<AreaDef[]>([]);
  const [draftAreaItems, setDraftAreaItems] = useState<AreaTileDef[]>([]);
  const [areaSaveStatus, setAreaSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const areaLoadedRef = useRef(false);

  // --- controles de câmera do mapa ("estilo Gather" -- zoom +/- e
  // centralizar, ver MapControls logo abaixo) -- só espelha o zoom
  // atual da câmera (MainScene.zoomIn/zoomOut já limitam o valor, ver
  // MIN_ZOOM_LEVEL/MAX_ZOOM_LEVEL) pra desabilitar os botões no teto.
  const [mapZoom, setMapZoom] = useState(DEFAULT_ZOOM_LEVEL);
  function handleZoomIn() {
    const zoom = sceneRef.current?.zoomIn();
    if (zoom !== undefined) setMapZoom(zoom);
  }
  function handleZoomOut() {
    const zoom = sceneRef.current?.zoomOut();
    if (zoom !== undefined) setMapZoom(zoom);
  }
  function handleRecenterCamera() {
    sceneRef.current?.recenterCamera();
  }

  // roda do mouse E os dois dedos no trackpad também dão zoom no mapa,
  // não só os botões "+"/"-" do MapControls (pedido do Douglas: "afastar
  // tambem com dois dedos no scrol e de mouse tambem"). Ouve "wheel" no
  // DIV do canvas (containerRef -- os outros painéis/cards flutuantes
  // são elementos IRMÃOS dele, fora dessa div, então passar o mouse por
  // cima deles não aciona esse zoom). preventDefault trava o scroll/
  // zoom nativo da página enquanto o mouse tá sobre o jogo (senão o
  // gesto de "afastar" no trackpad tentaria dar zoom no navegador
  // inteiro, ou rolar uma página que nem existe aqui).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handleWheelZoom(e: WheelEvent) {
      e.preventDefault();
      const scene = sceneRef.current;
      if (!scene) return;
      // deltaY vem em unidades bem diferentes dependendo do dispositivo
      // (roda de mouse "clica" em ~100, trackpad manda valores pequenos
      // e contínuos a cada frame do gesto) -- limita o bruto antes de
      // escalar pro passo do zoom, senão uma rodada forte do mouse dava
      // um pulo grande demais de uma vez só.
      const clampedDelta = Math.max(-100, Math.min(100, e.deltaY));
      const step = -(clampedDelta / 100) * WHEEL_ZOOM_STEP;
      if (step === 0) return;
      const zoom = scene.zoomBy(step);
      setMapZoom(zoom);
    }
    el.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => el.removeEventListener("wheel", handleWheelZoom);
  }, []);

  // --- card de perfil / editor de personagem -- abre clicando em
  // QUALQUER avatar (ver onAvatarClick na MainScene); "editar
  // personagem" só aparece quando é o SEU (isLocal). Por enquanto só
  // cabelo é editável, escolha fica só nesta sessão (não sincroniza pra
  // outros jogadores nem salva -- ver HAIR_CATALOG). ---
  const [profileCard, setProfileCard] = useState<{
    playerId: string;
    isLocal: boolean;
  } | null>(null);
  const [editingCharacter, setEditingCharacter] = useState(false);
  // valores iniciais: o que ficou salvo da última vez (ver
  // AVATAR_STORAGE_KEY/loadSavedAvatar acima), com fallback pro padrão
  // de sempre quando não tem nada salvo ainda (primeira visita). Lazy
  // initializer (função, não valor direto) pra ler o localStorage só
  // uma vez na hora de montar -- mesmo motivo do pickRandomOutfitId
  // logo abaixo.
  const [selectedHairId, setSelectedHairId] = useState(() => loadSavedAvatar().hairId ?? DEFAULT_HAIR_ID);
  // cor escolhida DENTRO do penteado atual (ex: "Castanho"/"Loiro" de
  // "Cabelinho pra trás") -- não é um penteado novo, é uma variação de
  // arte do mesmo item (ver ColorOption em game/customization.ts). null
  // = nenhuma cor escolhida ainda, mostra a arte "padrão" do penteado
  // (opt.file). Reseta pra null toda vez que troca de PENTEADO (ver
  // selectHair) -- a cor é sempre relativa ao penteado selecionado.
  const [selectedHairColorId, setSelectedHairColorId] = useState<string | null>(
    () => loadSavedAvatar().hairColorId ?? null
  );
  // "sexo" do avatar (ver AvatarGender em game/customization.ts) --
  // botão Masculino/Feminino em cima do seletor de tom de pele (pedido
  // do Douglas), só filtra QUAIS tons aparecem ali embaixo (ver
  // SKIN_CATALOG.filter em ProfileCard) -- não mexe em cabelo/barba/
  // acessório/traje, que continuam com um catálogo só. Sem nada salvo
  // ainda, cai em "masculino" (mesmo comportamento de sempre, já que só
  // existia esse "sexo" implícito até agora).
  const [selectedGender, setSelectedGender] = useState<AvatarGender>(() => loadSavedAvatar().gender ?? "masculino");
  // tom de pele/corpo base (ver SKIN_CATALOG) -- selecionável no espaço
  // ao lado do boneco no topo do editor (ver AvatarPreviewWrap), não
  // dentro da grade de categorias.
  const [selectedSkinId, setSelectedSkinId] = useState(() => loadSavedAvatar().skinId ?? DEFAULT_SKIN_ID);
  // barba: sem cor manual (a arte já muda sozinha com o tom de pele
  // escolhido acima, mesmo esquema do traje -- ver beardFileForSkin).
  const [selectedBeardId, setSelectedBeardId] = useState(() => loadSavedAvatar().beardId ?? DEFAULT_BEARD_ID);
  // acessório: MESMO esquema do cabelo (id do item + cor opcional dentro
  // dele, ver comentário em selectedHairColorId acima).
  const [selectedAccessoryId, setSelectedAccessoryId] = useState(
    () => loadSavedAvatar().accessoryId ?? DEFAULT_ACCESSORY_ID
  );
  const [selectedAccessoryColorId, setSelectedAccessoryColorId] = useState<string | null>(
    () => loadSavedAvatar().accessoryColorId ?? null
  );
  // traje (roupa do pescoço pra baixo, ver OUTFIT_CATALOG) -- sem cor
  // manual (nenhum *ColorId), a arte já muda sozinha com o tom de pele
  // escolhido acima (ver outfitFileForSkin). Sem nada salvo ainda
  // (primeira visita), começa num traje ALEATÓRIO (ver
  // pickRandomOutfitId) em vez de "nenhum" -- desde que a camada base
  // virou só cabeça (ver scripts/syncSkinAssets.mjs), um boneco sem
  // traje ficaria sem corpo nenhum na sala; "Nenhum" continua
  // escolhível à mão no editor, só não é mais o padrão do primeiro
  // spawn. Lazy initializer pelo mesmo motivo dos campos acima.
  const [selectedOutfitId, setSelectedOutfitId] = useState(() => loadSavedAvatar().outfitId ?? pickRandomOutfitId());
  // categoria ativa dentro do editor (Cabelo/Acessório/Barba/...) -- só
  // controla o que aparece NA LISTA, o card em si não muda de tamanho
  // trocando de aba (ver .profile-edit-scroll, rolagem interna).
  const [editorCategory, setEditorCategory] = useState<CustomizationCategoryId>("cabelo");
  // altura MEDIDA de verdade do card de perfil (versão base, com
  // foto+campos) -- a versão de edição usa esse mesmo valor (ver
  // .profile-card.editing style inline), pra nunca ter um tamanho
  // diferente entre as duas telas. Medido ao vivo (ResizeObserver) em
  // vez de um número fixo chutado, ver ProfileCard.
  const [profileCardHeight, setProfileCardHeight] = useState<number | null>(null);

  useEffect(() => {
    let destroyed = false;

    function sendSignal(to: string, data: unknown) {
      socketRef.current?.send(JSON.stringify({ type: "signal", to, data }));
    }

    function createPeerConnection(peerId: string): RTCPeerConnection {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      const localStream = localStreamRef.current;
      if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }
      // se já tava compartilhando tela quando esse peer entrou em
      // proximidade (ver toggleScreenShare), manda a tela pra ele
      // também, não a câmera.
      const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
      if (screenTrack) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        sender?.replaceTrack(screenTrack);
      }

      pc.ontrack = (event) => {
        setRemoteStreams((prev) => ({ ...prev, [peerId]: event.streams[0] }));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
      };

      peersRef.current.set(peerId, pc);
      return pc;
    }

    function closePeer(peerId: string) {
      const pc = peersRef.current.get(peerId);
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }
      connectedPeersRef.current.delete(peerId);
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    }

    async function connectToPeer(peerId: string) {
      if (peersRef.current.has(peerId)) return;
      const pc = createPeerConnection(peerId);
      // regra simples pra evitar os dois lados oferecerem ao mesmo tempo:
      // quem tem o id "menor" inicia a oferta.
      const amInitiator = selfIdRef.current < peerId;
      if (amInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(peerId, { sdp: pc.localDescription });
      }
    }

    async function handleSignal(from: string, data: any) {
      let pc = peersRef.current.get(from);
      if (!pc) pc = createPeerConnection(from);

      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn("Falha ao adicionar candidato ICE", e);
        }
      }
    }

    // --- chamada de voz/vídeo de uma conversa (chat direto/grupo) --
    // mesh de WebRTC PARALELO ao de cima (peersRef, por proximidade na
    // Sala): endereçado pelo MESMO connectionId e pelo MESMO relay
    // "signal" do servidor, mas com um "channel":"call" dentro do "data"
    // pra não se misturar com o sinal de proximidade (ver handleSignal
    // acima e handlePartyMessage embaixo, que decide pra qual dos dois
    // mandar). Reaproveita o MESMO localStreamRef da Sala (câmera/mic já
    // capturados ali) em vez de pedir uma segunda captura -- entrar numa
    // chamada de chat não depende de tá perto de ninguém no mapa.
    function sendCallSignal(to: string, data: unknown) {
      socketRef.current?.send(JSON.stringify({ type: "signal", to, data: { channel: "call", ...(data as object) } }));
    }

    function createCallPeerConnection(peerId: string): RTCPeerConnection {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      const localStream = localStreamRef.current;
      if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      }

      pc.ontrack = (event) => {
        setCallRemoteStreams((prev) => ({ ...prev, [peerId]: event.streams[0] }));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) sendCallSignal(peerId, { candidate: event.candidate });
      };

      callPeersRef.current.set(peerId, pc);
      return pc;
    }

    function closeCallPeer(peerId: string) {
      const pc = callPeersRef.current.get(peerId);
      if (pc) {
        pc.close();
        callPeersRef.current.delete(peerId);
      }
      setCallRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    }

    function closeAllCallPeers() {
      callPeersRef.current.forEach((pc) => pc.close());
      callPeersRef.current.clear();
      setCallRemoteStreams({});
    }

    async function connectToCallPeer(peerId: string) {
      if (callPeersRef.current.has(peerId)) return;
      const pc = createCallPeerConnection(peerId);
      // mesmo critério de empate do mesh de proximidade: quem tem o id
      // "menor" oferta primeiro, assim os dois lados não ofertam juntos.
      const amInitiator = selfIdRef.current < peerId;
      if (amInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendCallSignal(peerId, { sdp: pc.localDescription });
      }
    }

    async function handleCallSignal(from: string, data: any) {
      let pc = callPeersRef.current.get(from);
      if (!pc) pc = createCallPeerConnection(from);

      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendCallSignal(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.warn("Falha ao adicionar candidato ICE (chamada)", e);
        }
      }
    }

    // "Área" (mesa privada/sala, ver game/areas.ts) isola áudio/vídeo: se
    // EU ou a outra pessoa estiver dentro de uma área, só conectamos se
    // for a MESMA área (não importa a distância -- mesmo bem perto, do
    // lado de fora da mesa, não ouve quem tá dentro dela, e vice-versa).
    // Se NENHUM dos dois tá numa área, cai na regra normal de distância
    // (com a "zona morta" de sempre entre CONNECT/DISCONNECT). areaZoneAt
    // é síncrono/local (todo mundo já tem a mesma área carregada, ver
    // loadSavedAreas), não precisa de nada pela rede pra isso.
    function checkProximity() {
      const scene = sceneRef.current;
      if (!scene) return;
      const { x: lx, y: ly } = scene.getLocalPosition();
      const localZone = scene.areaZoneAt(lx, ly);
      const metaUpdate: Record<string, { name: string; distance: number }> = {};

      remotePlayersRef.current.forEach((p, id) => {
        const dist = Math.hypot(p.x - lx, p.y - ly);
        metaUpdate[id] = { name: p.name, distance: dist };

        const remoteZone = scene.areaZoneAt(p.x, p.y);
        const eitherInArea = localZone !== null || remoteZone !== null;
        const sameZone = localZone !== null && localZone === remoteZone;
        const shouldConnect = eitherInArea ? sameZone : dist < PROXIMITY_CONNECT;
        const shouldDisconnect = eitherInArea ? !sameZone : dist > PROXIMITY_DISCONNECT;

        const isConnected = connectedPeersRef.current.has(id);
        if (shouldConnect && !isConnected) {
          connectedPeersRef.current.add(id);
          connectToPeer(id);
        } else if (shouldDisconnect && isConnected) {
          connectedPeersRef.current.delete(id);
          closePeer(id);
        }
      });

      setRemoteMeta(metaUpdate);
    }

    function handlePartyMessage(data: any) {
      const scene = sceneRef.current;

      if (data.type === "init") {
        selfIdRef.current = data.selfId;
        const players = data.players as RemotePlayer[];
        const nextProfiles: Record<string, RemoteProfile> = {};
        for (const p of players) {
          nextProfiles[p.id] = pickRemoteProfile(p);
          if (p.id === data.selfId) continue;
          remotePlayersRef.current.set(p.id, p);
          scene?.upsertRemotePlayer(p.id, p.x, p.y, p.color, p.name, statusColorFor(p.status));
          // já chega sentado (entrou na sala depois de alguém já estar
          // numa mesa privada, ver "seat" no protocolo) -- sem isso a
          // pose/posse só apareceria depois do PRÓXIMO "seat" de verdade.
          if (p.seatFurnitureId) scene?.setRemoteSeat(p.id, p.seatFurnitureId, p.name);
        }
        setRemoteProfiles((prev) => ({ ...prev, ...nextProfiles }));

        // posse de mesa privada já existente antes de eu entrar (ver
        // roomAreaOwners em server/index.js) -- sem isso, quem chega
        // depois nunca saberia quem já é dono de qual mesa.
        const owners = (data.areaOwners as { areaId: string; playerId: string; name: string }[]) ?? [];
        for (const o of owners) {
          const playerId = o.playerId === data.selfId ? "local" : o.playerId;
          scene?.setAreaOwner(o.areaId, playerId, o.name);
        }

        // o servidor me deu um nome/status/etc. PADRÃO (ver server/index.js)
        // -- se eu já tinha algo salvo localmente (nome escolhido antes,
        // bio, foto...) sobrescrevo por cima e já mando de volta pro
        // servidor, pra sala inteira ver o valor certo, não o genérico.
        const serverSelf = players.find((p) => p.id === data.selfId);
        setMyProfile((prev) => {
          const merged: ProfileFields = {
            name: prev.name || serverSelf?.name || "",
            status: prev.status,
            instagram: prev.instagram,
            bio: prev.bio,
            photoUrl: prev.photoUrl,
          };
          sendProfileUpdate(merged);
          return merged;
        });
      } else if (data.type === "join") {
        const p: RemotePlayer = data.player;
        remotePlayersRef.current.set(p.id, p);
        setRemoteProfiles((prev) => ({ ...prev, [p.id]: pickRemoteProfile(p) }));
        scene?.upsertRemotePlayer(p.id, p.x, p.y, p.color, p.name, statusColorFor(p.status));
        if (p.seatFurnitureId) scene?.setRemoteSeat(p.id, p.seatFurnitureId, p.name);
      } else if (data.type === "seat") {
        // ver protocolo "seat" em server/index.js -- outra pessoa sentou
        // ou levantou (furnitureId null); só pose-sync, não mexe em posse
        // de mesa privada (ver "area-owner" abaixo pra isso).
        const existing = remotePlayersRef.current.get(data.id);
        if (existing) existing.seatFurnitureId = data.furnitureId;
        scene?.setRemoteSeat(data.id, data.furnitureId, existing?.name ?? "?");
      } else if (data.type === "area-owner") {
        // ver protocolo "claim-area"/"release-area"/"area-owner" em
        // server/index.js -- alguém tomou posse de uma mesa privada (ou
        // ela voltou a ficar sem dono, playerId/name null).
        const playerId = data.playerId === selfIdRef.current ? "local" : data.playerId;
        scene?.setAreaOwner(data.areaId, playerId, data.name ?? null);
      } else if (data.type === "profile") {
        const existing = remotePlayersRef.current.get(data.id);
        if (existing) Object.assign(existing, data);
        setRemoteProfiles((prev) => ({
          ...prev,
          [data.id]: pickRemoteProfile({ ...prev[data.id], ...data }),
        }));
        if (typeof data.name === "string" && existing) {
          scene?.upsertRemotePlayer(
            data.id,
            existing.x,
            existing.y,
            existing.color,
            data.name,
            statusColorFor(existing.status)
          );
        }
      } else if (data.type === "poke") {
        const text =
          data.kind === "available"
            ? `${data.fromName} perguntou se você tá disponível`
            : data.kind === "call"
              ? `${data.fromName} te chamou pra ir até lá`
              : `${data.fromName} quer falar com você no chat`;
        const toastId = `${Date.now()}-${Math.random()}`;
        setToasts((prev) => [...prev.slice(-3), { id: toastId, text }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 4500);
      } else if (data.type === "move") {
        const p = remotePlayersRef.current.get(data.id);
        if (p) {
          p.x = data.x;
          p.y = data.y;
        }
        scene?.upsertRemotePlayer(
          data.id,
          data.x,
          data.y,
          p?.color ?? "#888888",
          p?.name ?? "?",
          statusColorFor(p?.status)
        );
        checkProximity();
      } else if (data.type === "identity") {
        // corrige o userId "provisório" que veio junto do join desse
        // jogador (ver comentário grande no "identify" em server/
        // index.js) -- sem isso, uma conversa direta iniciada com ele
        // usaria um id que muda a cada reconexão dele.
        const p = remotePlayersRef.current.get(data.id);
        if (p) p.userId = data.userId;
      } else if (data.type === "leave") {
        remotePlayersRef.current.delete(data.id);
        scene?.removeRemotePlayer(data.id);
        closePeer(data.id);
      } else if (data.type === "signal") {
        // "channel":"call" = sinalização da chamada de chat (mesh
        // paralelo, ver handleCallSignal acima); sem isso é o sinal de
        // proximidade normal da Sala.
        if (data.data && data.data.channel === "call") {
          handleCallSignal(data.from, data.data);
        } else {
          handleSignal(data.from, data.data);
        }
      } else if (data.type === "chat") {
        const msg = data.message as ChatMessage;
        // defesa: se por algum motivo "message" não vier junto (payload
        // malformado, versão antiga do servidor etc.), NÃO empurra
        // undefined pro log -- isso derrubava a tela inteira (ver
        // ChatMessageRow, que lê msg.senderId sem checar) em vez de só
        // ignorar essa mensagem quebrada.
        if (msg && typeof msg === "object") setChatLog((prev) => [...prev.slice(-49), msg]);
      } else if (data.type === "chat_room_deleted") {
        // "apagar mensagem" na Sala (ver deleteRoomMessage) -- não tem
        // histórico salvo (ver comentário grande no topo), então isso só
        // tarja a mensagem no log local de quem tá com a sala aberta
        // AGORA, igual o broadcast original já era só pra quem tava
        // conectado na hora.
        const messageId = data.messageId as string;
        setChatLog((prev) => prev.map((m) => (m.id === messageId ? { ...m, deleted: true, text: "", attachment: null } : m)));
      } else if (data.type === "users:list") {
        setAllUsers(data.users as DirectoryUser[]);
      } else if (data.type === "chat:conversations") {
        const list = (data.conversations as Conversation[]).slice().sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(list);
      } else if (data.type === "chat:conversation") {
        const conv = data.conversation as Conversation;
        setConversations((prev) => {
          const rest = prev.filter((c) => c.id !== conv.id);
          return [conv, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
        });
        // se FOI EU que acabei de criar essa conversa (ver
        // startDirectWith/submitCreateGroup), abre ela direto -- os
        // outros participantes só recebem essa mensagem pra aparecer
        // na LISTA deles, sem abrir sozinha.
        if (autoOpenNextConversationRef.current) {
          autoOpenNextConversationRef.current = false;
          setActiveConversationId(conv.id);
          setChatView("thread");
          socketRef.current?.send(JSON.stringify({ type: "chat:open", conversationId: conv.id }));
        }
      } else if (data.type === "chat:history") {
        setMessagesByConv((prev) => ({ ...prev, [data.conversationId]: data.messages }));
      } else if (data.type === "chat:message_deleted") {
        // "apaga pra todos" numa conversa direta/grupo -- a mensagem já
        // chega tarjada do servidor (ver deleteMessage em
        // server/chatStore.js), só reflete no estado local.
        const { conversationId, messageId } = data as { conversationId: string; messageId: string };
        setMessagesByConv((prev) => {
          const list = prev[conversationId];
          if (!list) return prev;
          return {
            ...prev,
            [conversationId]: list.map((m) => (m.id === messageId ? { ...m, deleted: true, text: "", attachment: null } : m)),
          };
        });
      } else if (data.type === "chat:message") {
        const msg = data.message as ChatMsg;
        setMessagesByConv((prev) => ({
          ...prev,
          [data.conversationId]: [...(prev[data.conversationId] ?? []), msg],
        }));
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === data.conversationId);
          if (idx === -1) return prev;
          const updated: Conversation = {
            ...prev[idx],
            updatedAt: msg.ts,
            lastMessage: { senderId: msg.senderId, senderName: msg.senderName, kind: msg.kind, text: msg.text, ts: msg.ts },
          };
          const rest = prev.filter((c) => c.id !== data.conversationId);
          return [updated, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      } else if (data.type === "call:state") {
        // "quem tá na chamada" de UMA conversa -- chega pra todo mundo
        // que participa dela (esteja ou não na call agora, é o que
        // acende o botão verde na lista, ver ChatDrawer). Se essa
        // conversa é a MINHA chamada ativa (ver myCallConversationIdRef,
        // espelho pra ler aqui dentro do efeito sem stale-closure),
        // reconcilia o mesh: conecta quem entrou, desconecta quem saiu.
        const conversationId = data.conversationId as string;
        const participants = data.participants as ChatCallParticipant[];
        setCallParticipantsByConversation((prev) => ({ ...prev, [conversationId]: participants }));
        if (myCallConversationIdRef.current === conversationId) {
          const stillIn = participants.some((p) => p.userId === myUserId);
          if (!stillIn) {
            // saí (ou outra aba minha saiu) -- limpa o lado local também.
            myCallConversationIdRef.current = null;
            setMyCallConversationId(null);
            closeAllCallPeers();
          } else {
            const wantedPeerIds = new Set(
              participants.filter((p) => p.userId !== myUserId).map((p) => p.connectionId)
            );
            callPeersRef.current.forEach((_pc, peerId) => {
              if (!wantedPeerIds.has(peerId)) closeCallPeer(peerId);
            });
            wantedPeerIds.forEach((peerId) => {
              if (!callPeersRef.current.has(peerId)) connectToCallPeer(peerId);
            });
          }
        }
      } else if (data.type === "agenda:calls") {
        setCalls((data.calls as CallEvent[]).slice().sort((a, b) => a.startTs - b.startTs));
      } else if (data.type === "agenda:call") {
        const call = data.call as CallEvent;
        setCalls((prev) => {
          const rest = prev.filter((c) => c.id !== call.id);
          return [...rest, call].sort((a, b) => a.startTs - b.startTs);
        });
        // se essa call é a que EU acabei de marcar (ver submitCreateCall/
        // agendaCreatingRef), pula direto pro detalhe dela -- os outros
        // convidados só recebem pra aparecer na LISTA deles, sem pular
        // sozinho (mesmo padrão de autoOpenNextConversationRef no chat).
        if (agendaCreatingRef.current && call.createdBy === myUserId) {
          agendaCreatingRef.current = false;
          setAgendaError(null);
          setAgendaDetailId(call.id);
          setAgendaView("detail");
        }
      } else if (data.type === "agenda:availability") {
        setBusyUserIds(data.busyUserIds as string[]);
      } else if (data.type === "agenda:invite") {
        const call = data.call as CallEvent;
        const toastId = `${Date.now()}-${Math.random()}`;
        setToasts((prev) => [
          ...prev.slice(-3),
          { id: toastId, text: `${call.createdByName || "Alguém"} marcou "${call.title}" com você` },
        ]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
      } else if (data.type === "agenda:reminder") {
        const call = data.call as CallEvent;
        const toastId = `${Date.now()}-${Math.random()}`;
        setToasts((prev) => [...prev.slice(-3), { id: toastId, text: `"${call.title}" começa em breve` }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 6000);
      } else if (data.type === "agenda:error") {
        agendaCreatingRef.current = false;
        if (data.reason === "conflict") {
          setBusyUserIds((data.busyUserIds as string[]) ?? []);
          setAgendaError("Algum convidado ficou indisponível nesse horário -- escolha outro e tente de novo.");
        }
      } else if (data.type === "agenda:colleague_calls") {
        // resposta de "pesquise a agenda de um colega" (ver
        // viewColleagueAgenda) -- só aplica se ainda for o colega que a
        // pessoa tá olhando agora (evita uma resposta atrasada de uma
        // busca anterior sobrescrever a atual).
        if (data.userId === agendaColleagueIdRef.current) {
          setColleagueCalls((data.calls as CallEvent[]).slice().sort((a, b) => a.startTs - b.startTs));
        }
      }
    }

    // Pede câmera/microfone SEM travar o resto: a sala e o multiplayer sobem
    // imediatamente (abaixo), e o vídeo local entra assim que (e se) o
    // navegador liberar a permissão — mesmo que a pessoa demore ou nunca
    // responda ao aviso.
    async function requestMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        if (destroyed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;

        // se algum peer já tinha conectado por proximidade antes da câmera
        // liberar, adiciona as tracks agora nas conexões já abertas.
        peersRef.current.forEach((pc) => {
          stream.getTracks().forEach((track) => {
            const alreadyAdded = pc.getSenders().some((s) => s.track === track);
            if (!alreadyAdded) pc.addTrack(track, stream);
          });
        });
      } catch (e) {
        console.warn("Sem acesso a câmera/microfone — seguindo só com posição/chat.", e);
      }
    }

    function init() {
      if (!containerRef.current || destroyed) return;

      const config = createGameConfig(containerRef.current);
      const game = new Phaser.Game(config);
      gameRef.current = game;

      game.events.once(Phaser.Core.Events.READY, () => {
        const scene = game.scene.getScene("main") as MainScene;
        sceneRef.current = scene;
        // nome/status do card de perfil (ver useEffect logo abaixo, que
        // cobre trocas DEPOIS que a cena já tá pronta) -- aqui só o
        // valor inicial, pra não esperar o próximo render pra aparecer.
        scene.setLocalProfile(
          myProfileRef.current.name || "Você",
          statusColorFor(myProfileRef.current.status)
        );
        // aplica a aparência salva/sorteada (cabelo, tom de pele, barba,
        // acessório, traje) já na hora que a cena fica pronta -- sem
        // isso, createAvatar() sempre cria o boneco com DEFAULT_HAIR_ID/
        // DEFAULT_SKIN_ID/DEFAULT_BEARD_ID/DEFAULT_ACCESSORY_ID (ver
        // customization.ts), ignorando o que a pessoa escolheu/salvou da
        // última vez -- ANTES só o traje tinha esse tratamento aqui (por
        // isso o boneco voltava pro padrão em TODO F5, mesmo sem trocar
        // de traje: o bug reportado pelo Douglas). Mesma ordem de
        // saveEditingCharacter() logo abaixo, pelo mesmo motivo (tom de
        // pele primeiro, pra barba/traje já casarem com ele).
        scene.setLocalHairId(selectedHairColorId ?? selectedHairId);
        scene.setLocalSkinId(selectedSkinId);
        scene.setLocalBeardId(selectedBeardId);
        scene.setLocalAccessoryId(selectedAccessoryColorId ?? selectedAccessoryId);
        scene.setLocalOutfitId(selectedOutfitId);
        scene.onLocalMove = (x, y) => {
          socketRef.current?.send(JSON.stringify({ type: "move", x, y }));
          checkProximity();
        };
        // senta/levanta (só pose-sync, ver protocolo "seat" em
        // server/index.js -- não mexe mais em posse de mesa privada) --
        // muda bem menos vezes que a posição, então manda direto, sem
        // passar pelo mesmo throttle de reportPosition do onLocalMove.
        scene.onLocalSeatChange = (furnitureId) => {
          socketRef.current?.send(JSON.stringify({ type: "seat", furnitureId }));
        };
        // botão "Tomar posse" / soltar posse numa mesa privada (ver
        // protocolo "claim-area"/"release-area" em server/index.js) --
        // servidor é quem decide de verdade (primeiro a clicar ganha);
        // não atualiza nada aqui na hora, espera o broadcast "area-owner"
        // voltar (ver handlePartyMessage acima), pra nunca dessincronizar
        // se duas pessoas clicarem quase ao mesmo tempo.
        scene.onClaimArea = (areaId) => {
          socketRef.current?.send(JSON.stringify({ type: "claim-area", areaId }));
        };
        scene.onReleaseArea = (areaId) => {
          socketRef.current?.send(JSON.stringify({ type: "release-area", areaId }));
        };
        scene.onDraftChange = (items) => setDraftItems(items);
        scene.onDraftFloorChange = (items) => setDraftFloorItems(items);
        scene.onDraftAreaChange = (items) => setDraftAreaItems(items);
        // painel "Assento" (ver EditPanel) -- estado ao vivo de
        // sentou/levantou/nudge (ver onSeatTuningChange em
        // MainScene.ts). onSeatOffsetReset é só pro botão "Redefinir":
        // APAGA a entrada do grupo+direção em vez de só atualizar x/y
        // (ver comentário em MainScene.ts).
        // puramente de EXIBIÇÃO (painel "Assento") -- sentar/levantar/
        // ligar o modo passam por aqui só pra MOSTRAR o valor atual
        // (resolvido, ver resolveSeatOffset), sem gravar nada sozinho.
        scene.onSeatTuningChange = (info) => setSeatTuningInfo(info);
        // esse sim GRAVA -- só dispara com um nudge de verdade (ver
        // comentário em onSeatOffsetChange, MainScene.ts), nunca só por
        // sentar. É o que entra no mapa que autosalva (ver useEffect
        // combinado de mobília+assento mais abaixo).
        scene.onSeatOffsetChange = (groupKey, facing, x, y) => {
          setSeatOffsetsState((prev) => ({
            ...prev,
            [groupKey]: { ...(prev[groupKey] ?? {}), [facing]: { x, y } },
          }));
        };
        scene.onSeatOffsetReset = (groupKey, facing) => {
          setSeatOffsetsState((prev) => {
            const byFacing = prev[groupKey];
            if (!byFacing || !(facing in byFacing)) return prev;
            const nextByFacing = { ...byFacing };
            delete nextByFacing[facing];
            return { ...prev, [groupKey]: nextByFacing };
          });
        };
        // itens CUSTOM (Editor de Itens, ver fetchAndRegisterCustomFurniture
        // acima) -- registra os modelos e carrega a textura de cada um
        // ANTES de pedir a mobília já colocada (loadSavedFurniture logo
        // abaixo): um item custom colocado precisa do modelo já
        // registrado E a textura já carregada pra resolveFurnitureArt/
        // furnitureTextureKeyFor acharem ele, senão renderiza em branco
        // (ou nem acha o design único de fallback, já que sofa/mesa/
        // planta/computador não têm um).
        // mobília adicional já salva (ver GET /room/furniture em
        // server/index.js) -- mesmo timing/tratamento de falha do piso
        // abaixo: furnitureLoadedRef só vira true DEPOIS da tentativa
        // (sucesso ou falha), o autosave confere essa flag antes de
        // mandar qualquer POST. O ajuste de assento (seatOffsets) precisa
        // entrar na cena (setSeatOffsets) ANTES de loadSavedFurniture,
        // senão um item já sentável carregaria sem o ajuste salvo.
        // Tom de pele/cabelo/acessório/barba/traje custom (ver
        // fetchAndRegisterCustomSkins/fetchAndRegisterCustomAvatarItems)
        // rodam em PARALELO, sem bloquear a cadeia de carregar móvel --
        // nenhum desses três depende dos outros.
        fetchAndRegisterCustomSkins();
        fetchAndRegisterCustomAvatarItems();
        fetchAndRegisterCustomFurniture().finally(() => {
          fetch(`${REALTIME_HTTP_BASE}/room/furniture`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data?.seatOffsets) {
                setSeatOffsetsState(data.seatOffsets);
                sceneRef.current?.setSeatOffsets(data.seatOffsets);
              }
              if (data?.items) sceneRef.current?.loadSavedFurniture(data.items);
            })
            .catch(() => {})
            .finally(() => {
              furnitureLoadedRef.current = true;
            });
        });
        // piso já salvo (ver GET /room/floor em server/index.js) -- busca
        // assim que a cena fica pronta e manda pra dentro dela (ver
        // loadSavedFloor em MainScene.ts). Falha em silêncio (ex: servidor
        // fora do ar) -- a sala ainda funciona sem piso pintado nenhum.
        // floorLoadedRef só vira true DEPOIS dessa tentativa (sucesso ou
        // falha) -- o autosave abaixo confere essa flag antes de mandar
        // qualquer coisa, senão o primeiro render (draftFloorItems ainda
        // vazio, ninguém carregou nada de verdade) apagaria um piso já
        // salvo antes mesmo da busca responder.
        fetch(`${REALTIME_HTTP_BASE}/room/floor`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.items) sceneRef.current?.loadSavedFloor(data.items);
          })
          .catch(() => {})
          .finally(() => {
            floorLoadedRef.current = true;
          });
        // área já salva (ver GET /room/areas em server/index.js) -- mesmo
        // timing/tratamento de falha do piso acima, só que a resposta tem
        // DUAS listas ({list, tiles}, ver getAreaState em roomStore.js):
        // a lista de áreas CRIADAS precisa entrar primeiro (setAreaDefs),
        // porque a cor de cada tile pintado vem da área dona dele (ver
        // addAreaTileRect em MainScene.ts, que já precisa da lista
        // carregada antes de desenhar).
        fetch(`${REALTIME_HTTP_BASE}/room/areas`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.list) {
              setDraftAreaDefs(data.list);
              sceneRef.current?.setAreaDefs(data.list);
            }
            if (data?.tiles) sceneRef.current?.loadSavedAreas(data.tiles);
          })
          .catch(() => {})
          .finally(() => {
            areaLoadedRef.current = true;
          });
        scene.onAvatarClick = (info) => {
          setProfileCard({ playerId: info.playerId, isLocal: info.isLocal });
          setEditingCharacter(false);
        };
        // clique no nome (hover) do dono de uma mesa privada -- mesmo
        // destino do onAvatarClick acima, disparado pela MESA em vez do
        // boneco (ver onAreaOwnerClick em MainScene.ts).
        scene.onAreaOwnerClick = (info) => {
          setProfileCard({ playerId: info.playerId, isLocal: info.isLocal });
          setEditingCharacter(false);
        };
      });

      const socket = new PartySocket({ host: REALTIME_HOST, room: "sala-principal" });
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setStatus("Conectado");
        // identidade persistente pro chat direto/grupo (ver comentário
        // em getOrCreateUserId) + já pede a lista de conversas salvas.
        // accessToken (só quem tem conta, ver AuthGate.tsx) deixa o
        // servidor CONFIRMAR que esse userId é mesmo dessa conta (ver
        // server/roomAuth.js) -- sem token, servidor trata como
        // visitante anônimo de sempre, sem confiar cegamente no
        // userId que o cliente mandou.
        socket.send(
          JSON.stringify({ type: "identify", userId: myUserId, accessToken: accountAccessTokenRef.current })
        );
        socket.send(JSON.stringify({ type: "chat:list" }));
        socket.send(JSON.stringify({ type: "agenda:list" }));
      });
      socket.addEventListener("close", () => setStatus("Desconectado"));
      socket.addEventListener("error", () => setStatus("Erro de conexão"));
      socket.addEventListener("message", (evt) => {
        try {
          handlePartyMessage(JSON.parse(evt.data));
        } catch (e) {
          console.warn("Mensagem inválida do servidor", e);
        }
      });

      // câmera/microfone rodam à parte, sem bloquear nada acima
      requestMedia();
    }

    init();

    return () => {
      destroyed = true;
      gameRef.current?.destroy(true);
      socketRef.current?.close();
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peersRef.current.forEach((pc) => pc.close());
      peersRef.current.clear();
      callPeersRef.current.forEach((pc) => pc.close());
      callPeersRef.current.clear();
    };
  }, []);

  function toggleMic() {
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setMicOn((v) => !v);
  }

  function toggleCam() {
    const stream = localStreamRef.current;
    if (!stream) return;
    stream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setCamOn((v) => !v);
  }

  // --- troca de aparelho (mic/câmera), ver SettingsPanel > "Áudio e
  // vídeo" -- pedido do Douglas: "de onde quer puxar o audio, video".
  // Abre um getUserMedia NOVO só com o deviceId escolhido, troca a
  // track dentro do MESMO MediaStream de sempre (localStreamRef -- pra
  // não perder a referência que o resto do código já guarda) e manda a
  // track nova pra TODOS os peers já conectados via replaceTrack (mesmo
  // truque do toggleScreenShare acima, sem precisar renegociar nada) --
  // nos DOIS meshes (peersRef da sala por proximidade E callPeersRef da
  // chamada de chat, que reusam o mesmo localStreamRef).
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
      [...peersRef.current.values(), ...callPeersRef.current.values()].forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        sender?.replaceTrack(newTrack);
      });
      setSelectedMicId(deviceId);
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
      // com tela compartilhada agora, o sender de vídeo tá ocupado com a
      // tela (ver toggleScreenShare) -- não mexe nele aqui, a câmera nova
      // só assume quando a pessoa PARAR o compartilhamento
      // (stopScreenShare já pega a track atual de localStreamRef sozinho).
      if (!screenOn) {
        [...peersRef.current.values(), ...callPeersRef.current.values()].forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          sender?.replaceTrack(newTrack);
        });
        if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      }
      setSelectedCamId(deviceId);
    } catch (e) {
      console.warn("Não deu pra trocar de câmera", e);
    }
  }

  // Saída de áudio (alto-falante/fone) -- diferente de mic/câmera, não
  // precisa de getUserMedia nenhum: é só QUAL DISPOSITIVO toca o áudio
  // que já tá chegando, aplicado por elemento <video> (ver setSinkId em
  // RemoteVideoTile). Só guarda a escolha aqui.
  function switchSpeakerDevice(deviceId: string) {
    setSelectedSpeakerId(deviceId);
  }

  function changeRemoteVolume(id: string, volume: number) {
    setRemoteVolumes((prev) => ({ ...prev, [id]: volume }));
  }

  // Compartilhar tela: em vez de mandar uma track de vídeo A MAIS (o que
  // exigiria renegociar a chamada com cada peer, ver createPeerConnection
  // -- essa base não trata "negotiationneeded"), TROCA a track de vídeo
  // que já tá saindo pra cada peer (replaceTrack -- mesmo "slot", sem
  // precisar de nova oferta/resposta). Some da tela = volta pra câmera.
  async function toggleScreenShare() {
    if (screenOn) {
      stopScreenShare();
      return;
    }

    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) {
      console.warn("Compartilhamento de tela cancelado/negado", e);
      return;
    }

    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) return;

    screenStreamRef.current = display;
    // se a pessoa parar o compartilhamento pelo controle NATIVO do
    // navegador (não pelo nosso botão), volta pra câmera sozinho.
    screenTrack.onended = () => stopScreenShare();

    peersRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      sender?.replaceTrack(screenTrack);
    });

    if (localVideoRef.current) localVideoRef.current.srcObject = display;
    setScreenOn(true);
  }

  function stopScreenShare() {
    const display = screenStreamRef.current;
    if (display) {
      display.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }

    const camStream = localStreamRef.current;
    const camTrack = camStream?.getVideoTracks()[0];
    peersRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video" || s.track === null);
      if (camTrack) sender?.replaceTrack(camTrack);
    });

    if (localVideoRef.current) localVideoRef.current.srcObject = camStream ?? null;
    setScreenOn(false);
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    if (!wsSend({ type: "chat", text })) return;
    setChatInput("");
  }

  // --- chat de verdade (direta/grupo) -- ver tipos Conversation/ChatMsg
  // lá em cima. "Sala" (activeConversationId === null) continua usando
  // sendChat/chatLog de cima -- mesmo formato de mensagem (com anexo),
  // só que sem histórico salvo (ver comentário no tipo ChatMessage). ---

  function openConversation(id: string | null) {
    setActiveConversationId(id);
    setChatView("thread");
    if (id !== null && !messagesByConv[id]) {
      socketRef.current?.send(JSON.stringify({ type: "chat:open", conversationId: id }));
    }
  }

  function startDirectWith(targetUserId: string) {
    autoOpenNextConversationRef.current = true;
    socketRef.current?.send(JSON.stringify({ type: "chat:create_direct", targetUserId }));
    setNewConvSelection([]);
    setNewConvName("");
  }

  function submitNewConversation() {
    if (newConvSelection.length === 0) return;
    if (newConvSelection.length === 1 && !newConvName.trim()) {
      startDirectWith(newConvSelection[0]);
      return;
    }
    autoOpenNextConversationRef.current = true;
    socketRef.current?.send(
      JSON.stringify({
        type: "chat:create_group",
        name: newConvName.trim(),
        participantIds: newConvSelection,
      })
    );
    setNewConvSelection([]);
    setNewConvName("");
  }

  function toggleNewConvSelection(userId: string) {
    setNewConvSelection((prev) => (prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]));
  }

  function submitRenameGroup() {
    const name = groupNameDraft.trim();
    if (!activeConversationId || !name) return;
    socketRef.current?.send(
      JSON.stringify({ type: "chat:rename_group", conversationId: activeConversationId, name })
    );
    setRenamingGroup(false);
  }

  function sendActiveChatMessage() {
    const text = chatComposerText.trim();
    if (!text) return;
    const ok =
      activeConversationId === null
        ? wsSend({ type: "chat", text })
        : wsSend({ type: "chat:send", conversationId: activeConversationId, text });
    if (!ok) return;
    setChatComposerText("");
  }

  async function sendChatAttachment(file: Blob, filename: string, kind: ChatAttachmentKind) {
    setSendingAttachment(true);
    try {
      const attachment = await uploadChatFile(file, filename);
      if (activeConversationId === null) {
        wsSend({ type: "chat", attachment, kind });
      } else {
        wsSend({ type: "chat:send", conversationId: activeConversationId, attachment, kind });
      }
    } catch (e) {
      console.warn("Falha ao enviar anexo no chat", e);
      showErrorToast("Não deu pra enviar o anexo -- tenta de novo.");
    } finally {
      setSendingAttachment(false);
    }
  }

  function handleChatFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    sendChatAttachment(file, file.name, file.type.startsWith("image/") ? "image" : "file");
  }

  // --- gravação de áudio, estilo WhatsApp: grava (mostra o tempo já
  // gravado ao vivo) -> PARA (sem mandar sozinho) -> mostra um preview
  // pra ouvir de novo -> só manda quando a pessoa confirma. Antes disso
  // o áudio era enviado sozinho assim que parava de gravar, sem
  // confirmação nem progresso visível -- "o audio liga, mas nao funciona
  // nao envia" (o clique funcionava, só não dava nenhum feedback do que
  // tava acontecendo até o envio silencioso no fim). ---
  async function startVoiceRecording() {
    try {
      // reaproveita a track de áudio que JÁ tá capturada pra chamada da
      // sala (localStreamRef) em vez de abrir uma SEGUNDA captura do
      // mesmo microfone com getUserMedia -- pedir dois getUserMedia de
      // áudio ao mesmo tempo do mesmo dispositivo faz alguns navegadores
      // aplicarem cancelamento de eco entre as duas capturas e silenciam
      // uma delas: a gravação "funciona" (o tempo conta certinho, o
      // arquivo sai do tamanho esperado) mas sai muda ao reproduzir.
      // Clona a track (não mexe na original, que continua servindo a
      // chamada) e força enabled=true -- gravar um áudio não deveria
      // depender de o mic da sala estar ligado ou desligado (ver micOn).
      const roomAudioTrack = localStreamRef.current?.getAudioTracks()[0];
      let stream: MediaStream;
      if (roomAudioTrack && roomAudioTrack.readyState === "live") {
        const cloned = roomAudioTrack.clone();
        cloned.enabled = true;
        stream = new MediaStream([cloned]);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const mimeType = pickSupportedAudioMimeType();
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      discardRecordingRef.current = false;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        setRecordingAudio(false);
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || "audio/webm" });
        if (blob.size > 0) {
          recordedBlobRef.current = blob;
          const durationSec = Math.max(0, Math.round((Date.now() - recordingStartRef.current) / 1000));
          setRecordedPreview({ url: URL.createObjectURL(blob), durationSec });
        }
      };
      mediaRecorderRef.current = mr;
      // timeslice de 250ms -- garante pedaços acumulando ao longo da
      // gravação em vez de depender só do chunk final no stop (alguns
      // navegadores demoram ou falham nisso sem um timeslice).
      mr.start(250);
      recordingStartRef.current = Date.now();
      setRecordingElapsedSec(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingElapsedSec(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }, 250);
      setRecordedPreview(null);
      setRecordingAudio(true);
    } catch (e) {
      console.warn("Sem acesso ao microfone pra gravar áudio", e);
      showErrorToast("Não deu pra acessar o microfone -- verifique a permissão do navegador.");
    }
  }

  // só PARA a gravação -- vira preview (ver onstop acima), não manda.
  function stopVoiceRecording() {
    mediaRecorderRef.current?.stop();
  }

  // cancela a gravação EM ANDAMENTO (lixeira enquanto ainda tá gravando)
  // -- descarta tudo, não vira preview.
  function cancelVoiceRecording() {
    discardRecordingRef.current = true;
    mediaRecorderRef.current?.stop();
  }

  // descarta o preview já gravado (depois de já ter parado) sem enviar.
  function discardRecordedAudio() {
    if (recordedPreview) URL.revokeObjectURL(recordedPreview.url);
    recordedBlobRef.current = null;
    setRecordedPreview(null);
  }

  // confirma o envio do preview -- só AQUI o áudio de fato sai pro chat.
  async function sendRecordedAudio() {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    if (recordedPreview) URL.revokeObjectURL(recordedPreview.url);
    recordedBlobRef.current = null;
    setRecordedPreview(null);
    await sendChatAttachment(blob, `gravacao-${Date.now()}.webm`, "audio");
  }

  // "apagar mensagem" -- apaga PRA TODOS (ver server/chatStore.js
  // deleteMessage e o case chat:delete/chat:delete_room em
  // server/index.js). conversationId null = mensagem da Sala.
  function deleteMessage(conversationId: string | null, messageId: string) {
    if (conversationId === null) {
      wsSend({ type: "chat:delete_room", messageId });
    } else {
      wsSend({ type: "chat:delete", conversationId, messageId });
    }
  }

  // --- chamada de voz/vídeo de uma conversa ("tipo discord") -- opt-in
  // (ver call:join/call:leave em server/index.js), só dá pra estar numa
  // por vez: entrar numa nova sai da anterior sozinho. Fecha o mesh local
  // NA HORA (não espera o "call:state" confirmar, ver
  // handlePartyMessage) pra UI reagir de imediato; o eco que volta do
  // servidor só reconcilia de novo, sem efeito nenhum já que já tá tudo
  // limpo. ---
  function joinCall(conversationId: string) {
    if (myCallConversationId === conversationId) return;
    if (myCallConversationId) {
      wsSend({ type: "call:leave", conversationId: myCallConversationId });
      callPeersRef.current.forEach((pc) => pc.close());
      callPeersRef.current.clear();
      setCallRemoteStreams({});
    }
    setMyCallConversationId(conversationId);
    wsSend({ type: "call:join", conversationId });
  }

  function leaveCall() {
    if (!myCallConversationId) return;
    wsSend({ type: "call:leave", conversationId: myCallConversationId });
    setMyCallConversationId(null);
    callPeersRef.current.forEach((pc) => pc.close());
    callPeersRef.current.clear();
    setCallRemoteStreams({});
  }

  // --- Agenda (ver tipos/comentário grande lá em cima) ---

  function updateAgendaForm(partial: Partial<AgendaFormState>) {
    setAgendaForm((prev) => ({ ...prev, ...partial }));
  }

  function toggleAgendaParticipant(userId: string) {
    if (busyUserIds.includes(userId)) return; // indisponível nesse horário, não deixa marcar
    setAgendaForm((prev) => ({
      ...prev,
      participantIds: prev.participantIds.includes(userId)
        ? prev.participantIds.filter((x) => x !== userId)
        : [...prev.participantIds, userId],
    }));
  }

  function startNewCall() {
    const suggestion = new Date(Date.now() + 30 * 60_000); // meia hora a partir de agora, só de ponto de partida
    setAgendaForm({
      title: "",
      date: localDateStr(suggestion),
      time: localTimeStr(suggestion),
      durationMinutes: 30,
      participantIds: [],
      needs: { camera: true, audio: true, screen: false },
      visibility: "public",
      description: "",
      attachments: [],
      blocksAgenda: true,
    });
    setAgendaError(null);
    setBusyUserIds([]);
    setAgendaView("new");
  }

  function submitCreateCall() {
    const startTs = combineLocalDateTime(agendaForm.date, agendaForm.time);
    // participantIds vazio é válido (compromisso só da própria pessoa --
    // ver comentário em agenda:create no servidor). Antes tinha um
    // "|| agendaForm.participantIds.length === 0" aqui que travava
    // exatamente esse caso: o clique em "Marcar compromisso" não fazia
    // NADA (nem mandava a mensagem, nem mostrava erro), por isso o botão
    // "não funcionava" quando a pessoa tentava marcar um compromisso só
    // pra ela mesma.
    if (!Number.isFinite(startTs)) {
      setAgendaError("Preenche a data e o horário pra marcar o compromisso.");
      return;
    }
    setAgendaError(null);
    agendaCreatingRef.current = true;
    const ok = wsSend({
      type: "agenda:create",
      title: agendaForm.title.trim() || "Call",
      startTs,
      durationMinutes: agendaForm.durationMinutes,
      needs: agendaForm.needs,
      participantIds: agendaForm.participantIds,
      visibility: agendaForm.visibility,
      description: agendaForm.description.trim(),
      attachments: agendaForm.attachments,
      blocksAgenda: agendaForm.blocksAgenda,
    });
    if (!ok) agendaCreatingRef.current = false;
    // fica na tela do formulário até a resposta chegar (sucesso pula pro
    // detalhe da call criada, erro mostra o motivo aqui mesmo -- ver
    // handlePartyMessage/agendaCreatingRef).
  }

  // upload de anexo do "Marcar compromisso" -- mesmo endpoint HTTP do
  // chat (ver uploadChatFile), só que o resultado fica guardado no
  // FORMULÁRIO (agendaForm.attachments) em vez de mandar na hora, porque
  // a call em si só é criada quando a pessoa confirma "Marcar
  // compromisso".
  async function handleAgendaFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSendingAgendaAttachment(true);
    try {
      const attachment = await uploadChatFile(file, file.name);
      setAgendaForm((prev) => ({ ...prev, attachments: [...prev.attachments, attachment] }));
    } catch (err) {
      console.warn("Falha ao anexar arquivo no compromisso", err);
      showErrorToast("Não deu pra anexar o arquivo -- tenta de novo.");
    } finally {
      setSendingAgendaAttachment(false);
    }
  }

  function removeAgendaFormAttachment(index: number) {
    setAgendaForm((prev) => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index) }));
  }

  // anexar arquivo numa call JÁ CRIADA (visível pra quem já tá na tela
  // de detalhe) -- diferente do de cima, esse manda direto pro servidor
  // (ver agenda:add_attachment), porque a call já existe.
  async function handleAgendaDetailFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !agendaDetailId) return;
    setSendingDetailAttachment(true);
    try {
      const attachment = await uploadChatFile(file, file.name);
      wsSend({ type: "agenda:add_attachment", callId: agendaDetailId, attachment });
    } catch (err) {
      console.warn("Falha ao anexar arquivo na call", err);
      showErrorToast("Não deu pra anexar o arquivo -- tenta de novo.");
    } finally {
      setSendingDetailAttachment(false);
    }
  }

  function toggleAgendaDay(dateKey: string) {
    setExpandedAgendaDays((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  }

  function openCallDetail(callId: string) {
    setAgendaDetailId(callId);
    setAgendaView("detail");
  }

  function respondToCall(callId: string, status: "approved" | "declined") {
    socketRef.current?.send(JSON.stringify({ type: "agenda:respond", callId, status }));
  }

  // "pesquise a agenda de um colega" -- pede a agenda dele pro servidor
  // (calls privadas em que eu não participo chegam tarjadas, ver
  // agenda:view_colleague em server/index.js) e troca a Agenda pra essa
  // visão. onlinePlayerName é só pra já mostrar o cabeçalho certo sem
  // esperar a resposta do servidor.
  function viewColleagueAgenda(userId: string, name: string) {
    setAgendaColleagueId(userId);
    agendaColleagueIdRef.current = userId;
    setAgendaColleagueName(name || "Sem nome");
    setColleagueCalls([]);
    setAgendaView("colleague");
    socketRef.current?.send(JSON.stringify({ type: "agenda:view_colleague", userId }));
  }

  function backToMyAgenda() {
    setAgendaColleagueId(null);
    agendaColleagueIdRef.current = null;
    setAgendaColleagueName("");
    setColleagueCalls([]);
    setAgendaSearchQuery("");
    setAgendaView("list");
  }

  function toggleEditMode() {
    // defensivo -- o botão que chama isso já fica escondido pra quem não
    // pode (ver canEditRoom), isso é só pra garantir que nada mais
    // consiga ligar o modo de edição pra membro/visitante.
    if (!canEditRoom) return;
    const next = !editMode;
    setEditMode(next);
    setSelectedCatalogIndex(null);
    setSelectedColorId(null);
    setSelectedFloorToolId(null);
    setSelectedAreaToolId(null);
    setActiveCategory("poltrona");
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.setEditMode(next);
    sceneRef.current?.setSeatTuningMode(false); // defensivo -- sair do editor sempre desliga o ajuste de assento também
  }

  /** Botão flutuante "Apagar" (ver .map-delete-btn) -- liga/desliga a
   * ferramenta na cena e desarma qualquer outra (categoria de móvel, piso,
   * área, mover), mesma exclusão mútua que já existe entre elas. */
  function toggleDeleteTool() {
    const next = !deleteToolActive;
    setDeleteToolActive(next);
    if (next) {
      setSelectedCatalogIndex(null);
      setSelectedFloorToolId(null);
      setSelectedAreaToolId(null);
      setMoveToolActive(false);
    }
    sceneRef.current?.selectDeleteTool(next);
  }

  /** Botão flutuante "Mover" (ver .map-move-btn), agrupado com "Apagar" --
   * mesmo padrão de toggleDeleteTool: liga/desliga a ferramenta na cena e
   * desarma qualquer outra. Pedido do Douglas: reposicionar um item já
   * colocado sem precisar apagar e colocar de novo (perdia cor/modelo
   * escolhido); deixou de ser aba de categoria (EDIT_CATEGORY_TABS) pra
   * virar botão flutuante junto do Apagar, longe do zoom. */
  function toggleMoveTool() {
    const next = !moveToolActive;
    setMoveToolActive(next);
    if (next) {
      setSelectedCatalogIndex(null);
      setSelectedFloorToolId(null);
      setSelectedAreaToolId(null);
      setDeleteToolActive(false);
    }
    sceneRef.current?.selectMoveTool(next);
  }

  // troca de categoria na barra de ícones -- separado de setActiveCategory
  // direto (era só isso antes) porque "assento" precisa ligar/desligar o
  // modo de ajuste na cena (ver setSeatTuningMode em MainScene.ts, muda o
  // que as setas de direção fazem enquanto sentado).
  function changeCategory(category: FurnitureCategoryId | "piso" | "area" | "assento") {
    setActiveCategory(category);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.setSeatTuningMode(category === "assento");
    sceneRef.current?.selectMoveTool(false);
    sceneRef.current?.selectDeleteTool(false);
  }

  /** Aplica a COR escolhida (ver selectFurnitureColor) numa entrada de catálogo, se ela tiver cores (ver FurnitureCatalogEntry.colors) -- devolve a entrada como veio quando não tiver (ex: vidro) ou quando o id não bater com nenhuma cor dela. */
  function entryWithColor(entry: FurnitureCatalogEntry, colorId: string | null): FurnitureCatalogEntry {
    if (!colorId || !entry.colors?.some((c) => c.id === colorId)) return entry;
    return { ...entry, colorId };
  }

  function selectCatalog(index: number) {
    // clicar de novo no mesmo item da paleta DESSELECIONA (sai do "modo
    // colocar"), igual clicar um toggle
    const next = selectedCatalogIndex === index ? null : index;
    const prevEntry = selectedCatalogIndex !== null ? FURNITURE_CATALOG[selectedCatalogIndex] : null;
    const nextEntry = next !== null ? FURNITURE_CATALOG[next] : null;
    // só mantém a cor escolhida se continuar no MESMO modelo (ex: girou
    // de direção) -- trocando de modelo de verdade, volta pra cor default
    // dele (ver comentário em selectedColorId).
    const sameGroup = !!(prevEntry && nextEntry && catalogEntryGroupKey(prevEntry) === catalogEntryGroupKey(nextEntry));
    const colorId = sameGroup ? selectedColorId : null;
    if (!sameGroup) setSelectedColorId(null);
    setSelectedCatalogIndex(next);
    setSelectedFloorToolId(null); // móvel e piso são ferramentas exclusivas, ver selectCatalogEntry na cena
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectCatalogEntry(nextEntry ? entryWithColor(nextEntry, colorId) : null);
  }

  /** Troca a cor do item selecionado na paleta AGORA (ver "Cores" no preview, EditPanel) -- próximo clique de colocar já sai com essa cor. */
  function selectFurnitureColor(colorId: string) {
    setSelectedColorId(colorId);
    if (selectedCatalogIndex === null) return;
    sceneRef.current?.selectCatalogEntry(entryWithColor(FURNITURE_CATALOG[selectedCatalogIndex], colorId));
  }

  /** Botão "Sair do assento" do painel "Assento" -- levanta o boneco local sem precisar de tecla (que durante o ajuste não levanta mais, ver update() em MainScene.ts). */
  function standUpFromSeatTuning() {
    sceneRef.current?.standUpNow();
  }

  /** Botão "Redefinir" do painel "Assento" -- apaga o ajuste manual do grupo+direção atual (ver resetSeatOffset em MainScene.ts, que já cuida de reposicionar e avisar onSeatOffsetReset). */
  function resetSeatTuning() {
    sceneRef.current?.resetSeatOffset();
  }

  // clicar de novo na MESMA ferramenta de piso já selecionada desarma
  // (mesmo "clique de novo desseleciona" da paleta de móveis acima).
  function selectFloorPaint(entry: FloorCatalogEntry) {
    const next = selectedFloorToolId === entry.id ? null : entry.id;
    setSelectedFloorToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectFloorTool(next === null ? null : { kind: "paint", entry });
  }

  function selectFloorEraser() {
    const next = selectedFloorToolId === "erase" ? null : "erase";
    setSelectedFloorToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectFloorTool(next === null ? null : { kind: "erase" });
  }

  function clearDraftFloorItems() {
    sceneRef.current?.clearDraftFloor();
  }

  // mesmo padrão "clica de novo desarma" das duas funções de piso acima,
  // só que agora arma pelo ID da ÁREA (já criada na lista, ver
  // createArea), não mais por um tipo fixo.
  function selectAreaPaint(id: string) {
    const next = selectedAreaToolId === id ? null : id;
    setSelectedAreaToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectAreaTool(next === null ? null : { kind: "paint", areaId: id });
  }

  function selectAreaEraser() {
    const next = selectedAreaToolId === "erase" ? null : "erase";
    setSelectedAreaToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectAreaTool(next === null ? null : { kind: "erase" });
  }

  function clearDraftAreaItems() {
    sceneRef.current?.clearDraftArea();
  }

  // cria uma área NOVA na lista (nome + tipo, ver AreaDef em
  // game/areas.ts) e já a arma como ferramenta de pintura -- é só depois
  // dessa criação que dá pra arrastar tile nenhum (ver comentário grande
  // em game/areas.ts: nome primeiro, tile depois, nunca o contrário).
  function createArea(name: string, type: AreaType) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const slug = trimmed
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // remove acento
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const id = `${slug || "area"}-${Date.now()}-${Math.round(Math.random() * 999)}`;
    const def: AreaDef = { id, name: trimmed, type };
    setDraftAreaDefs((prev) => [...prev, def]);
    selectAreaPaint(id);
  }

  // apaga uma área da lista -- os tiles que apontavam pra ela viram
  // "órfãos" e são limpos sozinhos do lado da cena (ver setAreaDefs em
  // MainScene.ts, chamado pelo useEffect logo abaixo toda vez que
  // draftAreaDefs muda). Se a área apagada era a que tava armada pra
  // pintura, desarma.
  function removeArea(id: string) {
    setDraftAreaDefs((prev) => prev.filter((a) => a.id !== id));
    if (selectedAreaToolId === id) {
      setSelectedAreaToolId(null);
      sceneRef.current?.selectAreaTool(null);
    }
  }

  // autosave do piso: qualquer mudança em draftFloorItems (pintar, apagar,
  // "Limpar tudo", ou o carregamento inicial acima) manda o piso INTEIRO
  // pro servidor (POST /room/floor, ver server/index.js) depois de uma
  // pausa curta -- em vez de uma chamada de rede por quadrado durante um
  // arrasto rápido (paintFloorLine em MainScene.ts já dispara vários
  // paintFloorAt em sequência). floorLoadedRef evita salvar ANTES da
  // busca inicial responder (ver comentário lá em cima).
  useEffect(() => {
    if (!floorLoadedRef.current) return;
    const timer = setTimeout(() => {
      setFloorSaveStatus("saving");
      fetch(`${REALTIME_HTTP_BASE}/room/floor`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ items: draftFloorItems }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setFloorSaveStatus("saved");
        })
        .catch(() => setFloorSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftFloorItems]);

  // mantém a cena em dia com a LISTA de áreas toda vez que ela muda por
  // aqui (criar/apagar, ver createArea/removeArea) -- MainScene.setAreaDefs
  // já cuida de podar tile órfão sozinho.
  useEffect(() => {
    sceneRef.current?.setAreaDefs(draftAreaDefs);
  }, [draftAreaDefs]);

  // autosave da área -- MESMA lógica/timing do autosave do piso acima,
  // só que manda as DUAS listas juntas (lista de áreas + tiles pintados,
  // ver POST /room/areas em server/index.js) e depende das duas, já que
  // criar/apagar uma área (draftAreaDefs) também precisa persistir.
  useEffect(() => {
    if (!areaLoadedRef.current) return;
    const timer = setTimeout(() => {
      setAreaSaveStatus("saving");
      fetch(`${REALTIME_HTTP_BASE}/room/areas`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ list: draftAreaDefs, tiles: draftAreaItems }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setAreaSaveStatus("saved");
        })
        .catch(() => setAreaSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftAreaDefs, draftAreaItems]);

  // autosave da mobília -- MESMA lógica/timing do autosave do piso/área
  // acima, só que manda os itens colocados JUNTO com o mapa de ajuste de
  // assento (ver POST /room/furniture em server/index.js), já que um
  // nudge no "Assento" (ver onSeatOffsetChange/onSeatOffsetReset) também
  // precisa persistir -- os dois moram no MESMO arquivo/endpoint (ver
  // roomStore.js), então um autosave só cobre os dois juntos.
  useEffect(() => {
    if (!furnitureLoadedRef.current) return;
    const timer = setTimeout(() => {
      setFurnitureSaveStatus("saving");
      fetch(`${REALTIME_HTTP_BASE}/room/furniture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ items: draftItems, seatOffsets }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setFurnitureSaveStatus("saved");
        })
        .catch(() => setFurnitureSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftItems, seatOffsets]);

  // reflete nome/status do MEU card ao vivo no boneco dentro do jogo
  // (nome + bolinha de status, ver setNameplate/setLocalProfile na
  // MainScene) -- roda de novo toda vez que um dos dois campos muda no
  // card. O valor inicial (cena ainda não existia nesse primeiro
  // render) já é coberto no game.events.once(READY, ...) lá em cima.
  useEffect(() => {
    sceneRef.current?.setLocalProfile(myProfile.name || "Você", statusColorFor(myProfile.status));
  }, [myProfile.name, myProfile.status]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_PINNED_STORAGE_KEY, chatPinMode);
    } catch {
      // sem localStorage (modo privado etc.) -- só não lembra da próxima vez
    }
  }, [chatPinMode]);

  function toggleChatPinSide() {
    setChatPinMode((m) => (m === "side" ? "float" : "side"));
  }

  // checagem de disponibilidade AO VIVO enquanto o formulário "Marcar
  // call" tá aberto -- a cada mudança de data/hora/duração, pergunta pro
  // servidor quem (de todo mundo na sala) já fica ocupado nesse horário
  // (ver getConflictingUserIds em server/agendaStore.js), pra já
  // desabilitar essas pessoas na lista de participantes ANTES da pessoa
  // tentar selecionar (não só revalidar depois de clicar "Marcar call").
  // Debounce curto pra não mandar uma mensagem por tecla.
  useEffect(() => {
    if (agendaView !== "new") return;
    const startTs = combineLocalDateTime(agendaForm.date, agendaForm.time);
    if (!Number.isFinite(startTs)) {
      setBusyUserIds([]);
      return;
    }
    const candidateUserIds = Array.from(
      new Map(Array.from(remotePlayersRef.current.values()).map((p) => [p.userId, p])).values()
    )
      .map((p) => p.userId)
      .filter((uid) => uid !== myUserId);
    if (candidateUserIds.length === 0) {
      setBusyUserIds([]);
      return;
    }
    const timer = setTimeout(() => {
      socketRef.current?.send(
        JSON.stringify({
          type: "agenda:availability",
          candidateUserIds,
          startTs,
          durationMinutes: agendaForm.durationMinutes,
        })
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [agendaView, agendaForm.date, agendaForm.time, agendaForm.durationMinutes, myUserId]);

  // enquanto o card de perfil (base OU editando) está aberto, o jogo
  // ignora clique em qualquer boneco -- sem isso, um clique na UI do
  // React que por algum motivo "vaze" pro canvas por baixo (ex: algum
  // elemento do card fora da área esperada) reabre/reseta o card sem
  // querer, que era o sintoma de "algumas abas voltam pro perfil".
  useEffect(() => {
    sceneRef.current?.setAvatarClicksLocked(!!profileCard);
  }, [profileCard]);

  // enquanto QUALQUER campo de texto da UI (nome/bio/insta do card,
  // chat) estiver focado, trava o WASD/setas pro boneco não andar
  // sozinho enquanto a pessoa digita (ver setMovementLocked na
  // MainScene) -- um listener só, no documento inteiro, funciona pra
  // qualquer input/textarea/select que existir agora ou vier depois.
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null) {
      if (!(el instanceof HTMLElement)) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    }
    function onFocusIn(e: FocusEvent) {
      if (isTypingTarget(e.target)) sceneRef.current?.setMovementLocked(true);
    }
    function onFocusOut(e: FocusEvent) {
      if (isTypingTarget(e.target)) sceneRef.current?.setMovementLocked(false);
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  function closeProfileCard() {
    setProfileCard(null);
    setEditingCharacter(false);
  }

  // IMPORTANTE: esses seletores só mexem no estado local (o "rascunho"
  // que a prévia do editor mostra, ver avatar-preview-wrap) -- NÃO
  // chamam mais sceneRef.current?.setLocalXId aqui. O boneco de verdade
  // dentro do jogo só muda quando o Douglas clica "Salvar" (ver
  // saveEditingCharacter), pra ele poder experimentar à vontade sem o
  // resto da sala ver a troca antes de decidir.
  function selectHair(hairId: string) {
    setSelectedHairId(hairId);
    setSelectedHairColorId(null); // penteado novo -- volta pra arte "padrão" dele, sem cor escolhida
  }

  // troca a COR do penteado ATUAL (não troca de penteado -- ver
  // comentário em selectedHairColorId acima).
  function selectHairColor(colorId: string) {
    setSelectedHairColorId(colorId);
  }

  function selectSkin(skinId: string) {
    setSelectedSkinId(skinId);
  }

  // troca o sexo (ver AvatarGender) e, se o tom de pele atual não existir
  // NESSE sexo (ex: veio do masculino, trocou pra feminino), já pula
  // sozinho pro primeiro tom disponível do sexo novo -- senão a grade de
  // baixo mostraria os tons certos mas nenhum marcado como selecionado
  // (ou pior, o boneco continuaria com um tom que nem aparece mais ali).
  function selectGender(gender: AvatarGender) {
    setSelectedGender(gender);
    const stillValid = SKIN_CATALOG.some((skin) => (skin.gender ?? "masculino") === gender && skin.id === selectedSkinId);
    if (!stillValid) {
      const firstOfGender = SKIN_CATALOG.find((skin) => (skin.gender ?? "masculino") === gender);
      if (firstOfGender) setSelectedSkinId(firstOfGender.id);
    }
  }

  // barba: sem variação de cor manual (a arte já combina sozinha com o
  // tom de pele escolhido acima, mesmo esquema do traje -- ver
  // beardFileForSkin/resolveBeardSkinId).
  function selectBeard(beardId: string) {
    setSelectedBeardId(beardId);
  }
  // acessório: mesmo par de funções do cabelo (troca de item/estilo
  // reseta a cor escolhida; trocar só a cor mantém o item/estilo atual).
  function selectAccessory(accessoryId: string) {
    setSelectedAccessoryId(accessoryId);
    setSelectedAccessoryColorId(null);
  }
  function selectAccessoryColor(colorId: string) {
    setSelectedAccessoryColorId(colorId);
  }

  // traje: sem variação de cor manual (a mão já combina sozinha com o
  // tom de pele escolhido acima, ver outfitFileForSkin/resolveOutfitSkinId).
  function selectOutfit(outfitId: string) {
    setSelectedOutfitId(outfitId);
  }

  // "Editar meu personagem" agora toma o card INTEIRO (nada de ficar
  // espremido embaixo dos campos de nome/bio junto -- ver ProfileCard)
  // e sai com Cancelar/Salvar de verdade: Cancelar descarta o rascunho
  // e volta cabelo+cor+tom de pele+barba+acessório+traje pro que tava
  // ANTES de abrir o editor (guardado aqui) -- como nada foi aplicado no
  // boneco de verdade ainda (ver comentário acima), só precisa resetar
  // o estado local, sem mexer na cena. Salvar é o único que aplica de
  // verdade (setLocalHairId/setLocalSkinId/setLocalBeardId/
  // setLocalAccessoryId/setLocalOutfitId) e fecha.
  const hairBeforeEditRef = useRef(selectedHairId);
  const hairColorBeforeEditRef = useRef(selectedHairColorId);
  const genderBeforeEditRef = useRef(selectedGender);
  const skinBeforeEditRef = useRef(selectedSkinId);
  const beardBeforeEditRef = useRef(selectedBeardId);
  const accessoryBeforeEditRef = useRef(selectedAccessoryId);
  const accessoryColorBeforeEditRef = useRef(selectedAccessoryColorId);
  const outfitBeforeEditRef = useRef(selectedOutfitId);
  function startEditingCharacter() {
    hairBeforeEditRef.current = selectedHairId;
    hairColorBeforeEditRef.current = selectedHairColorId;
    genderBeforeEditRef.current = selectedGender;
    skinBeforeEditRef.current = selectedSkinId;
    beardBeforeEditRef.current = selectedBeardId;
    accessoryBeforeEditRef.current = selectedAccessoryId;
    accessoryColorBeforeEditRef.current = selectedAccessoryColorId;
    outfitBeforeEditRef.current = selectedOutfitId;
    setEditorCategory("cabelo");
    setEditingCharacter(true);
  }
  function cancelEditingCharacter() {
    // só descarta o rascunho (o boneco de verdade no jogo nunca mudou
    // enquanto editava, ver comentário acima -- nada a desfazer nele)
    setSelectedHairId(hairBeforeEditRef.current);
    setSelectedHairColorId(hairColorBeforeEditRef.current);
    setSelectedGender(genderBeforeEditRef.current);
    setSelectedSkinId(skinBeforeEditRef.current);
    setSelectedBeardId(beardBeforeEditRef.current);
    setSelectedAccessoryId(accessoryBeforeEditRef.current);
    setSelectedAccessoryColorId(accessoryColorBeforeEditRef.current);
    setSelectedOutfitId(outfitBeforeEditRef.current);
    setEditingCharacter(false);
  }
  function saveEditingCharacter() {
    // aplica o rascunho no boneco de verdade dentro do jogo -- só agora
    // (ver comentário grande acima). Cor escolhida (se houver, cabelo/
    // acessório) manda mais que o item/estilo base, exatamente como no
    // preview do topo -- barba e traje não têm cor manual, a arte já
    // casa sozinha com o tom de pele. Tom de pele primeiro: setLocalBeardId/
    // setLocalOutfitId depois já resolvem a arte certa pro tom recém-
    // aplicado (ver comentário em setLocalSkinId na MainScene, que
    // também reaplica os dois sozinho, mas chamar na ordem certa evita
    // depender só disso).
    sceneRef.current?.setLocalHairId(selectedHairColorId ?? selectedHairId);
    sceneRef.current?.setLocalSkinId(selectedSkinId);
    sceneRef.current?.setLocalBeardId(selectedBeardId);
    sceneRef.current?.setLocalAccessoryId(selectedAccessoryColorId ?? selectedAccessoryId);
    sceneRef.current?.setLocalOutfitId(selectedOutfitId);

    // persiste no localStorage (ver AVATAR_STORAGE_KEY acima) -- é isso
    // que faltava pra sobreviver a um F5 (bug reportado pelo Douglas).
    // Mesmo esquema do resto do card de perfil (updateMyProfile logo
    // abaixo), só que salva na hora (sem debounce): aqui só roda quando
    // clica "Salvar" de verdade, não a cada tecla digitada.
    try {
      window.localStorage.setItem(
        AVATAR_STORAGE_KEY,
        JSON.stringify({
          hairId: selectedHairId,
          hairColorId: selectedHairColorId,
          gender: selectedGender,
          skinId: selectedSkinId,
          beardId: selectedBeardId,
          accessoryId: selectedAccessoryId,
          accessoryColorId: selectedAccessoryColorId,
          outfitId: selectedOutfitId,
        } satisfies SavedAvatar)
      );
    } catch {
      // localStorage indisponível (modo privado, etc.) -- segue só em memória
    }

    setEditingCharacter(false);
  }

  function sendProfileUpdate(fields: ProfileFields) {
    socketRef.current?.send(JSON.stringify({ type: "profile", ...fields }));
  }

  // edição do MEU card (nome/status/insta/bio/foto): atualiza local +
  // localStorage na hora (a UI não trava esperando o servidor), e manda
  // pro servidor com um debounce curto -- assim digitar a bio não manda
  // uma mensagem por tecla.
  const profileSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function updateMyProfile(partial: Partial<ProfileFields>) {
    setMyProfile((prev) => {
      const next = { ...prev, ...partial };
      try {
        window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage indisponível (modo privado, etc.) -- segue só em memória
      }
      if (profileSendTimer.current) clearTimeout(profileSendTimer.current);
      profileSendTimer.current = setTimeout(() => {
        sendProfileUpdate(next);
        syncProfileToAccount(next);
      }, 400);
      return next;
    });
  }

  // quem tem conta (ver AuthGate.tsx) também salva o perfil no Supabase
  // -- assim ele acompanha a CONTA (não só esse navegador/localStorage),
  // aparece igual em qualquer aparelho que a pessoa logar. Sem conta
  // (accountUserId null), não faz nada -- segue só localStorage, igual
  // sempre foi.
  function syncProfileToAccount(fields: ProfileFields) {
    if (!accountUserId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase
      .from("profiles")
      .update({
        name: fields.name,
        status: fields.status,
        instagram: fields.instagram,
        bio: fields.bio,
        photo_url: fields.photoUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", accountUserId)
      .then(({ error }) => {
        if (error) console.warn("Não deu pra salvar o perfil da conta no Supabase:", error.message);
      });
  }

  async function handlePhotoChange(file: File) {
    try {
      const dataUrl = await compressPhotoToDataUrl(file);
      updateMyProfile({ photoUrl: dataUrl });
    } catch (e) {
      console.warn("Não deu pra processar a foto", e);
    }
  }

  function sendPoke(targetId: string, kind: "available" | "call" | "message") {
    socketRef.current?.send(JSON.stringify({ type: "poke", to: targetId, kind }));
  }

  function sendMessageTo(targetId: string) {
    sendPoke(targetId, "message");
    // "Enviar mensagem" no card de outro jogador abre (ou cria) a
    // conversa DIRETA de verdade com ele, já na gaveta de chat -- ver
    // startDirectWith. targetId ali é o id de CONEXÃO (profileCard.
    // playerId); o chat usa o userId PERSISTENTE, ver remotePlayersRef.
    const targetUserId = remotePlayersRef.current.get(targetId)?.userId;
    if (targetUserId) {
      startDirectWith(targetUserId);
      setChatOpen(true);
    }
    closeProfileCard();
  }

  // props compartilhadas do ChatDrawer -- o MESMO componente é usado em
  // dois lugares do JSX agora (flutuante por cima do jogo, ou fixo como
  // barra lateral à esquerda, ver chatPinned), só a posição/pinned muda.
  const chatDrawerProps = {
    view: chatView,
    onChangeView: setChatView,
    conversations,
    activeConversationId,
    onOpenConversation: openConversation,
    messages: activeConversationId === null ? [] : messagesByConv[activeConversationId] ?? [],
    roomChatLog: chatLog,
    myUserId,
    onlinePlayers: Array.from(remotePlayersRef.current.values()),
    newConvSelection,
    onToggleNewConvSelection: toggleNewConvSelection,
    newConvName,
    onChangeNewConvName: setNewConvName,
    onSubmitNewConversation: submitNewConversation,
    renamingGroup,
    onStartRenameGroup: (currentName: string) => {
      setGroupNameDraft(currentName);
      setRenamingGroup(true);
    },
    onCancelRenameGroup: () => setRenamingGroup(false),
    groupNameDraft,
    onChangeGroupNameDraft: setGroupNameDraft,
    onSubmitRenameGroup: submitRenameGroup,
    composerText: activeConversationId === null ? chatInput : chatComposerText,
    onChangeComposerText: activeConversationId === null ? setChatInput : setChatComposerText,
    onSendComposer: activeConversationId === null ? sendChat : sendActiveChatMessage,
    onPickFile: () => chatFileInputRef.current?.click(),
    sendingAttachment,
    recordingAudio,
    recordingElapsedSec,
    recordedPreview,
    onStartRecording: startVoiceRecording,
    onStopRecording: stopVoiceRecording,
    onCancelRecording: cancelVoiceRecording,
    onDiscardRecordedAudio: discardRecordedAudio,
    onSendRecordedAudio: sendRecordedAudio,
    onDeleteMessage: deleteMessage,
    callParticipantsByConversation,
    myCallConversationId,
    callRemoteStreams,
    onJoinCall: joinCall,
    onLeaveCall: leaveCall,
    localStreamRef,
    camOn,
    onClose: () => setChatOpen(false),
    pinMode: chatPinMode,
    onToggleSidePin: toggleChatPinSide,
  };

  // props do AgendaDrawer -- gaveta própria, separada do chat (ver
  // agendaOpen).
  const agendaDrawerProps = {
    myUserId,
    onlinePlayers: Array.from(remotePlayersRef.current.values()),
    allUsers,
    calls,
    busyUserIds,
    agendaView,
    onChangeAgendaView: setAgendaView,
    agendaDetailId,
    onOpenCallDetail: openCallDetail,
    agendaForm,
    onChangeAgendaForm: updateAgendaForm,
    onToggleAgendaParticipant: toggleAgendaParticipant,
    agendaError,
    onStartNewCall: startNewCall,
    onSubmitCreateCall: submitCreateCall,
    onRespondToCall: respondToCall,
    agendaSearchQuery,
    onChangeAgendaSearchQuery: setAgendaSearchQuery,
    agendaColleagueId,
    agendaColleagueName,
    colleagueCalls,
    onViewColleagueAgenda: viewColleagueAgenda,
    onBackToMyAgenda: backToMyAgenda,
    onPickAgendaFile: () => agendaFileInputRef.current?.click(),
    onRemoveAgendaAttachment: removeAgendaFormAttachment,
    sendingAgendaAttachment,
    onPickDetailAttachment: () => agendaDetailFileInputRef.current?.click(),
    sendingDetailAttachment,
    expandedAgendaDays,
    onToggleAgendaDay: toggleAgendaDay,
    onClose: () => setAgendaOpen(false),
  };

  return (
    <div className="room-and-editor">
      {onSignOut && (
        <button type="button" className="account-sign-out-btn" onClick={onSignOut} title="Sair da conta">
          Sair da conta
        </button>
      )}
      {chatOpen && chatPinMode === "side" && <ChatDrawer {...chatDrawerProps} />}
      <div className="room-wrapper">
        <div ref={containerRef} className="phaser-container" />

        {profileCard && (
          <ProfileCard
            info={profileCard}
            myProfile={myProfile}
            onChangeMyProfile={updateMyProfile}
            onChangePhoto={handlePhotoChange}
            remoteProfile={remoteProfiles[profileCard.playerId]}
            editing={editingCharacter}
            onStartEdit={startEditingCharacter}
            onCancelEdit={cancelEditingCharacter}
            onSaveEdit={saveEditingCharacter}
            onClose={closeProfileCard}
            selectedHairId={selectedHairId}
            onSelectHair={selectHair}
            selectedHairColorId={selectedHairColorId}
            onSelectHairColor={selectHairColor}
            selectedGender={selectedGender}
            onSelectGender={selectGender}
            selectedSkinId={selectedSkinId}
            onSelectSkin={selectSkin}
            selectedBeardId={selectedBeardId}
            onSelectBeard={selectBeard}
            selectedAccessoryId={selectedAccessoryId}
            onSelectAccessory={selectAccessory}
            selectedAccessoryColorId={selectedAccessoryColorId}
            onSelectAccessoryColor={selectAccessoryColor}
            selectedOutfitId={selectedOutfitId}
            onSelectOutfit={selectOutfit}
            editorCategory={editorCategory}
            onSelectCategory={setEditorCategory}
            measuredHeight={profileCardHeight}
            onMeasuredHeight={setProfileCardHeight}
            onAskAvailable={() => sendPoke(profileCard.playerId, "available")}
            onCallOver={() => sendPoke(profileCard.playerId, "call")}
            onSendMessage={() => sendMessageTo(profileCard.playerId)}
          />
        )}

        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.text}
            </div>
          ))}
        </div>

        <video ref={localVideoRef} autoPlay muted playsInline className="local-video" />

        <div className="remote-videos">
          {Object.entries(remoteStreams).map(([id, stream]) => (
            <RemoteVideoTile
              key={id}
              stream={stream}
              meta={remoteMeta[id]}
              volume={spaceVolume * (remoteVolumes[id] ?? 1)}
              sinkId={selectedSpeakerId || undefined}
            />
          ))}
        </div>

        <div className="status-badge">{status}</div>

        {presenceCounts && (
          <div className="presence-badge" title="Quem tá na sala agora">
            {presenceCounts.memberCount} membro{presenceCounts.memberCount === 1 ? "" : "s"} · {presenceCounts.visitorCount}{" "}
            visitante{presenceCounts.visitorCount === 1 ? "" : "s"}
          </div>
        )}

        <div className="controls">
          {roomRole === "owner" && (
            <button
              className="av-btn"
              onClick={() => setMembersPanelOpen(true)}
              aria-label="Configurar membros da sala"
              data-tooltip="Membros"
            >
              <UsersIcon />
            </button>
          )}
          {roomRole === "owner" && (
            <button
              className="av-btn"
              onClick={() => setItemEditorOpen(true)}
              aria-label="Cadastrar item de móvel novo"
              data-tooltip="Itens"
            >
              <BoxIcon />
            </button>
          )}
          {canEditRoom && (
            <button
              className={editMode ? "av-btn on" : "av-btn"}
              onClick={toggleEditMode}
              aria-label={editMode ? "Sair da edição" : "Editar espaço"}
              data-tooltip={editMode ? "Sair da edição" : "Editar espaço"}
            >
              <FurnitureBrushIcon />
            </button>
          )}
        </div>

        {membersPanelOpen && accountAccessToken && (
          <RoomMembersPanel
            accessToken={accountAccessToken}
            httpBase={REALTIME_HTTP_BASE}
            onClose={() => setMembersPanelOpen(false)}
          />
        )}

        {itemEditorOpen && accountAccessToken && (
          <ItemEditor
            accessToken={accountAccessToken}
            onClose={() => setItemEditorOpen(false)}
            onItemsChanged={() => {
              fetchAndRegisterCustomFurniture();
              fetchAndRegisterCustomSkins();
              fetchAndRegisterCustomAvatarItems();
            }}
          />
        )}

        {/* Grupo "Mover"/"Apagar" -- pedido do Douglas: os dois juntos num
            botão flutuante próprio, no MESMO rumo dos controles de zoom
            (mesma borda direita) mas bem mais acima, fora da área do
            painel de móveis (ver .map-tool-group em globals.css -- é
            position:absolute dentro de .room-wrapper, não fixed no
            viewport, senão ficava atrás do painel quando ele abre). */}
        {canEditRoom && editMode && (
          <div className="map-tool-group">
            <button
              className={moveToolActive ? "map-move-btn active" : "map-move-btn"}
              onClick={toggleMoveTool}
              aria-label="Mover item"
              data-tooltip={moveToolActive ? "Clique num item, depois no lugar novo" : "Mover item"}
            >
              <MoveIcon />
            </button>
            <button
              className={deleteToolActive ? "map-delete-btn active" : "map-delete-btn"}
              onClick={toggleDeleteTool}
              aria-label="Apagar item"
              data-tooltip={deleteToolActive ? "Clique num item pra apagar" : "Apagar item"}
            >
              <TrashIcon />
            </button>
          </div>
        )}

        <div className="map-controls">
          <button
            className="map-recenter-btn"
            onClick={handleRecenterCamera}
            aria-label="Centralizar no meu personagem"
            data-tooltip="Centralizar"
          >
            <TargetIcon />
          </button>
          <div className="map-zoom-control">
            <button
              className="map-zoom-btn"
              onClick={handleZoomIn}
              disabled={mapZoom >= MAX_ZOOM_LEVEL}
              aria-label="Aproximar"
              data-tooltip="Aproximar"
            >
              <PlusIcon />
            </button>
            <div className="map-zoom-divider" />
            <button
              className="map-zoom-btn"
              onClick={handleZoomOut}
              disabled={mapZoom <= MIN_ZOOM_LEVEL}
              aria-label="Afastar"
              data-tooltip="Afastar"
            >
              <MinusIcon />
            </button>
          </div>
        </div>

        <div className="av-bar">
          <button
            className={micOn ? "av-btn" : "av-btn off"}
            onClick={toggleMic}
            aria-label={micOn ? "Desligar microfone" : "Ligar microfone"}
            data-tooltip={micOn ? "Desligar microfone" : "Ligar microfone"}
          >
            <MicIcon off={!micOn} />
          </button>
          <button
            className={camOn ? "av-btn" : "av-btn off"}
            onClick={toggleCam}
            aria-label={camOn ? "Desligar câmera" : "Ligar câmera"}
            data-tooltip={camOn ? "Desligar câmera" : "Ligar câmera"}
          >
            <CamIcon off={!camOn} />
          </button>
          <button
            className={screenOn ? "av-btn on" : "av-btn"}
            onClick={toggleScreenShare}
            aria-label={screenOn ? "Parar de compartilhar tela" : "Compartilhar tela"}
            data-tooltip={screenOn ? "Parar de compartilhar" : "Compartilhar tela"}
          >
            <ScreenIcon active={screenOn} />
          </button>
          <button
            className={chatOpen ? "av-btn on" : "av-btn"}
            onClick={() => setChatOpen((v) => !v)}
            aria-label={chatOpen ? "Fechar chat" : "Abrir chat"}
            data-tooltip={chatOpen ? "Fechar chat" : "Chat"}
          >
            <ChatIcon />
          </button>
          <button
            className={agendaOpen ? "av-btn on" : "av-btn"}
            onClick={() => setAgendaOpen((v) => !v)}
            aria-label={agendaOpen ? "Fechar agenda" : "Abrir agenda"}
            data-tooltip={agendaOpen ? "Fechar agenda" : "Agenda"}
          >
            <AgendaIcon />
          </button>
          <button
            className={settingsOpen ? "av-btn on" : "av-btn"}
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label={settingsOpen ? "Fechar configurações" : "Configurações"}
            data-tooltip={settingsOpen ? "Fechar configurações" : "Configurações"}
          >
            <GearIcon />
          </button>
        </div>

        {chatOpen && chatPinMode !== "side" && <ChatDrawer {...chatDrawerProps} />}
        {agendaOpen && <AgendaDrawer {...agendaDrawerProps} />}
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
            remoteUsers={Object.keys(remoteStreams).map((id) => ({ id, name: remoteMeta[id]?.name || "Jogador" }))}
            remoteVolumes={remoteVolumes}
            onChangeRemoteVolume={changeRemoteVolume}
          />
        )}
        <input
          ref={chatFileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleChatFileChange}
        />
        <input
          ref={agendaFileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleAgendaFileChange}
        />
        <input
          ref={agendaDetailFileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleAgendaDetailFileChange}
        />
      </div>

      {canEditRoom && editMode && (
        <EditPanel
          activeCategory={activeCategory}
          onChangeCategory={changeCategory}
          selectedCatalogIndex={selectedCatalogIndex}
          onSelectCatalog={selectCatalog}
          selectedColorId={selectedColorId}
          onSelectColor={selectFurnitureColor}
          seatTuningInfo={seatTuningInfo}
          onStandUpFromSeatTuning={standUpFromSeatTuning}
          onResetSeatTuning={resetSeatTuning}
          selectedFloorToolId={selectedFloorToolId}
          onSelectFloorPaint={selectFloorPaint}
          onSelectFloorEraser={selectFloorEraser}
          draftFloorItems={draftFloorItems}
          onClearAllFloor={clearDraftFloorItems}
          floorSaveStatus={floorSaveStatus}
          draftAreaDefs={draftAreaDefs}
          onCreateArea={createArea}
          onRemoveArea={removeArea}
          selectedAreaToolId={selectedAreaToolId}
          onSelectAreaPaint={selectAreaPaint}
          onSelectAreaEraser={selectAreaEraser}
          draftAreaItems={draftAreaItems}
          onClearAllArea={clearDraftAreaItems}
          areaSaveStatus={areaSaveStatus}
        />
      )}
    </div>
  );
}

// Barra de categoria do editor de espaço -- um ícone por categoria, na
// ORDEM que o Douglas pediu (poltrona, sofá, mesa, planta, computador),
// com "divisória" (vidro, já existia antes desse pedido) e "piso" no
// fim. Fica fora do componente por ser uma lista estática (não depende
// de nenhuma prop) -- os ícones em si ficam definidos logo abaixo do
// EditPanel. Fundo uniforme (nada de cor por categoria -- já testamos e
// o Douglas não gostou) + glifo branco chapado, igual o rail de
// categoria do Gather; só o item selecionado se destaca (brilho/anel,
// ver .category-icon-btn.selected no CSS).
// rótulo em português de cada direção -- usado no painel "Assento" (ver
// seatTuningInfo.facing) pra mostrar qual lado da peça tá sendo
// ajustado agora.
const FACING_LABEL: Record<Direction, string> = {
  down: "frente",
  left: "lado esq.",
  right: "lado dir.",
  up: "costas",
};

const EDIT_CATEGORY_TABS: {
  id: FurnitureCategoryId | "piso" | "area" | "assento";
  label: string;
  icon: () => JSX.Element;
}[] = [
  { id: "poltrona", label: "Poltrona", icon: ArmchairIcon },
  { id: "sofa", label: "Sofá", icon: SofaIcon },
  { id: "mesa", label: "Mesa", icon: TableIcon },
  { id: "planta", label: "Planta", icon: PlantIcon },
  { id: "computador", label: "Computador", icon: ComputerIcon },
  // era "Divisória" -- pedido do Douglas: essa categoria (tipo "vidro",
  // ver FURNITURE_TYPE_CATEGORY em game/furniture.ts) agora é a aba
  // "Parede" dentro da seção "Mapa" (ver EDIT_SECTIONS/CATEGORY_SECTION
  // abaixo) -- MESMO sistema de sempre (objeto que bloqueia passagem,
  // ver FURNITURE_BLOCKS_MOVEMENT.vidro), só rebatizado. Item custom
  // com CARA de parede (opaco, em vez do vidro decorativo de hoje) sobe
  // como um MODELO NOVO dessa mesma categoria pelo Editor de Itens,
  // sem precisar de tipo/categoria nova no código.
  { id: "divisoria", label: "Parede", icon: DividerIcon },
  { id: "piso", label: "Piso", icon: FloorIcon },
  { id: "area", label: "Área", icon: AreaIcon },
  // "Assento": ajuste fino (setas) de onde o boneco senta em cada
  // MODELO de móvel sentável -- ver resolveSeatOffset em
  // game/furniture.ts. Só existe aqui dentro do "Editar espaço" (mesma
  // trava de sempre, canEditRoom), não é uma categoria de móvel de
  // verdade (não tem paleta pra colocar item nenhum).
  { id: "assento", label: "Assento", icon: SeatTuneIcon },
  // "Mover" SAIU daqui -- pedido do Douglas: virou botão flutuante
  // agrupado com "Apagar" (ver .map-tool-group/toggleMoveTool), não é
  // mais aba de categoria. MoveIcon continua definida embaixo, agora só
  // usada por esse botão flutuante.
];

/**
 * 3 seções de topo do painel de edição (pedido do Douglas, ver print de
 * referência: "Minha mesa"/"Construir"/"Mapa") -- agrupam as categorias
 * de EDIT_CATEGORY_TABS acima por "o que você tá editando", em vez da
 * barra de ícones plana de antes (9 abas soltas, sem hierarquia). Clicar
 * numa seção troca pra categoria PADRÃO dela (defaultCategory) usando o
 * MESMO onChangeCategory de sempre -- não existe estado novo pra seção
 * ativa, ela é sempre DERIVADA da activeCategory atual (ver
 * CATEGORY_SECTION/activeSection dentro de EditPanel), então não tem
 * como os dois desincronizarem.
 */
const EDIT_SECTIONS: {
  id: "moveis" | "construir" | "mapa";
  label: string;
  icon: () => JSX.Element;
  defaultCategory: FurnitureCategoryId | "piso" | "area" | "assento";
}[] = [
  // rótulos ajustados a pedido do Douglas: "Minha mesa"->"Mobília",
  // "Construir"->"Piso", "Mapa"->"Parede" (ids internos continuam os
  // mesmos, só o texto exibido mudou).
  { id: "moveis", label: "Mobília", icon: DeskIcon, defaultCategory: "poltrona" },
  { id: "construir", label: "Piso", icon: BuildIcon, defaultCategory: "piso" },
  { id: "mapa", label: "Parede", icon: MapIcon, defaultCategory: "divisoria" },
];

// categoria -> seção (inverso de EDIT_SECTIONS[].defaultCategory, mas
// com TODAS as categorias de cada seção, não só a padrão). "assento"
// entra em "moveis" -- é ajuste fino de móvel sentável, não faz sentido
// em outra seção.
const CATEGORY_SECTION: Record<FurnitureCategoryId | "piso" | "area" | "assento", "moveis" | "construir" | "mapa"> = {
  poltrona: "moveis",
  sofa: "moveis",
  mesa: "moveis",
  planta: "moveis",
  computador: "moveis",
  assento: "moveis",
  piso: "construir",
  area: "construir",
  divisoria: "mapa",
};

function EditPanel({
  activeCategory,
  onChangeCategory,
  selectedCatalogIndex,
  onSelectCatalog,
  selectedColorId,
  onSelectColor,
  seatTuningInfo,
  onStandUpFromSeatTuning,
  onResetSeatTuning,
  selectedFloorToolId,
  onSelectFloorPaint,
  onSelectFloorEraser,
  draftFloorItems,
  onClearAllFloor,
  floorSaveStatus,
  draftAreaDefs,
  onCreateArea,
  onRemoveArea,
  selectedAreaToolId,
  onSelectAreaPaint,
  onSelectAreaEraser,
  draftAreaItems,
  onClearAllArea,
  areaSaveStatus,
}: {
  activeCategory: FurnitureCategoryId | "piso" | "area" | "assento";
  onChangeCategory: (category: FurnitureCategoryId | "piso" | "area" | "assento") => void;
  selectedCatalogIndex: number | null;
  onSelectCatalog: (index: number) => void;
  selectedColorId: string | null;
  onSelectColor: (colorId: string) => void;
  seatTuningInfo: SeatTuningInfo | null;
  onStandUpFromSeatTuning: () => void;
  onResetSeatTuning: () => void;
  selectedFloorToolId: string | "erase" | null;
  onSelectFloorPaint: (entry: FloorCatalogEntry) => void;
  onSelectFloorEraser: () => void;
  draftFloorItems: FloorTileDef[];
  onClearAllFloor: () => void;
  floorSaveStatus: "idle" | "saving" | "saved" | "error";
  draftAreaDefs: AreaDef[];
  onCreateArea: (name: string, type: AreaType) => void;
  onRemoveArea: (id: string) => void;
  selectedAreaToolId: string | "erase" | null;
  onSelectAreaPaint: (id: string) => void;
  onSelectAreaEraser: () => void;
  draftAreaItems: AreaTileDef[];
  onClearAllArea: () => void;
  areaSaveStatus: "idle" | "saving" | "saved" | "error";
}) {
  const activeCategoryLabel = EDIT_CATEGORY_TABS.find((c) => c.id === activeCategory)?.label ?? "";

  // seção ativa é SEMPRE derivada da categoria ativa (ver comentário em
  // CATEGORY_SECTION acima) -- nunca vira estado próprio, então não tem
  // como desincronizar da aba de categoria de fato selecionada.
  const activeSection = CATEGORY_SECTION[activeCategory];
  const categoryTabsInSection = EDIT_CATEGORY_TABS.filter((cat) => CATEGORY_SECTION[cat.id] === activeSection);

  // busca por texto (pedido do Douglas, ver print de referência
  // "Pesquisar objetos") -- filtra a paleta de móveis E a de piso
  // (não faz sentido em "área"/"assento", que não têm paleta pra
  // procurar nada). Estado só LOCAL desse painel (não precisa subir pro
  // GameRoom) -- limpa sozinho ao trocar de categoria, senão um termo
  // digitado numa aba "vaza" pra outra e parece que sumiu tudo.
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    setSearchQuery("");
  }, [activeCategory]);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredFloorCatalog = normalizedQuery
    ? FLOOR_CATALOG.filter((entry) => entry.label.toLowerCase().includes(normalizedQuery))
    : FLOOR_CATALOG;

  // um GRUPO por botão na grade (não mais um por direção, ver
  // catalogEntryGroupKey/catalogIndicesForGroup em game/furniture.ts):
  // escolher um GRUPO (modelo, ver catalogEntryGroupKey -- ou o tipo,
  // pra design único como o vidro) já seleciona a direção "padrão" dele
  // (a primeira em FURNITURE_ROTATE_ORDER que existir); depois disso o
  // preview embaixo deixa girar pra trocar de direção sem precisar
  // voltar na grade. Categoria com modelo cadastrado (ex: poltrona, ver
  // Gamer/Poltrona Lecce) só mostra os grupos DE MODELO -- o design
  // único antigo (sem modelId) fica de fora da paleta (ver comentário em
  // FURNITURE_CATALOG_STATIC, game/furniture.ts), continua existindo só
  // nos itens fixos antigos de ROOM_FURNITURE.
  const categoryEntries =
    activeCategory === "piso" || activeCategory === "area" || activeCategory === "assento"
      ? []
      : FURNITURE_CATALOG.filter((e) => FURNITURE_TYPE_CATEGORY[e.type] === activeCategory);
  const hasModelsInCategory = categoryEntries.some((e) => e.modelId);
  const paletteEntries = hasModelsInCategory ? categoryEntries.filter((e) => e.modelId) : categoryEntries;
  const allGroupsInCategory: string[] = Array.from(new Set(paletteEntries.map((e) => catalogEntryGroupKey(e))));
  // filtra pelo texto buscado, comparando com o LABEL do modelo (o
  // mesmo que aparece no title do botão/no preview grande) -- não
  // filtra nada com a busca vazia.
  const groupsInCategory = normalizedQuery
    ? allGroupsInCategory.filter((groupKey) => {
        const entry = FURNITURE_CATALOG[catalogIndicesForGroup(groupKey)[0]];
        return entry?.label.toLowerCase().includes(normalizedQuery);
      })
    : allGroupsInCategory;

  const selectedEntry = selectedCatalogIndex !== null ? FURNITURE_CATALOG[selectedCatalogIndex] : null;

  // arte pra mostrar (thumbnail da grade OU preview grande) de uma
  // entrada de catálogo -- pega pela cor ESCOLHIDA quando tiver
  // (selectedColorId, só faz sentido pro item selecionado de verdade,
  // ver uso abaixo) ou pela cor default da entrada, senão cai no design
  // único do tipo (furnitureArtFile, caso do vidro).
  function catalogEntryArtFile(entry: FurnitureCatalogEntry, colorIdOverride?: string | null): string | null {
    if (entry.colors) {
      const color = entry.colors.find((c) => c.id === colorIdOverride) ?? entry.colors.find((c) => c.id === entry.colorId);
      if (color) return color.art[entry.facing] ?? color.art.down ?? null;
    }
    return furnitureArtFile(entry.type, entry.facing);
  }

  // miniatura do BOTÃO da grade do catálogo (palette-btn) -- diferente
  // de catalogEntryArtFile acima (usado no preview grande/swatches, que
  // precisam da arte REAL da peça): aqui prefere o ícone PRÓPRIO
  // cadastrado no Editor de Itens (model.iconUrl, pedido do Douglas:
  // "escolher o favicon que aparece no catálogo"), quando o item tiver
  // um -- cai pra arte normal (catalogEntryArtFile) quando não tiver
  // (item de fábrica, ou custom cadastrado antes desse campo existir).
  function catalogEntryIconFile(entry: FurnitureCatalogEntry): string | null {
    if (entry.modelId) {
      const model = furnitureModelById(entry.modelId);
      if (model?.iconUrl) return model.iconUrl;
    }
    return catalogEntryArtFile(entry);
  }

  // gira o item selecionado dentro das direções cadastradas pro GRUPO
  // dele (ver catalogIndicesForGroup) -- reusa onSelectCatalog direto
  // (mesma função que os botões da grade chamam), só troca pra outro
  // índice do catálogo, então nem precisa de handler novo na cena.
  function rotateSelected(direction: -1 | 1) {
    if (!selectedEntry) return;
    const indices = catalogIndicesForGroup(catalogEntryGroupKey(selectedEntry));
    if (indices.length <= 1) return;
    const pos = indices.indexOf(selectedCatalogIndex!);
    const nextPos = (pos + direction + indices.length) % indices.length;
    onSelectCatalog(indices[nextPos]);
  }

  return (
    <div className="edit-panel">
      <h2>Editar espaço</h2>

      {/* 3 seções de topo (Minha mesa/Construir/Mapa) -- pedido do
          Douglas. Trocar de seção vai pra categoria PADRÃO dela; a
          barra de categoria logo abaixo (existente desde antes) some
          quando a seção só tem 1 categoria (caso de "Mapa", só tem
          "Parede" por enquanto). */}
      <div className="edit-section-tabs">
        {EDIT_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              className={activeSection === section.id ? "edit-section-tab selected" : "edit-section-tab"}
              onClick={() => onChangeCategory(section.defaultCategory)}
            >
              <Icon />
              <span>{section.label}</span>
            </button>
          );
        })}
      </div>

      {categoryTabsInSection.length > 1 && (
        <div className="category-icon-bar">
          {categoryTabsInSection.map((cat) => {
            const Icon = cat.icon;
            return (
              <button
                key={cat.id}
                className={activeCategory === cat.id ? "category-icon-btn selected" : "category-icon-btn"}
                onClick={() => onChangeCategory(cat.id)}
                title={cat.label}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      )}

      {activeCategory === "piso" ? (
        <>
          <p className="edit-hint">
            Escolha um modelo abaixo e clique num quadrado da sala pra pintar só
            ele ("unitário"), ou clique e arraste pra pintar vários de uma vez.
            "Apagar piso" volta o quadrado pro fundo padrão da sala. Salva sozinho.
          </p>

          {/* pedido do Douglas: apagar piso é "mais sensível" que apagar
              móvel (desfaz área andável) -- por isso ganhou um botão
              PRÓPRIO, com ícone, separado da grade de modelos (antes era
              só mais um item de texto dentro de .floor-palette, fácil de
              clicar sem querer no meio dos outros). */}
          <button
            className={selectedFloorToolId === "erase" ? "floor-erase-standalone-btn selected" : "floor-erase-standalone-btn"}
            onClick={onSelectFloorEraser}
            title="Apagar piso pintado (volta pro fundo padrão)"
          >
            <TrashIcon />
            Apagar piso
          </button>

          <input
            type="search"
            className="catalog-search-input"
            placeholder="Pesquisar pisos"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="floor-palette">
            {filteredFloorCatalog.map((entry) => (
              <button
                key={entry.id}
                className={selectedFloorToolId === entry.id ? "floor-swatch selected" : "floor-swatch"}
                style={{ backgroundImage: `url(/assets/${entry.file})` }}
                onClick={() => onSelectFloorPaint(entry)}
                title={entry.label}
              />
            ))}
          </div>
          {filteredFloorCatalog.length === 0 && (
            <p className="edit-hint">
              {normalizedQuery
                ? `Nada encontrado pra "${searchQuery.trim()}".`
                : "Nenhum modelo de piso ainda -- suba as imagens na pasta de origem."}
            </p>
          )}

          <h3>
            Piso pintado ({draftFloorItems.length})
            <span className={`floor-save-status floor-save-status-${floorSaveStatus}`}>
              {floorSaveStatus === "saving" && "Salvando…"}
              {floorSaveStatus === "saved" && "Salvo ✓"}
              {floorSaveStatus === "error" && "Erro ao salvar"}
            </span>
          </h3>
          {draftFloorItems.length === 0 && <p className="edit-hint">Nenhum quadrado pintado ainda.</p>}
          {draftFloorItems.length > 0 && (
            <button className="clear-btn" onClick={onClearAllFloor}>
              Limpar tudo
            </button>
          )}
        </>
      ) : activeCategory === "area" ? (
        <>
          <p className="edit-hint">
            Primeiro crie a área (nome + tipo) abaixo, depois selecione ela na
            lista pra pintar/arrastar os tiles dela -- áreas diferentes NÃO se
            fundem mesmo encostadas. "Mesa privada" ganha um botão "Tomar
            posse" na sala (só aparece enquanto ninguém for dono; áudio/vídeo
            de quem tá dentro fica isolado). "Sala": mesma isolação de
            áudio/vídeo, sem dono. Salva sozinho.
          </p>

          <AreaCreateForm onCreate={onCreateArea} />

          {draftAreaDefs.length === 0 ? (
            <p className="edit-hint">Nenhuma área criada ainda.</p>
          ) : (
            <ul className="area-def-list">
              {draftAreaDefs.map((def) => {
                const meta = AREA_TYPES.find((t) => t.id === def.type)!;
                const tileCount = draftAreaItems.filter((t) => t.areaId === def.id).length;
                return (
                  <li key={def.id}>
                    <button
                      className={selectedAreaToolId === def.id ? "area-def-row selected" : "area-def-row"}
                      onClick={() => onSelectAreaPaint(def.id)}
                      title={`Pintar tiles de "${def.name}"`}
                    >
                      <span
                        className="area-def-dot"
                        style={{ backgroundColor: `#${meta.color.toString(16).padStart(6, "0")}` }}
                      />
                      <span className="area-def-name">{def.name}</span>
                      <span className="area-def-meta">
                        {meta.label} · {tileCount} {tileCount === 1 ? "quadrado" : "quadrados"}
                      </span>
                    </button>
                    <button
                      className="area-def-remove"
                      onClick={() => onRemoveArea(def.id)}
                      title={`Apagar área "${def.name}"`}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="floor-palette">
            <button
              className={selectedAreaToolId === "erase" ? "floor-eraser-btn selected" : "floor-eraser-btn"}
              onClick={onSelectAreaEraser}
              title="Apagar área pintada"
            >
              ✕ Apagar
            </button>
          </div>

          <h3>
            Quadrados pintados ({draftAreaItems.length})
            <span className={`floor-save-status floor-save-status-${areaSaveStatus}`}>
              {areaSaveStatus === "saving" && "Salvando…"}
              {areaSaveStatus === "saved" && "Salvo ✓"}
              {areaSaveStatus === "error" && "Erro ao salvar"}
            </span>
          </h3>
          {draftAreaItems.length === 0 && <p className="edit-hint">Nenhum quadrado pintado ainda.</p>}
          {draftAreaItems.length > 0 && (
            <button className="clear-btn" onClick={onClearAllArea}>
              Limpar tudo
            </button>
          )}
        </>
      ) : activeCategory === "assento" ? (
        <>
          <p className="edit-hint">
            Coloque uma peça sentável (aba de móvel, ex: "Poltrona") e sente
            nela pra ajustar -- com essa aba ligada, as setas do teclado não
            levantam mais, elas movem o boneco fino (1px; segure Shift pra
            5px de uma vez). O ajuste vale pro MODELO inteiro (todas as
            peças iguais já colocadas, viradas pra essa mesma direção), não
            só a que você sentou. Salva sozinho.
          </p>
          {seatTuningInfo ? (
            <div className="seat-tuning-panel">
              <p className="seat-tuning-target">
                {seatTuningInfo.label} — {FACING_LABEL[seatTuningInfo.facing]}
              </p>
              <p className="seat-tuning-coords">
                x: {seatTuningInfo.x}px · y: {seatTuningInfo.y}px
              </p>
              <div className="seat-tuning-actions">
                <button className="clear-btn" onClick={onResetSeatTuning}>
                  Redefinir
                </button>
                <button className="clear-btn" onClick={onStandUpFromSeatTuning}>
                  Sair do assento
                </button>
              </div>
            </div>
          ) : (
            <p className="edit-hint">Sente numa peça pra ver o ajuste aqui.</p>
          )}
        </>
      ) : (
        <>
          <input
            type="search"
            className="catalog-search-input"
            placeholder="Pesquisar objetos"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="palette">
            {groupsInCategory.map((groupKey) => {
              const indices = catalogIndicesForGroup(groupKey);
              const defaultIndex = indices[0];
              const groupEntry = FURNITURE_CATALOG[defaultIndex];
              const isSelected = selectedEntry ? catalogEntryGroupKey(selectedEntry) === groupKey : false;
              const thumbFile = catalogEntryIconFile(groupEntry);
              return (
                <button
                  key={groupKey}
                  className={isSelected ? "palette-btn selected" : "palette-btn"}
                  style={thumbFile ? { backgroundImage: `url(${furnitureAssetUrl(thumbFile)})` } : undefined}
                  onClick={() => onSelectCatalog(defaultIndex)}
                  title={groupEntry.label}
                />
              );
            })}
          </div>
          {groupsInCategory.length === 0 && (
            <p className="edit-hint">
              {normalizedQuery
                ? `Nada encontrado pra "${searchQuery.trim()}".`
                : `Nenhum modelo de ${activeCategoryLabel} ainda -- suba as artes na pasta de origem.`}
            </p>
          )}

          {selectedEntry &&
            (() => {
              const canRotate = catalogIndicesForGroup(catalogEntryGroupKey(selectedEntry)).length > 1;
              const artFile = catalogEntryArtFile(selectedEntry, selectedColorId);
              // cores dessa peça: as do MODELO quando tiver (ver
              // FurnitureCatalogEntry.colors, gerado a partir da pasta de
              // origem, ver scripts/syncFurnitureAssets.mjs), senão cai
              // em FURNITURE_COLORS[type] (design único, hoje sempre
              // vazio -- "Em breve", mesmo padrão de cabelo/acessório sem
              // gerar ainda).
              const colorOptions = selectedEntry.colors ?? FURNITURE_COLORS[selectedEntry.type] ?? [];
              const activeColorId = selectedColorId ?? selectedEntry.colorId;
              return (
                <div className="item-preview">
                  <div className="item-preview-main">
                    <div className="item-preview-row">
                      <button
                        className="item-preview-rotate"
                        onClick={() => rotateSelected(-1)}
                        disabled={!canRotate}
                        title="Girar (anti-horário)"
                      >
                        <RotateLeftIcon />
                      </button>
                      {artFile && (
                        <img className="item-preview-img" src={furnitureAssetUrl(artFile)} alt={selectedEntry.label} />
                      )}
                      <button
                        className="item-preview-rotate"
                        onClick={() => rotateSelected(1)}
                        disabled={!canRotate}
                        title="Girar (horário)"
                      >
                        <RotateRightIcon />
                      </button>
                    </div>
                    <p className="item-preview-label">{selectedEntry.label}</p>
                  </div>

                  <div className="item-preview-colors">
                    <span className="color-picker-label">Cores</span>
                    {colorOptions.length > 0 ? (
                      <div className="color-swatches">
                        {colorOptions.map((c) => {
                          // FurnitureModelColorOption (modelo) e
                          // FurnitureColorOption (design único) têm o
                          // MESMO formato de `art` na prática (só muda se
                          // é obrigatório ou parcial no tipo) -- mesma
                          // função serve pras duas, ver furnitureColorArtFile.
                          const swatchArt = furnitureColorArtFile(c, selectedEntry.facing);
                          return (
                            <button
                              key={c.id}
                              className={c.id === activeColorId ? "color-swatch selected" : "color-swatch"}
                              style={{
                                width: 22,
                                height: 22,
                                backgroundImage: swatchArt ? `url(${furnitureAssetUrl(swatchArt)})` : undefined,
                                backgroundSize: "cover",
                              }}
                              onClick={() => onSelectColor(c.id)}
                              title={c.label}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <span className="color-picker-empty">Em breve</span>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* pedido do Douglas: apagar item agora é direto no espaço (ver
              .map-delete-btn/toggleDeleteTool) -- primeiro só a lista
              "Itens colocados" (um <li> por item) tinha saído, sobrando a
              contagem + status de salvamento + botão de limpar tudo;
              agora esse resto saiu junto também ("remove essas opções
              aqui", print do cabeçalho "Itens colocados (4) Erro ao
              salvar" + "Limpar tudo") -- o painel de móveis não mostra
              mais nada disso, só a paleta pra colocar item mesmo. */}
        </>
      )}
    </div>
  );
}

// Formulário pra criar uma área nova (nome + tipo, ver AreaDef em
// game/areas.ts) -- separado do EditPanel só pra poder ter seu próprio
// estado local (o texto do nome enquanto digita) sem sujar o state do
// componente pai. Ao criar, limpa o campo de nome (mas mantém o tipo
// escolhido, já que criar várias áreas do mesmo tipo em seguida --
// várias mesas privadas -- é o caso comum).
function AreaCreateForm({ onCreate }: { onCreate: (name: string, type: AreaType) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AreaType>("mesa-privada");

  function submit() {
    if (!name.trim()) return;
    onCreate(name, type);
    setName("");
  }

  return (
    <div className="area-create-form">
      <input
        className="area-create-input"
        type="text"
        placeholder="Nome da área (ex: Mesa da Ana)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <select
        className="area-create-select"
        value={type}
        onChange={(e) => setType(e.target.value as AreaType)}
      >
        {AREA_TYPES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <button className="area-create-btn" onClick={submit} disabled={!name.trim()}>
        + Criar
      </button>
    </div>
  );
}

// Ícones da barra de categoria do editor de espaço -- glifo BRANCO
// CHAPADO (preenchido, sem contorno fino), não miniatura da arte de
// verdade do item, só um símbolo genérico representando a categoria.
// Estilo copiado do rail de categoria do próprio Gather (print que o
// Douglas mandou): forma sólida/bloco simples, sem linha fina nem cor
// por categoria -- só o fundo do botão que já muda no hover/selecionado
// (ver .category-icon-btn no CSS).
function ArmchairIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 4.8A2.8 2.8 0 0 1 8.8 2h6.4A2.8 2.8 0 0 1 18 4.8V10H6V4.8Z" />
      <rect x="4" y="10" width="16" height="7" rx="2" />
      <rect x="5.3" y="17.3" width="2.2" height="4" rx="1" />
      <rect x="16.5" y="17.3" width="2.2" height="4" rx="1" />
    </svg>
  );
}

function SofaIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6.3A1.7 1.7 0 0 1 7.7 4.6h8.6A1.7 1.7 0 0 1 18 6.3V11H6V6.3Z" />
      <rect x="2.3" y="10" width="3.2" height="7.7" rx="1.3" />
      <rect x="18.5" y="10" width="3.2" height="7.7" rx="1.3" />
      <rect x="4.3" y="11" width="15.4" height="6.2" rx="1.8" />
      <rect x="5.5" y="18" width="2.2" height="3.2" rx="1" />
      <rect x="16.3" y="18" width="2.2" height="3.2" rx="1" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <rect x="2.3" y="5.3" width="19.4" height="3.4" rx="1.3" />
      <rect x="4.8" y="8.7" width="2.4" height="10.8" rx="1.1" />
      <rect x="16.8" y="8.7" width="2.4" height="10.8" rx="1.1" />
    </svg>
  );
}

function PlantIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 10.2c2.9 0 5.2-2.2 5.2-5.5C13.5 4.7 12 6.6 12 9c0-2.4-1.5-4.3-5.2-4.3 0 3.3 2.3 5.5 5.2 5.5Z" />
      <path d="M8.1 21h7.8l-1.1-8H9.2l-1.1 8Z" />
    </svg>
  );
}

function ComputerIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <rect x="9.7" y="17.3" width="4.6" height="2.1" rx="0.9" />
      <rect x="6.8" y="19.8" width="10.4" height="1.9" rx="0.95" />
    </svg>
  );
}

function DividerIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="3" width="7.2" height="18" rx="1.3" />
      <rect x="12.8" y="3" width="7.2" height="18" rx="1.3" opacity="0.6" />
    </svg>
  );
}

// ícone da seção "Minha mesa" (ver EDIT_SECTIONS) -- mesa com gaveta,
// de propósito DIFERENTE do TableIcon (usado pela aba de categoria
// "Mesa" dentro dessa mesma seção) pra não confundir as duas.
function DeskIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <rect x="2.3" y="4" width="19.4" height="4.4" rx="1.2" />
      <rect x="2.3" y="9.4" width="19.4" height="9" rx="1.4" opacity="0.55" />
      <rect x="4.3" y="12" width="6" height="2.4" rx="1" fill="#16101f" />
    </svg>
  );
}

// ícone da seção "Construir" (ver EDIT_SECTIONS) -- martelo + chave,
// dupla clássica de "ferramenta/construção".
function BuildIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <path
        d="M14.7 6.3 17.7 3.3a3 3 0 0 1 4 4l-3 3M3 21l7-7M9 7l3 3-7 7-3-3 7-7ZM13 11l7.5 7.5a2 2 0 1 1-3 3L10 14"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ícone da seção "Mapa" (ver EDIT_SECTIONS) -- mapa dobrado (3 painéis),
// bem reconhecível mesmo pequeno.
function MapIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <path
        d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function FloorIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <rect x="2.5" y="2.5" width="8.2" height="8.2" rx="1.6" />
      <rect x="13.3" y="2.5" width="8.2" height="8.2" rx="1.6" />
      <rect x="2.5" y="13.3" width="8.2" height="8.2" rx="1.6" />
      <rect x="13.3" y="13.3" width="8.2" height="8.2" rx="1.6" />
    </svg>
  );
}

// ícone da aba "Área" (ver EDIT_CATEGORY_TABS) -- um quadrado tracejado
// (zona demarcada, não um objeto físico como os outros ícones) com um
// "alvo"/ponto no meio, pra diferenciar visualmente de "Piso" (grade de
// quadrados cheios).
function AreaIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeDasharray="4 3"
      />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

// ícone da aba "Assento" (ver EDIT_CATEGORY_TABS) -- 4 setas ao redor de
// um ponto central (ajuste fino de posição), pra diferenciar visualmente
// de área (quadrado tracejado com alvo) e piso (grade cheia).
function SeatTuneIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 2.5 9.3 6.6h5.4L12 2.5z" />
      <path d="M12 21.5 9.3 17.4h5.4L12 21.5z" />
      <path d="M2.5 12 6.6 9.3v5.4L2.5 12z" />
      <path d="M21.5 12 17.4 9.3v5.4L21.5 12z" />
    </svg>
  );
}

// Botão flutuante "Mover" (ver .map-move-btn/toggleMoveTool/selectMoveTool)
// -- cruz de 4 setas, ícone universal de "arrastar/reposicionar"
// (diferente da bússola de 4 pontas do SeatTuneIcon acima, pra não
// confundir os dois).
function MoveIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
      <polyline points="5 9 2 12 5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="9 5 12 2 15 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="15 19 12 22 9 19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="19 9 22 12 19 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12" y1="2" x2="12" y2="22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// Setas de girar do preview do item selecionado (ver item-preview em
// EditPanel) -- contorno fino, igual o resto dos ícones "de ação" desse
// arquivo (BackIcon, PlusIcon etc.), diferente dos ícones chapados da
// barra de categoria.
function RotateLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3 16.5V12h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RotateRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M19.5 12a7.5 7.5 0 1 0-2.2 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M21 16.5V12h-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// tamanho de exibição da miniatura de cabelo (recorte do frame 0 -- "de
// frente parado" -- do spritesheet, ver game/customization.ts). O
// spritesheet inteiro tem 1614x522px (grade 8x2, frame 200x260, ver
// FRAME_W/FRAME_H em MainScene.ts); a miniatura escala o sheet TODO
// (via background-size) e usa background-position pra mostrar só o
// canto onde o frame 0 fica (0,0) -- não precisa de nenhum arquivo novo.
const HAIR_THUMB_W = 64;
const HAIR_THUMB_H = 83.2; // mantém a proporção 200:260 do frame
const HAIR_SHEET_W = 1614;
const HAIR_SHEET_H = 522;

// mesmo recorte (frame 0, mesmo spritesheet 1614x522), só que MAIOR --
// é o "boneco" que fica fixo no topo do editor mostrando ao vivo o
// resultado de cada escolha (base + cabelo selecionado empilhados, ver
// AvatarPreviewLayer), igual ao editor de personagem do Habbo.
const AVATAR_PREVIEW_W = 104;
const AVATAR_PREVIEW_H = 135.2; // mantém a proporção 200:260 do frame

// miniatura de uma COR de cabelo (dentro de "Cores de ..."): mesmo
// recorte de frame 0 que hair-thumb/avatar-preview, só que BEM menor --
// é um seletor de variação, não a grade principal de penteados.
const COLOR_SWATCH_W = 32;
const COLOR_SWATCH_H = 41.6; // mantém a proporção 200:260 do frame

const STATUS_OPTIONS: { id: ProfileStatus; label: string; dot: string }[] = [
  { id: "online", label: "Online", dot: STATUS_DOT_COLORS.online },
  { id: "away", label: "Ausente", dot: STATUS_DOT_COLORS.away },
  { id: "focus", label: "Foco", dot: STATUS_DOT_COLORS.focus },
];

function statusMeta(status: ProfileStatus) {
  return STATUS_OPTIONS.find((s) => s.id === status) ?? STATUS_OPTIONS[0];
}

function instagramHref(handle: string) {
  return `https://instagram.com/${handle.replace(/^@/, "").trim()}`;
}

// Card de perfil -- visual "cartão fosco" (foto grande no topo, nome,
// status/cargo, ação embaixo) parecido com o card de compartilhar
// perfil do iOS que o usuário mandou de referência. Dois modos bem
// diferentes:
//   isLocal=true  -> TUDO editável (foto/nome/status/insta/bio) +
//                     botão "Editar meu personagem" (abre o seletor de
//                     cabelo já existente).
//   isLocal=false -> só leitura (dados vêm sincronizados pelo servidor,
//                     ver "profile" em server/index.js) + botões de
//                     interação fixados embaixo (Disponível? / Chamar
//                     até você / Enviar mensagem).
function ProfileCard({
  info,
  myProfile,
  onChangeMyProfile,
  onChangePhoto,
  remoteProfile,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onClose,
  selectedHairId,
  onSelectHair,
  selectedHairColorId,
  onSelectHairColor,
  selectedGender,
  onSelectGender,
  selectedSkinId,
  onSelectSkin,
  selectedBeardId,
  onSelectBeard,
  selectedAccessoryId,
  onSelectAccessory,
  selectedAccessoryColorId,
  onSelectAccessoryColor,
  selectedOutfitId,
  onSelectOutfit,
  editorCategory,
  onSelectCategory,
  measuredHeight,
  onMeasuredHeight,
  onAskAvailable,
  onCallOver,
  onSendMessage,
}: {
  info: { playerId: string; isLocal: boolean };
  myProfile: ProfileFields;
  onChangeMyProfile: (partial: Partial<ProfileFields>) => void;
  onChangePhoto: (file: File) => void;
  remoteProfile: RemoteProfile | undefined;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onClose: () => void;
  selectedHairId: string;
  onSelectHair: (id: string) => void;
  selectedHairColorId: string | null;
  onSelectHairColor: (id: string) => void;
  selectedGender: AvatarGender;
  onSelectGender: (gender: AvatarGender) => void;
  selectedSkinId: string;
  onSelectSkin: (id: string) => void;
  selectedBeardId: string;
  onSelectBeard: (id: string) => void;
  selectedAccessoryId: string;
  onSelectAccessory: (id: string) => void;
  selectedAccessoryColorId: string | null;
  onSelectAccessoryColor: (id: string) => void;
  selectedOutfitId: string;
  onSelectOutfit: (id: string) => void;
  editorCategory: CustomizationCategoryId;
  onSelectCategory: (id: CustomizationCategoryId) => void;
  measuredHeight: number | null;
  onMeasuredHeight: (h: number) => void;
  onAskAvailable: () => void;
  onCallOver: () => void;
  onSendMessage: () => void;
}) {
  const thumbScale = HAIR_THUMB_W / 200;
  const photoInputRef = useRef<HTMLInputElement>(null);
  const baseCardRef = useRef<HTMLDivElement>(null);

  const fields: RemoteProfile = info.isLocal
    ? { ...myProfile, role: "" }
    : remoteProfile ?? pickRemoteProfile(undefined);
  const status = statusMeta(fields.status);
  const displayName = fields.name || (info.isLocal ? "Sem nome ainda" : "Visitante");

  // mede a altura de VERDADE do card base (foto + campos) sempre que
  // ele está na tela, e guarda lá em cima (GameRoom) -- é esse valor
  // que a tela de edição usa (ver style logo abaixo), pra nunca ficar
  // com um tamanho diferente do card de perfil. ResizeObserver em vez
  // de medir só uma vez porque a largura do card pode encolher em
  // telas pequenas (max-width:85%), o que muda a altura da foto
  // (aspect-ratio 1/1) junto.
  useLayoutEffect(() => {
    if (editing) return;
    const el = baseCardRef.current;
    if (!el) return;
    const measure = () => onMeasuredHeight(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editing, onMeasuredHeight]);

  // "Editar meu personagem" toma o card INTEIRO (categorias + itens +
  // Cancelar/Salvar) em vez de aparecer espremido junto com os campos
  // de nome/status/bio -- ver onStartEdit/onCancelEdit. Título e abas
  // de categoria ficam FIXOS no topo, Cancelar/Salvar fixos embaixo;
  // só a lista de itens (e as cores do item selecionado) rola por
  // dentro -- assim o card nunca muda de tamanho trocando de categoria
  // ou categoria com mais/menos itens. A ALTURA em si (não só o
  // max) é a mesma medida do card de perfil (measuredHeight, ver
  // useLayoutEffect acima) -- por isso as duas telas têm
  // EXATAMENTE o mesmo tamanho, "seguindo" o perfil.
  if (editing) {
    const selectedHairOption = HAIR_CATALOG.find((opt) => opt.id === selectedHairId);
    // cor escolhida dentro do penteado atual (se houver) -- troca só o
    // ARQUIVO exibido/aplicado, o penteado "selecionado" continua sendo
    // o mesmo pro resto da UI (grade de penteados, categoria etc).
    const selectedColorOption = selectedHairColorId
      ? selectedHairOption?.colors?.find((c) => c.id === selectedHairColorId)
      : undefined;
    const effectiveHairFile = selectedColorOption?.file ?? selectedHairOption?.file;
    const selectedSkinOption = SKIN_CATALOG.find((opt) => opt.id === selectedSkinId) ?? SKIN_CATALOG[0];
    // barba: sem cor manual -- o arquivo efetivo já é resolvido pelo tom
    // de pele ATUAL, mesmo esquema do traje mais abaixo (ver
    // beardFileForSkin/resolveBeardSkinId).
    const selectedBeardOption = BEARD_CATALOG.find((opt) => opt.id === selectedBeardId);
    const effectiveBeardFile = selectedBeardOption ? beardFileForSkin(selectedBeardOption, selectedSkinId) : undefined;
    // acessório: cálculo de "arquivo efetivo" do cabelo (cor escolhida
    // dentro do item, se houver).
    const selectedAccessoryOption = ACCESSORY_CATALOG.find((opt) => opt.id === selectedAccessoryId);
    const selectedAccessoryColorOption = selectedAccessoryColorId
      ? selectedAccessoryOption?.colors?.find((c) => c.id === selectedAccessoryColorId)
      : undefined;
    const effectiveAccessoryFile = selectedAccessoryColorOption?.file ?? selectedAccessoryOption?.file;
    // traje: sem cor manual -- o arquivo efetivo já é resolvido pelo tom
    // de pele ATUAL (ver outfitFileForSkin/resolveOutfitSkinId), então a
    // prévia troca sozinha ao trocar o tom, sem precisar reselecionar o
    // traje.
    const selectedOutfitOption = OUTFIT_CATALOG.find((opt) => opt.id === selectedOutfitId);
    const effectiveOutfitFile = selectedOutfitOption
      ? outfitFileForSkin(selectedOutfitOption, selectedSkinId)
      : undefined;
    const colorSwatchScale = COLOR_SWATCH_W / 200;
    return (
      <div className="profile-backdrop" onClick={onClose}>
        <div
          className="profile-card editing"
          style={{ height: measuredHeight ?? 560 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="profile-edit-title">Editar meu personagem</h3>

          {/* boneco fixo no topo -- mostra AO VIVO cada escolha (base +
              traje + cabelo/barba/acessório selecionados empilhados,
              mesmo recorte de frame 0 dos thumbnails), ver
              LAYER_DRAW_ORDER em MainScene.ts. */}
          <div className="avatar-preview-wrap">
            <div className="avatar-preview" style={{ width: AVATAR_PREVIEW_W, height: AVATAR_PREVIEW_H }}>
              <span
                className="avatar-preview-layer"
                style={{
                  backgroundImage: `url(${furnitureAssetUrl(selectedSkinOption.file)})`,
                  backgroundPosition: "0 0",
                  backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                }}
              />
              {/* ordem das camadas segue LAYER_DRAW_ORDER (MainScene.ts):
                  traje fica sobre a base, barba fica ATRÁS do cabelo,
                  óculos fica NA FRENTE de tudo -- "nenhuma(o)"/"Nenhum"
                  é um arquivo transparente, então sempre renderiza (sem
                  condicional), só não aparece nada. */}
              {effectiveOutfitFile && (
                <span
                  className="avatar-preview-layer"
                  style={{
                    backgroundImage: `url(/assets/${effectiveOutfitFile})`,
                    backgroundPosition: "0 0",
                    backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                  }}
                />
              )}
              {effectiveBeardFile && (
                <span
                  className="avatar-preview-layer"
                  style={{
                    backgroundImage: `url(/assets/${effectiveBeardFile})`,
                    backgroundPosition: "0 0",
                    backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                  }}
                />
              )}
              {effectiveHairFile && (
                <span
                  className="avatar-preview-layer"
                  style={{
                    backgroundImage: `url(/assets/${effectiveHairFile})`,
                    backgroundPosition: "0 0",
                    backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                  }}
                />
              )}
              {effectiveAccessoryFile && (
                <span
                  className="avatar-preview-layer"
                  style={{
                    backgroundImage: `url(/assets/${effectiveAccessoryFile})`,
                    backgroundPosition: "0 0",
                    backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                  }}
                />
              )}
            </div>

            {/* tons de pele (ver SKIN_CATALOG) -- selecionáveis aqui do
                lado do boneco, não dentro da grade de categorias (pedido
                do Douglas). Troca ao vivo (ver selectSkin), sem precisar
                estar na aba "cabelo". Sexo (ver AvatarGender) fica ACIMA
                do tom de pele (pedido do Douglas) e só filtra a grade de
                baixo -- tom sem `gender` no catálogo (gerado antes dessa
                mudança) conta como "masculino". */}
            <div className="skin-picker">
              <span className="skin-picker-label">Sexo</span>
              <div className="gender-switch">
                <button
                  type="button"
                  className={selectedGender === "masculino" ? "gender-btn selected" : "gender-btn"}
                  onClick={() => onSelectGender("masculino")}
                >
                  Masculino
                </button>
                <button
                  type="button"
                  className={selectedGender === "feminino" ? "gender-btn selected" : "gender-btn"}
                  onClick={() => onSelectGender("feminino")}
                >
                  Feminino
                </button>
              </div>
              <span className="skin-picker-label">Tom de pele</span>
              <div className="skin-swatches">
                {SKIN_CATALOG.filter((skin) => (skin.gender ?? "masculino") === selectedGender).map((skin) => (
                  <button
                    key={skin.id}
                    className={selectedSkinId === skin.id ? "skin-swatch selected" : "skin-swatch"}
                    style={{ background: skin.hex ?? "#8a7ca8" }}
                    onClick={() => onSelectSkin(skin.id)}
                    title={skin.label}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="edit-category-tabs">
            {CUSTOMIZATION_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                className={editorCategory === cat.id ? "edit-category-tab selected" : "edit-category-tab"}
                onClick={() => onSelectCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="profile-edit-scroll">
            {editorCategory === "cabelo" ? (
              <>
                <div className="hair-picker">
                  {HAIR_CATALOG.map((opt) => (
                    <button
                      key={opt.id}
                      className={selectedHairId === opt.id ? "hair-option selected" : "hair-option"}
                      onClick={() => onSelectHair(opt.id)}
                      title={opt.label}
                    >
                      <span
                        className="hair-thumb"
                        style={{
                          width: HAIR_THUMB_W,
                          height: HAIR_THUMB_H,
                          backgroundImage: `url(/assets/${opt.file})`,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  ))}
                </div>

                {/* cores do penteado selecionado (ver ColorOption em
                    game/customization.ts) -- NÃO é um penteado novo,
                    é uma variação de arte do mesmo item (ex: "Castanho"/
                    "Loiro" de "Cabelinho pra trás"); cada miniatura é um
                    recorte do próprio spritesheet da cor (igual ao
                    hair-thumb da grade acima, só que menor), gerado
                    automaticamente a partir da pasta de origem -- ver
                    scripts/syncAvatarAssets.mjs. Sem cores geradas
                    ainda pra esse item, mostra "Em breve". */}
                {selectedHairOption && (
                  <div className="color-picker">
                    <span className="color-picker-label">Cores de &quot;{selectedHairOption.label}&quot;</span>
                    {selectedHairOption.colors && selectedHairOption.colors.length > 0 ? (
                      <div className="color-swatches">
                        {selectedHairOption.colors.map((c) => (
                          <button
                            key={c.id}
                            className={selectedHairColorId === c.id ? "color-swatch selected" : "color-swatch"}
                            style={{
                              width: COLOR_SWATCH_W,
                              height: COLOR_SWATCH_H,
                              backgroundImage: `url(/assets/${c.file})`,
                              backgroundPosition: "0 0",
                              backgroundSize: `${HAIR_SHEET_W * colorSwatchScale}px ${HAIR_SHEET_H * colorSwatchScale}px`,
                            }}
                            onClick={() => onSelectHairColor(c.id)}
                            title={c.label}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="color-picker-empty">Em breve</span>
                    )}
                  </div>
                )}
              </>
            ) : editorCategory === "barba" ? (
              // barba: sem seletor de cor (a arte já combina sozinha com
              // o tom de pele escolhido lá em cima, mesmo esquema do
              // traje -- ver beardFileForSkin) -- a miniatura de cada
              // barba já mostra a arte casada com o tom atual.
              <div className="hair-picker">
                {BEARD_CATALOG.map((opt) => {
                  const thumbFile = beardFileForSkin(opt, selectedSkinId);
                  return (
                    <button
                      key={opt.id}
                      className={selectedBeardId === opt.id ? "hair-option selected" : "hair-option"}
                      onClick={() => onSelectBeard(opt.id)}
                      title={opt.label}
                    >
                      <span
                        className="hair-thumb"
                        style={{
                          width: HAIR_THUMB_W,
                          height: HAIR_THUMB_H,
                          backgroundImage: thumbFile ? `url(/assets/${thumbFile})` : undefined,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : editorCategory === "acessorio" ? (
              <>
                <div className="hair-picker">
                  {ACCESSORY_CATALOG.map((opt) => (
                    <button
                      key={opt.id}
                      className={selectedAccessoryId === opt.id ? "hair-option selected" : "hair-option"}
                      onClick={() => onSelectAccessory(opt.id)}
                      title={opt.label}
                    >
                      <span
                        className="hair-thumb"
                        style={{
                          width: HAIR_THUMB_W,
                          height: HAIR_THUMB_H,
                          backgroundImage: `url(/assets/${opt.file})`,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  ))}
                </div>

                {selectedAccessoryOption && selectedAccessoryOption.id !== "nenhum" && (
                  <div className="color-picker">
                    <span className="color-picker-label">Cores de &quot;{selectedAccessoryOption.label}&quot;</span>
                    {selectedAccessoryOption.colors && selectedAccessoryOption.colors.length > 0 ? (
                      <div className="color-swatches">
                        {selectedAccessoryOption.colors.map((c) => (
                          <button
                            key={c.id}
                            className={selectedAccessoryColorId === c.id ? "color-swatch selected" : "color-swatch"}
                            style={{
                              width: COLOR_SWATCH_W,
                              height: COLOR_SWATCH_H,
                              backgroundImage: `url(/assets/${c.file})`,
                              backgroundPosition: "0 0",
                              backgroundSize: `${HAIR_SHEET_W * colorSwatchScale}px ${HAIR_SHEET_H * colorSwatchScale}px`,
                            }}
                            onClick={() => onSelectAccessoryColor(c.id)}
                            title={c.label}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="color-picker-empty">Em breve</span>
                    )}
                  </div>
                )}
              </>
            ) : editorCategory === "traje" ? (
              // traje: sem seletor de cor (a mão já combina sozinha com o
              // tom de pele escolhido lá em cima, ver outfitFileForSkin) --
              // a miniatura de cada traje também já mostra a arte casada
              // com o tom atual.
              <div className="hair-picker">
                {OUTFIT_CATALOG.map((opt) => {
                  const thumbFile = outfitFileForSkin(opt, selectedSkinId);
                  return (
                    <button
                      key={opt.id}
                      className={selectedOutfitId === opt.id ? "hair-option selected" : "hair-option"}
                      onClick={() => onSelectOutfit(opt.id)}
                      title={opt.label}
                    >
                      <span
                        className="hair-thumb"
                        style={{
                          width: HAIR_THUMB_W,
                          height: HAIR_THUMB_H,
                          backgroundImage: thumbFile ? `url(/assets/${thumbFile})` : undefined,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="edit-category-empty">Em breve</div>
            )}
          </div>

          <div className="profile-edit-actions">
            <button className="profile-action-btn" onClick={onCancelEdit}>
              Cancelar
            </button>
            <button className="profile-action-btn primary" onClick={onSaveEdit}>
              Salvar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-backdrop" onClick={onClose}>
      <div className="profile-card" ref={baseCardRef} onClick={(e) => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose} title="Fechar">
          ✕
        </button>

        <div className="profile-photo-wrap">
          <div className="profile-photo" style={{ backgroundImage: fields.photoUrl ? `url(${fields.photoUrl})` : undefined }}>
            {!fields.photoUrl && <span className="profile-photo-fallback">{displayName.slice(0, 1).toUpperCase()}</span>}
            <div className="profile-photo-fade" />
            <div className="profile-photo-text">
              <span className="profile-name-row">
                <span className="profile-status-dot" style={{ background: status.dot }} title={status.label} />
                {info.isLocal ? (
                  <input
                    className="profile-name-input"
                    value={myProfile.name}
                    placeholder="Seu nome"
                    maxLength={40}
                    onChange={(e) => onChangeMyProfile({ name: e.target.value })}
                  />
                ) : (
                  <span className="profile-name">{displayName}</span>
                )}
              </span>
              <span className="profile-role">{fields.role || (info.isLocal ? "Cargo (definido pelo admin)" : " ")}</span>
            </div>
          </div>

          {info.isLocal && (
            <>
              <button
                className="profile-photo-edit"
                title="Trocar foto"
                onClick={() => photoInputRef.current?.click()}
              >
                <BrushIcon />
              </button>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onChangePhoto(file);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>

        <div className="profile-body">
        {info.isLocal ? (
          <div className="profile-fields">
            <label className="profile-field">
              <span>Status</span>
              <select
                value={myProfile.status}
                onChange={(e) => onChangeMyProfile({ status: e.target.value as ProfileStatus })}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="profile-field">
              <span>Instagram</span>
              <input
                value={myProfile.instagram}
                placeholder="@seuusuario"
                maxLength={30}
                onChange={(e) => onChangeMyProfile({ instagram: e.target.value })}
              />
            </label>

            <label className="profile-field">
              <span>Bio</span>
              <textarea
                value={myProfile.bio}
                placeholder="Fale um pouco sobre você"
                maxLength={280}
                rows={3}
                onChange={(e) => onChangeMyProfile({ bio: e.target.value })}
              />
            </label>
          </div>
        ) : (
          <div className="profile-view">
            <span className="profile-status-line">
              <span className="profile-status-dot" style={{ background: status.dot }} />
              {status.label}
            </span>
            {fields.instagram && (
              <a
                className="profile-instagram-link"
                href={instagramHref(fields.instagram)}
                target="_blank"
                rel="noreferrer"
              >
                @{fields.instagram.replace(/^@/, "")}
              </a>
            )}
            {fields.bio && <p className="profile-bio">{fields.bio}</p>}
          </div>
        )}

        {info.isLocal && (
          <button className="edit-character-btn" onClick={onStartEdit}>
            <PencilIcon />
            Editar meu personagem
          </button>
        )}

        {!info.isLocal && (
          <div className="profile-actions">
            <button className="profile-action-btn primary" onClick={onSendMessage}>
              <ShareIcon />
              Enviar mensagem
            </button>
            <div className="profile-actions-row">
              <button className="profile-action-btn" onClick={onAskAvailable}>
                Disponível?
              </button>
              <button className="profile-action-btn" onClick={onCallOver}>
                Chamar até você
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3v12M12 3 8 7M12 3l4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="m16.5 4.5 3 3L8 19l-4 1 1-4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BrushIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
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

// --- ícones da barra de áudio/câmera/tela (linha fina, estilo
// SF Symbols/Feather -- ver .av-bar em globals.css pro visual "vidro
// fosco" ao redor deles) ---

/** Ícone de mira/GPS do botão "centralizar" do MapControls (ver
 * handleRecenterCamera) -- mesmo estilo linha-fina dos ícones da av-bar. */
// Ícones dos botões "Membros"/"Editar espaço"/"Itens" (ver .controls
// mais abaixo) -- pedido do Douglas pra ficarem no MESMO modelo dos
// botões do lado esquerdo (.av-bar: ícone só, sem texto, dentro de um
// círculo "vidro fosco", ver .av-btn no CSS) em vez do formato antigo
// (emoji + texto numa pílula achatada).
function UsersIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M15.5 6.2a3 3 0 0 1 0 5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16.3 14.3c2.3.6 3.7 2.1 3.7 4.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// pedido do Douglas: "editar espaco tem que ter icone de mobi+pincel"
// -- a ferramenta "Editar espaço" mexe em DUAS coisas (arrastar móvel +
// pintar piso/área), esse ícone junta uma poltrona pequena (canto
// superior-esquerdo) com um pincel cruzando por cima (canto
// inferior-direito) pra ficar claro que não é só "configurações"
// (ícone de engrenagem, ver GearIcon) nem "cadastrar item novo" (ver
// BoxIcon/"Itens" abaixo) -- os três apareciam parecidos demais só de
// ícone genérico.
function FurnitureBrushIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 9V6.2A1.7 1.7 0 0 1 6.7 4.5h3.6A1.7 1.7 0 0 1 12 6.2V9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="3.5" y="9" width="10" height="4.2" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.3 13.2v2.3M12.7 13.2v2.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M20.5 6.8 13.8 13.5a1.6 1.6 0 0 0 2.3 2.3l6.7-6.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.8 13.5c-1 .6-1.8 1.6-1.9 3 1.4-.1 2.4-.9 3-1.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoxIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M3.5 8.2 12 4l8.5 4.2L12 12.4 3.5 8.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M3.5 8.2v7.6L12 20m0-7.6V20m8.5-11.8v7.6L12 20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// PlusIcon já existe mais abaixo no arquivo (usado nos botões de
// anexo/participante) -- mesmo SVG, reaproveitado aqui pro "+" do zoom
// em vez de duplicar.

function MinusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {off && (
        <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
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
      {off && (
        <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

function ScreenIcon({ active }: { active: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4.5" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 20h7M12 16.5V20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {active && (
        <path
          d="M12 13.2V8m0 0-2.2 2.2M12 8l2.2 2.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

// setSinkId (escolher a SAÍDA de áudio, ver "Configurações" >
// "Áudio e vídeo") ainda não tá no lib.dom.d.ts padrão do TypeScript
// (só Chromium implementa de verdade -- Safari/Firefox não têm) -- essa
// interface só descreve o pedacinho que a gente usa, pra não precisar
// de "as any" no meio do componente.
type VideoElementWithSink = HTMLVideoElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

function RemoteVideoTile({
  stream,
  meta,
  volume,
  sinkId,
}: {
  stream: MediaStream;
  meta?: { name: string; distance: number };
  // volume FINAL já calculado (som do espaço × volume da pessoa, ver
  // GameRoom -- esse componente só aplica, não faz a conta).
  volume: number;
  // deviceId do alto-falante/fone escolhido em "Configurações" -- "" ou
  // undefined = padrão do sistema (não mexe em nada).
  sinkId?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (ref.current) ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  useEffect(() => {
    const el = ref.current as VideoElementWithSink | null;
    if (el && sinkId && typeof el.setSinkId === "function") {
      el.setSinkId(sinkId).catch(() => {
        // navegador recusou (dispositivo sumiu, sem permissão etc) --
        // sem tratamento especial, só segue tocando na saída padrão.
      });
    }
  }, [sinkId]);

  const distance = meta?.distance ?? 0;
  const opacity = Math.max(0.35, 1 - distance / PROXIMITY_DISCONNECT);

  return (
    <div className="video-tile" style={{ opacity }}>
      <video ref={ref} autoPlay playsInline />
      <span className="video-name">{meta?.name ?? "Jogador"}</span>
    </div>
  );
}

// video da chamada de CHAT (ver ChatDrawer/joinCall) -- mais simples que
// RemoteVideoTile de cima (sem opacidade por distância, não faz
// sentido numa chamada que não depende de posição no mapa). "muted" só
// pro MEU PRÓPRIO preview (senão eu ouviria meu próprio áudio de volta),
// o vídeo de quem eu tô chamando nunca é mudo.
function ChatCallVideoTile({ stream, muted }: { stream: MediaStream; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <video ref={ref} autoPlay muted={muted} playsInline className="chat-call-video" />;
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M6.5 3.5c.6 0 1.1.4 1.3 1l1 2.8c.2.5 0 1.1-.4 1.4L7 10c1 2.3 2.7 4 5 5l1.3-1.4c.4-.4 1-.5 1.4-.3l2.8 1c.6.2 1 .7 1 1.3v2.6c0 1-.9 1.8-1.9 1.6C10.4 18.8 5.2 13.6 4.2 6.4 4 5.4 4.8 4.5 5.8 4.5h.7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Gaveta de chat "de verdade" -- Sala (nearby, sem histórico, ver
// comentário nos tipos lá em cima) + conversas diretas/grupo com
// histórico persistido no servidor + foto/arquivo/áudio. Tamanho FIXO
// (ver .chat-drawer em globals.css) independente da tela (lista/nova
// conversa/conversa aberta) -- mesma lógica já usada no card de
// perfil, pra não ficar pulando de tamanho.
function ChatDrawer({
  view,
  onChangeView,
  conversations,
  activeConversationId,
  onOpenConversation,
  messages,
  roomChatLog,
  myUserId,
  onlinePlayers,
  newConvSelection,
  onToggleNewConvSelection,
  newConvName,
  onChangeNewConvName,
  onSubmitNewConversation,
  renamingGroup,
  onStartRenameGroup,
  onCancelRenameGroup,
  groupNameDraft,
  onChangeGroupNameDraft,
  onSubmitRenameGroup,
  composerText,
  onChangeComposerText,
  onSendComposer,
  onPickFile,
  sendingAttachment,
  recordingAudio,
  recordingElapsedSec,
  recordedPreview,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onDiscardRecordedAudio,
  onSendRecordedAudio,
  onDeleteMessage,
  callParticipantsByConversation,
  myCallConversationId,
  callRemoteStreams,
  onJoinCall,
  onLeaveCall,
  localStreamRef,
  camOn,
  onClose,
  pinMode,
  onToggleSidePin,
}: {
  view: "list" | "thread" | "new";
  onChangeView: (v: "list" | "thread" | "new") => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onOpenConversation: (id: string | null) => void;
  messages: ChatMsg[];
  roomChatLog: ChatMessage[];
  myUserId: string;
  onlinePlayers: RemotePlayer[];
  newConvSelection: string[];
  onToggleNewConvSelection: (userId: string) => void;
  newConvName: string;
  onChangeNewConvName: (v: string) => void;
  onSubmitNewConversation: () => void;
  renamingGroup: boolean;
  onStartRenameGroup: (currentName: string) => void;
  onCancelRenameGroup: () => void;
  groupNameDraft: string;
  onChangeGroupNameDraft: (v: string) => void;
  onSubmitRenameGroup: () => void;
  composerText: string;
  onChangeComposerText: (v: string) => void;
  onSendComposer: () => void;
  onPickFile: () => void;
  sendingAttachment: boolean;
  recordingAudio: boolean;
  recordingElapsedSec: number;
  recordedPreview: { url: string; durationSec: number } | null;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onDiscardRecordedAudio: () => void;
  onSendRecordedAudio: () => void;
  onDeleteMessage: (conversationId: string | null, messageId: string) => void;
  callParticipantsByConversation: Record<string, ChatCallParticipant[]>;
  myCallConversationId: string | null;
  callRemoteStreams: Record<string, MediaStream>;
  onJoinCall: (conversationId: string) => void;
  onLeaveCall: () => void;
  localStreamRef: RefObject<MediaStream | null>;
  camOn: boolean;
  onClose: () => void;
  pinMode: "float" | "side";
  onToggleSidePin: () => void;
}) {
  const activeConv = conversations.find((c) => c.id === activeConversationId) ?? null;
  const isRoom = activeConversationId === null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeCallParticipants =
    !isRoom && activeConversationId ? callParticipantsByConversation[activeConversationId] ?? [] : [];
  const inActiveCall = !isRoom && myCallConversationId === activeConversationId;
  const localCallStream = localStreamRef.current;
  // clicar de novo no lateral solta (volta a flutuar).
  const pinBtn = (
    <button
      className={pinMode === "side" ? "chat-icon-btn active" : "chat-icon-btn"}
      title={pinMode === "side" ? "Soltar (voltar a flutuar)" : "Fixar na lateral"}
      onClick={onToggleSidePin}
    >
      <PinIcon filled={pinMode === "side"} />
    </button>
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, roomChatLog.length, view]);

  // dedupe por userId -- se alguém tiver 2 abas abertas, ainda aparece
  // uma vez só na lista de "quem tá na sala" (ver onlinePlayers).
  const pickable = Array.from(new Map(onlinePlayers.map((p) => [p.userId, p])).values());

  return (
    <div
      className={pinMode === "side" ? "chat-drawer chat-drawer-sidebar" : "chat-drawer"}
    >
      {view === "list" && (
        <>
          <div className="chat-drawer-header">
            <h3>Chat</h3>
            <div className="chat-drawer-header-actions">
              {pinBtn}
              <button className="chat-icon-btn" title="Nova conversa" onClick={() => onChangeView("new")}>
                <PlusIcon />
              </button>
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="chat-conv-list">
            <button className="chat-conv-item" onClick={() => onOpenConversation(null)}>
              <span className="chat-conv-avatar chat-conv-avatar-room">
                <RoomIcon />
              </span>
              <span className="chat-conv-info">
                <span className="chat-conv-name">Sala</span>
                <span className="chat-conv-preview">
                  {roomChatLog.length > 0
                    ? roomChatLog[roomChatLog.length - 1].text
                    : "Conversa com todo mundo por perto"}
                </span>
              </span>
            </button>
            {conversations.map((c) => {
              // botão verde "tipo discord": acende quando tem gente NA
              // CHAMADA dessa conversa agora, mesmo que eu ainda não
              // tenha entrado -- clicar nele já abre a conversa E entra
              // direto na chamada (ver onJoinCall/joinCall).
              const activeCall = callParticipantsByConversation[c.id] ?? [];
              return (
                <button key={c.id} className="chat-conv-item" onClick={() => onOpenConversation(c.id)}>
                  <span
                    className="chat-conv-avatar"
                    style={{ background: c.kind === "direct" ? c.participants[0]?.color || "#5c9bff" : "#7c5cff" }}
                  >
                    {c.kind === "group" ? <GroupIcon /> : conversationDisplayName(c).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="chat-conv-info">
                    <span className="chat-conv-name">{conversationDisplayName(c)}</span>
                    <span className="chat-conv-preview">
                      {c.lastMessage
                        ? `${c.lastMessage.senderId === myUserId ? "Você: " : ""}${previewText(c.lastMessage)}`
                        : "Nenhuma mensagem ainda"}
                    </span>
                  </span>
                  {activeCall.length > 0 && (
                    <span
                      className="chat-call-badge"
                      title={`Chamada em andamento -- ${activeCall.length} ${activeCall.length === 1 ? "pessoa" : "pessoas"}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenConversation(c.id);
                        onJoinCall(c.id);
                      }}
                    >
                      <PhoneIcon />
                      {activeCall.length}
                    </span>
                  )}
                </button>
              );
            })}
            {conversations.length === 0 && (
              <p className="chat-empty-hint">Clique em + pra começar uma conversa direta ou em grupo.</p>
            )}
          </div>
        </>
      )}

      {view === "new" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar" onClick={() => onChangeView("list")}>
              <BackIcon />
            </button>
            <h3>Nova conversa</h3>
            <div className="chat-drawer-header-actions">
              {pinBtn}
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="chat-new-conv-body">
            {pickable.length === 0 ? (
              <p className="chat-empty-hint">Não tem mais ninguém na sala agora.</p>
            ) : (
              <div className="chat-picker-list">
                {pickable.map((p) => (
                  <label key={p.userId} className="chat-picker-item">
                    <input
                      type="checkbox"
                      checked={newConvSelection.includes(p.userId)}
                      onChange={() => onToggleNewConvSelection(p.userId)}
                    />
                    <span className="chat-conv-avatar" style={{ background: p.color }}>
                      {(p.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span>{p.name || "Sem nome"}</span>
                  </label>
                ))}
              </div>
            )}
            {newConvSelection.length > 1 && (
              <label className="chat-field">
                <span>Nome do grupo</span>
                <input
                  value={newConvName}
                  onChange={(e) => onChangeNewConvName(e.target.value)}
                  placeholder="Ex: Galera do room"
                  maxLength={60}
                />
              </label>
            )}
            <button
              className="chat-primary-btn"
              disabled={newConvSelection.length === 0}
              onClick={onSubmitNewConversation}
            >
              {newConvSelection.length > 1 ? "Criar grupo" : "Iniciar conversa"}
            </button>
          </div>
        </>
      )}

      {view === "thread" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar" onClick={() => onChangeView("list")}>
              <BackIcon />
            </button>
            {isRoom ? (
              <h3>Sala</h3>
            ) : renamingGroup ? (
              <input
                className="chat-rename-input"
                value={groupNameDraft}
                autoFocus
                maxLength={60}
                onChange={(e) => onChangeGroupNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitRenameGroup();
                  if (e.key === "Escape") onCancelRenameGroup();
                }}
              />
            ) : (
              <h3>{activeConv ? conversationDisplayName(activeConv) : ""}</h3>
            )}
            <div className="chat-drawer-header-actions">
              {pinBtn}
              {!isRoom && activeConversationId && (
                <button
                  className={inActiveCall ? "chat-icon-btn call-active" : "chat-icon-btn"}
                  title={inActiveCall ? "Sair da chamada" : "Iniciar/entrar na chamada"}
                  onClick={() => (inActiveCall ? onLeaveCall() : activeConversationId && onJoinCall(activeConversationId))}
                >
                  <PhoneIcon />
                </button>
              )}
              {!isRoom && activeConv?.kind === "group" && !renamingGroup && (
                <button
                  className="chat-icon-btn"
                  title="Renomear grupo"
                  onClick={() => onStartRenameGroup(activeConv.name || "")}
                >
                  <PencilIcon />
                </button>
              )}
              {!isRoom && renamingGroup && (
                <button className="chat-icon-btn" title="Salvar nome" onClick={onSubmitRenameGroup}>
                  <CheckIcon />
                </button>
              )}
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>

          {!isRoom && activeConv?.kind === "group" && (
            <div className="chat-group-members">{activeConv.participants.map((p) => p.name || "?").join(", ")}</div>
          )}

          {!isRoom && activeCallParticipants.length > 0 && (
            // "botão de chamada verde ... com a opção da pessoa entrar
            // ou não, sair e ver quem tá participando, no topo" -- quem
            // já tá dentro aparece aqui pra QUALQUER participante da
            // conversa, mesmo quem ainda não entrou (é o que dá pra ver
            // "quem tá participando" antes de decidir entrar).
            <div className="chat-call-bar">
              <div className="chat-call-bar-people">
                {activeCallParticipants.map((p) => (
                  <span key={p.connectionId} className="chat-call-bar-avatar" style={{ background: p.color }} title={p.name || "?"}>
                    {(p.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                ))}
                <span className="chat-call-bar-label">
                  {activeCallParticipants.length} {activeCallParticipants.length === 1 ? "pessoa" : "pessoas"} na chamada
                </span>
              </div>
              {inActiveCall ? (
                <button className="chat-call-bar-btn leave" onClick={onLeaveCall}>
                  Sair
                </button>
              ) : (
                <button
                  className="chat-call-bar-btn join"
                  onClick={() => activeConversationId && onJoinCall(activeConversationId)}
                >
                  Entrar
                </button>
              )}
            </div>
          )}

          {inActiveCall && (
            <div className="chat-call-videos">
              <div className="chat-call-video-tile">
                {camOn && localCallStream ? (
                  <ChatCallVideoTile stream={localCallStream} muted />
                ) : (
                  <span className="chat-call-video-placeholder">Você</span>
                )}
                <span className="video-name">Você</span>
              </div>
              {activeCallParticipants
                .filter((p) => p.userId !== myUserId)
                .map((p) => {
                  const stream = callRemoteStreams[p.connectionId];
                  return (
                    <div key={p.connectionId} className="chat-call-video-tile">
                      {stream ? (
                        <ChatCallVideoTile stream={stream} />
                      ) : (
                        <span className="chat-call-video-placeholder">{(p.name || "?").slice(0, 1).toUpperCase()}</span>
                      )}
                      <span className="video-name">{p.name || "?"}</span>
                    </div>
                  );
                })}
            </div>
          )}

          <div className="chat-messages" ref={scrollRef}>
            {isRoom
              ? roomChatLog.filter(Boolean).map((m) => (
                  <ChatMessageRow
                    key={m.id}
                    msg={m}
                    own={m.senderId === myUserId}
                    showSenderName={m.senderId !== myUserId}
                    onDelete={m.senderId === myUserId && !m.deleted ? () => onDeleteMessage(null, m.id) : undefined}
                  />
                ))
              : messages.filter(Boolean).map((m) => (
                  <ChatMessageRow
                    key={m.id}
                    msg={m}
                    own={m.senderId === myUserId}
                    showSenderName={m.senderId !== myUserId && activeConv?.kind === "group"}
                    onDelete={
                      m.senderId === myUserId && !m.deleted && activeConversationId
                        ? () => onDeleteMessage(activeConversationId, m.id)
                        : undefined
                    }
                  />
                ))}
            {isRoom && roomChatLog.length === 0 && (
              <p className="chat-empty-hint">Nenhuma mensagem ainda -- diga oi pra quem tiver por perto!</p>
            )}
            {!isRoom && messages.length === 0 && (
              <p className="chat-empty-hint">Nenhuma mensagem ainda -- diga oi!</p>
            )}
          </div>

          {recordingAudio ? (
            // gravando AGORA -- mostra o tempo correndo (igual WhatsApp),
            // lixeira cancela sem mandar nada, o botão de parar só PÁRA
            // (vira preview embaixo, ainda não envia).
            <div className="chat-composer chat-recording-bar">
              <button className="chat-composer-btn" title="Cancelar gravação" onClick={onCancelRecording}>
                <TrashIcon />
              </button>
              <span className="chat-recording-indicator">
                <span className="chat-recording-dot" />
                Gravando... {formatRecordingTime(recordingElapsedSec)}
              </span>
              <button className="chat-composer-btn primary" title="Parar gravação" onClick={onStopRecording}>
                <StopIcon />
              </button>
            </div>
          ) : recordedPreview ? (
            // já parou -- preview pra ouvir de novo antes de decidir:
            // lixeira descarta, play manda de verdade (ver
            // sendRecordedAudio/discardRecordedAudio).
            <div className="chat-composer chat-audio-preview-bar">
              <button className="chat-composer-btn" title="Descartar" onClick={onDiscardRecordedAudio}>
                <TrashIcon />
              </button>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio className="chat-audio-preview-player" controls src={recordedPreview.url} />
              <span className="chat-recording-time">{formatRecordingTime(recordedPreview.durationSec)}</span>
              <button className="chat-composer-btn primary" title="Enviar áudio" onClick={onSendRecordedAudio}>
                <SendIcon />
              </button>
            </div>
          ) : (
            <div className="chat-composer">
              <button className="chat-composer-btn" title="Anexar foto/arquivo" onClick={onPickFile} disabled={sendingAttachment}>
                <AttachIcon />
              </button>
              <button className="chat-composer-btn" title="Gravar áudio" onClick={onStartRecording}>
                <MicIcon off={false} />
              </button>
              <input
                className="chat-composer-input"
                value={composerText}
                onChange={(e) => onChangeComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSendComposer();
                }}
                placeholder="Digite uma mensagem..."
              />
              <button className="chat-composer-btn primary" title="Enviar" onClick={onSendComposer}>
                <SendIcon />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AgendaDrawer({
  myUserId,
  onlinePlayers,
  allUsers,
  calls,
  busyUserIds,
  agendaView,
  onChangeAgendaView,
  agendaDetailId,
  onOpenCallDetail,
  agendaForm,
  onChangeAgendaForm,
  onToggleAgendaParticipant,
  agendaError,
  onStartNewCall,
  onSubmitCreateCall,
  onRespondToCall,
  agendaSearchQuery,
  onChangeAgendaSearchQuery,
  agendaColleagueId,
  agendaColleagueName,
  colleagueCalls,
  onViewColleagueAgenda,
  onBackToMyAgenda,
  onPickAgendaFile,
  onRemoveAgendaAttachment,
  sendingAgendaAttachment,
  onPickDetailAttachment,
  sendingDetailAttachment,
  expandedAgendaDays,
  onToggleAgendaDay,
  onClose,
}: {
  myUserId: string;
  onlinePlayers: RemotePlayer[];
  allUsers: DirectoryUser[];
  calls: CallEvent[];
  busyUserIds: string[];
  agendaView: "list" | "new" | "detail" | "colleague";
  onChangeAgendaView: (v: "list" | "new" | "detail" | "colleague") => void;
  agendaDetailId: string | null;
  onOpenCallDetail: (callId: string) => void;
  agendaForm: AgendaFormState;
  onChangeAgendaForm: (partial: Partial<AgendaFormState>) => void;
  onToggleAgendaParticipant: (userId: string) => void;
  agendaError: string | null;
  onStartNewCall: () => void;
  onSubmitCreateCall: () => void;
  onRespondToCall: (callId: string, status: "approved" | "declined") => void;
  agendaSearchQuery: string;
  onChangeAgendaSearchQuery: (v: string) => void;
  agendaColleagueId: string | null;
  agendaColleagueName: string;
  colleagueCalls: CallEvent[];
  onViewColleagueAgenda: (userId: string, name: string) => void;
  onBackToMyAgenda: () => void;
  onPickAgendaFile: () => void;
  onRemoveAgendaAttachment: (index: number) => void;
  sendingAgendaAttachment: boolean;
  onPickDetailAttachment: () => void;
  sendingDetailAttachment: boolean;
  expandedAgendaDays: Set<string>;
  onToggleAgendaDay: (dateKey: string) => void;
  onClose: () => void;
}) {
  const detailCall = calls.find((c) => c.id === agendaDetailId) ?? colleagueCalls.find((c) => c.id === agendaDetailId) ?? null;
  const myCallStatus = detailCall?.participants.find((p) => p.id === myUserId)?.status ?? null;
  const onlineUserIds = new Set(onlinePlayers.map((p) => p.userId));
  // todo mundo cadastrado no ambiente, menos eu (ver allUsers/users:list
  // em server/chatStore.js) -- usado tanto no picker de participantes do
  // "Marcar compromisso" quanto em "pesquise a agenda de um colega",
  // independente de quem tá online agora (ver comentário no tipo
  // DirectoryUser).
  const roster = allUsers.filter((u) => u.userId !== myUserId);
  const colleagueQuery = agendaSearchQuery.trim().toLowerCase();
  const colleagueMatches =
    colleagueQuery.length === 0 ? [] : roster.filter((u) => (u.name || "").toLowerCase().includes(colleagueQuery));

  // "hoje | amanhã | 25/set | 26/set" -- ver comentário grande no
  // useState de expandedAgendaDays em GameRoom(). Agrupa as calls
  // futuras (de hoje em diante) por dia local; o strip sempre mostra os
  // próximos 7 dias corridos, mais qualquer dia além disso que já tenha
  // algum compromisso (pra não esconder nada).
  const now = new Date();
  const todayKey = localDateStr(now);
  const tomorrowKey = localDateStr(new Date(now.getTime() + 86_400_000));
  const callsByDay = new Map<string, CallEvent[]>();
  for (const c of calls) {
    const key = localDateStr(new Date(c.startTs));
    if (key < todayKey) continue; // passado não entra no strip -- só o que vem daqui pra frente
    if (!callsByDay.has(key)) callsByDay.set(key, []);
    callsByDay.get(key)!.push(c);
  }
  const stripDays: string[] = [];
  for (let i = 0; i < 7; i++) stripDays.push(localDateStr(new Date(now.getTime() + i * 86_400_000)));
  for (const key of callsByDay.keys()) if (!stripDays.includes(key)) stripDays.push(key);
  stripDays.sort();
  function renderCallItem(c: CallEvent) {
    const mine = c.participants.find((p) => p.id === myUserId);
    const approvedCount = c.participants.filter((p) => p.status === "approved").length;
    const soloCall = c.participants.length <= 1;
    return (
      <button key={c.id} className="agenda-call-item" onClick={() => onOpenCallDetail(c.id)}>
        <span className="agenda-call-item-main">
          <span className="agenda-call-title">
            {c.visibility === "private" && "🔒 "}
            {c.title}
          </span>
          <span className="agenda-call-when">
            {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
            {c.blocksAgenda === false && " · não trava agenda"}
          </span>
        </span>
        {soloCall && <span className="agenda-badge">Pessoal</span>}
        {!soloCall && mine?.status === "pending" && <span className="agenda-badge pending">Aguardando você</span>}
        {!soloCall && mine?.status === "declined" && <span className="agenda-badge declined">Recusada</span>}
        {!soloCall && mine?.status === "approved" && (
          <span className="agenda-badge approved">
            {approvedCount}/{c.participants.length} confirmados
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="chat-drawer agenda-drawer">
      {agendaView === "list" && (
        <>
          <div className="chat-drawer-header">
            <h3>Minha agenda</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Marcar compromisso" onClick={onStartNewCall}>
                <PlusIcon />
              </button>
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-search-row">
            <input
              className="agenda-search-input"
              value={agendaSearchQuery}
              onChange={(e) => onChangeAgendaSearchQuery(e.target.value)}
              placeholder="Pesquise a agenda de um colega..."
            />
            {colleagueQuery.length > 0 && (
              <div className="agenda-search-results">
                {colleagueMatches.length === 0 && <p className="chat-empty-hint">Ninguém encontrado.</p>}
                {colleagueMatches.map((p) => (
                  <button
                    key={p.userId}
                    className="agenda-search-result-item"
                    onClick={() => onViewColleagueAgenda(p.userId, p.name || "Sem nome")}
                  >
                    <span className="chat-conv-avatar" style={{ background: p.color }}>
                      {(p.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span>{p.name || "Sem nome"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="agenda-day-strip">
            {stripDays.map((key) => {
              const dayCalls = callsByDay.get(key) ?? [];
              const expanded = expandedAgendaDays.has(key);
              return (
                <button
                  key={key}
                  className={expanded ? "agenda-day-chip active" : "agenda-day-chip"}
                  onClick={() => onToggleAgendaDay(key)}
                >
                  {dayChipLabel(key, todayKey, tomorrowKey)}
                  {dayCalls.length > 0 && <span className="agenda-day-chip-count">{dayCalls.length}</span>}
                </button>
              );
            })}
          </div>
          <div className="agenda-call-list">
            {calls.length === 0 && <p className="chat-empty-hint">Nenhum compromisso marcado ainda.</p>}
            {stripDays
              .filter((key) => expandedAgendaDays.has(key))
              .map((key) => {
                const dayCalls = (callsByDay.get(key) ?? []).slice().sort((a, b) => a.startTs - b.startTs);
                return (
                  <div key={key} className="agenda-day-group">
                    <p className="agenda-day-group-label">{dayChipLabel(key, todayKey, tomorrowKey)}</p>
                    {dayCalls.length === 0 ? (
                      <p className="chat-empty-hint agenda-day-group-empty">Nada marcado.</p>
                    ) : (
                      dayCalls.map(renderCallItem)
                    )}
                  </div>
                );
              })}
          </div>
        </>
      )}

      {agendaView === "colleague" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar pra minha agenda" onClick={onBackToMyAgenda}>
              <BackIcon />
            </button>
            <h3>Agenda de {agendaColleagueName}</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-call-list">
            {colleagueCalls.length === 0 && (
              <p className="chat-empty-hint">Nenhum compromisso marcado por enquanto.</p>
            )}
            {colleagueCalls.map((c) =>
              c.redacted ? (
                <div key={c.id} className="agenda-call-item agenda-call-item-private">
                  <span className="agenda-call-item-main">
                    <span className="agenda-call-title agenda-call-title-private">🔒 Conteúdo da agenda privado</span>
                    <span className="agenda-call-when">
                      {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
                    </span>
                  </span>
                </div>
              ) : (
                <button key={c.id} className="agenda-call-item" onClick={() => onOpenCallDetail(c.id)}>
                  <span className="agenda-call-item-main">
                    <span className="agenda-call-title">{c.title}</span>
                    <span className="agenda-call-when">
                      {formatCallDateTime(c.startTs)} · {c.durationMinutes}min
                    </span>
                  </span>
                </button>
              )
            )}
          </div>
        </>
      )}

      {agendaView === "new" && (
        <>
          <div className="chat-drawer-header">
            <button className="chat-icon-btn" title="Voltar" onClick={() => onChangeAgendaView("list")}>
              <BackIcon />
            </button>
            <h3>Marcar compromisso</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-form-body">
            <label className="chat-field">
              <span>Título</span>
              <input
                value={agendaForm.title}
                onChange={(e) => onChangeAgendaForm({ title: e.target.value })}
                placeholder="Ex: Alinhamento do projeto"
                maxLength={80}
              />
            </label>
            <label className="chat-field">
              <span>Descrição (opcional)</span>
              <textarea
                className="agenda-description-input"
                value={agendaForm.description}
                onChange={(e) => onChangeAgendaForm({ description: e.target.value })}
                placeholder="Detalhes do compromisso..."
                maxLength={2000}
                rows={3}
              />
            </label>
            <div className="agenda-datetime-row">
              <label className="chat-field">
                <span>Data</span>
                <input type="date" value={agendaForm.date} onChange={(e) => onChangeAgendaForm({ date: e.target.value })} />
              </label>
              <label className="chat-field">
                <span>Horário</span>
                <input type="time" value={agendaForm.time} onChange={(e) => onChangeAgendaForm({ time: e.target.value })} />
              </label>
              <label className="chat-field">
                <span>Duração</span>
                <select
                  value={agendaForm.durationMinutes}
                  onChange={(e) => onChangeAgendaForm({ durationMinutes: Number(e.target.value) })}
                >
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={45}>45 min</option>
                  <option value={60}>1h</option>
                  <option value={90}>1h30</option>
                </select>
              </label>
            </div>

            <div className="agenda-needs-row">
              <span className="agenda-field-label">Necessidades</span>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.camera}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, camera: e.target.checked } })}
                />
                <CamIcon off={false} /> Câmera
              </label>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.audio}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, audio: e.target.checked } })}
                />
                <MicIcon off={false} /> Áudio
              </label>
              <label className="agenda-need-check">
                <input
                  type="checkbox"
                  checked={agendaForm.needs.screen}
                  onChange={(e) => onChangeAgendaForm({ needs: { ...agendaForm.needs, screen: e.target.checked } })}
                />
                <ScreenIcon active={false} /> Tela
              </label>
            </div>

            <div className="agenda-visibility-row">
              <span className="agenda-field-label">Visibilidade</span>
              <div className="agenda-visibility-toggle">
                <button
                  type="button"
                  className={agendaForm.visibility === "public" ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ visibility: "public" })}
                >
                  Público
                </button>
                <button
                  type="button"
                  className={agendaForm.visibility === "private" ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ visibility: "private" })}
                >
                  Privado
                </button>
              </div>
              <p className="agenda-visibility-hint">
                {agendaForm.visibility === "public"
                  ? "Quem pesquisar a agenda de um participante vê o conteúdo desse compromisso."
                  : 'Quem pesquisar a agenda de um participante só vê o horário ocupado, com "conteúdo da agenda privado".'}
              </p>
            </div>

            <div className="agenda-visibility-row">
              <span className="agenda-field-label">Ocupação na agenda</span>
              <div className="agenda-visibility-toggle">
                <button
                  type="button"
                  className={agendaForm.blocksAgenda ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ blocksAgenda: true })}
                >
                  Travar agenda
                </button>
                <button
                  type="button"
                  className={!agendaForm.blocksAgenda ? "agenda-visibility-btn active" : "agenda-visibility-btn"}
                  onClick={() => onChangeAgendaForm({ blocksAgenda: false })}
                >
                  Mostrar sem travar
                </button>
              </div>
              <p className="agenda-visibility-hint">
                {agendaForm.blocksAgenda
                  ? "Ocupa o horário -- quem for convidado pra outro compromisso no mesmo horário aparece como indisponível."
                  : "Só aparece na agenda, sem travar o horário -- dá pra marcar outro compromisso em cima desse."}
              </p>
            </div>

            <div className="agenda-attachment-field">
              <span className="agenda-field-label">Anexos (visíveis pra todos da call)</span>
              {agendaForm.attachments.length > 0 && (
                <div className="agenda-attachment-list">
                  {agendaForm.attachments.map((a, i) => (
                    <div key={`${a.url}-${i}`} className="chat-attachment-file agenda-attachment-pending">
                      <FileIcon />
                      <span className="chat-attachment-file-info">
                        <span className="chat-attachment-file-name">{a.name}</span>
                        <span className="chat-attachment-file-size">{formatFileSize(a.size)}</span>
                      </span>
                      <button
                        type="button"
                        className="chat-icon-btn"
                        title="Remover anexo"
                        onClick={() => onRemoveAgendaAttachment(i)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className="chat-secondary-btn" onClick={onPickAgendaFile} disabled={sendingAgendaAttachment}>
                {sendingAgendaAttachment ? "Enviando..." : "+ Anexar arquivo"}
              </button>
            </div>

            <span className="agenda-field-label">Participantes (opcional -- deixe vazio pra um compromisso só seu)</span>
            {roster.length === 0 ? (
              <p className="chat-empty-hint">Ainda não tem mais ninguém cadastrado no ambiente.</p>
            ) : (
              <div className="chat-picker-list">
                {roster.map((u) => {
                  const busy = busyUserIds.includes(u.userId);
                  const online = onlineUserIds.has(u.userId);
                  return (
                    <label key={u.userId} className={busy ? "chat-picker-item busy" : "chat-picker-item"}>
                      <input
                        type="checkbox"
                        checked={agendaForm.participantIds.includes(u.userId)}
                        disabled={busy}
                        onChange={() => onToggleAgendaParticipant(u.userId)}
                      />
                      <span className="chat-conv-avatar" style={{ background: u.color }}>
                        {(u.name || "?").slice(0, 1).toUpperCase()}
                      </span>
                      <span>{u.name || "Sem nome"}</span>
                      {online && <span className="agenda-online-dot" title="Online agora" />}
                      {busy && <span className="agenda-badge busy">Indisponível</span>}
                    </label>
                  );
                })}
              </div>
            )}

            {agendaError && <p className="agenda-error">{agendaError}</p>}

            <button className="chat-primary-btn" disabled={!agendaForm.date || !agendaForm.time} onClick={onSubmitCreateCall}>
              Marcar compromisso
            </button>
          </div>
        </>
      )}

      {agendaView === "detail" && detailCall && (
        <>
          <div className="chat-drawer-header">
            <button
              className="chat-icon-btn"
              title="Voltar"
              onClick={() => onChangeAgendaView(agendaColleagueId ? "colleague" : "list")}
            >
              <BackIcon />
            </button>
            <h3>{detailCall.title}</h3>
            <div className="chat-drawer-header-actions">
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="agenda-detail-body">
            <p className="agenda-detail-when">
              {formatCallDateTime(detailCall.startTs)} · {detailCall.durationMinutes}min
            </p>
            <p className="agenda-detail-creator">
              Marcado por {detailCall.createdByName || "?"} ·{" "}
              {detailCall.visibility === "private" ? "🔒 Privado" : "Público"} ·{" "}
              {detailCall.blocksAgenda === false ? "não trava agenda" : "trava agenda"}
            </p>
            {detailCall.description && <p className="agenda-detail-description">{detailCall.description}</p>}
            <div className="agenda-needs-row">
              {detailCall.needs.camera && (
                <span className="agenda-need-pill">
                  <CamIcon off={false} /> Câmera
                </span>
              )}
              {detailCall.needs.audio && (
                <span className="agenda-need-pill">
                  <MicIcon off={false} /> Áudio
                </span>
              )}
              {detailCall.needs.screen && (
                <span className="agenda-need-pill">
                  <ScreenIcon active={false} /> Tela
                </span>
              )}
            </div>
            {(detailCall.attachments.length > 0 || myCallStatus !== null) && (
              <div className="agenda-attachment-field">
                <span className="agenda-field-label">Anexos</span>
                {detailCall.attachments.length > 0 ? (
                  <div className="agenda-attachment-list">
                    {detailCall.attachments.map((a, i) => (
                      <a
                        key={`${a.url}-${i}`}
                        className="chat-attachment-file"
                        href={attachmentUrl(a.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <FileIcon />
                        <span className="chat-attachment-file-info">
                          <span className="chat-attachment-file-name">{a.name}</span>
                          <span className="chat-attachment-file-size">{formatFileSize(a.size)}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="chat-empty-hint agenda-day-group-empty">Nenhum anexo ainda.</p>
                )}
                {myCallStatus !== null && (
                  <button
                    type="button"
                    className="chat-secondary-btn"
                    onClick={onPickDetailAttachment}
                    disabled={sendingDetailAttachment}
                  >
                    {sendingDetailAttachment ? "Enviando..." : "+ Anexar arquivo"}
                  </button>
                )}
              </div>
            )}
            <span className="agenda-field-label">Participantes</span>
            <div className="agenda-participant-list">
              {detailCall.participants.map((p) => (
                <div key={p.id} className="agenda-participant-row">
                  <span className="chat-conv-avatar" style={{ background: p.color }}>
                    {(p.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="agenda-participant-name">{p.id === myUserId ? "Você" : p.name || "Sem nome"}</span>
                  <span className={`agenda-badge ${p.status}`}>
                    {p.status === "approved" ? "Confirmado" : p.status === "declined" ? "Recusou" : "Aguardando"}
                  </span>
                </div>
              ))}
            </div>
            {myCallStatus === "pending" && (
              <div className="agenda-respond-row">
                <button className="chat-primary-btn" onClick={() => onRespondToCall(detailCall.id, "approved")}>
                  Confirmar presença
                </button>
                <button className="chat-secondary-btn" onClick={() => onRespondToCall(detailCall.id, "declined")}>
                  Recusar
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ChatMessageRow({
  msg,
  own,
  showSenderName,
  onDelete,
}: {
  msg: ChatMessage;
  own: boolean;
  showSenderName: boolean;
  // presente só nas MINHAS mensagens ainda não apagadas -- ver
  // chamadores em ChatDrawer (Sala usa chat:delete_room, conversa de
  // verdade usa chat:delete).
  onDelete?: () => void;
}) {
  if (msg.deleted) {
    return (
      <div className={own ? "chat-message own" : "chat-message"}>
        {showSenderName && <span className="chat-message-sender">{msg.senderName || "Alguém"}</span>}
        <div className="chat-bubble chat-bubble-deleted">
          <em>{own ? "Você apagou uma mensagem" : `${msg.senderName || "Alguém"} apagou uma mensagem`}</em>
        </div>
        <span className="chat-message-time">{formatChatTime(msg.ts)}</span>
      </div>
    );
  }
  return (
    <div className={own ? "chat-message own" : "chat-message"}>
      {showSenderName && <span className="chat-message-sender">{msg.senderName || "Alguém"}</span>}
      <div className="chat-message-row">
        {own && onDelete && (
          <button className="chat-message-delete-btn" title="Apagar mensagem" onClick={onDelete}>
            <TrashIcon />
          </button>
        )}
        <div className="chat-bubble">
          {msg.kind === "text" && <span>{msg.text}</span>}
          {msg.kind === "image" && msg.attachment && (
            <a href={attachmentUrl(msg.attachment.url)} target="_blank" rel="noreferrer">
              <img className="chat-attachment-image" src={attachmentUrl(msg.attachment.url)} alt={msg.attachment.name} />
            </a>
          )}
          {msg.kind === "audio" && msg.attachment && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio className="chat-attachment-audio" controls src={attachmentUrl(msg.attachment.url)} />
          )}
          {msg.kind === "file" && msg.attachment && (
            <a
              className="chat-attachment-file"
              href={attachmentUrl(msg.attachment.url)}
              target="_blank"
              rel="noreferrer"
            >
              <FileIcon />
              <span className="chat-attachment-file-info">
                <span className="chat-attachment-file-name">{msg.attachment.name}</span>
                <span className="chat-attachment-file-size">{formatFileSize(msg.attachment.size)}</span>
              </span>
            </a>
          )}
          {msg.text && msg.kind !== "text" && <div className="chat-attachment-caption">{msg.text}</div>}
        </div>
      </div>
      <span className="chat-message-time">{formatChatTime(msg.ts)}</span>
    </div>
  );
}

// --- ícones do chat, mesmo estilo linha-fina dos ícones da av-bar ---

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

// Ícone do botão "Configurações" (ver SettingsPanel) -- engrenagem
// simples (círculo + 8 "dentes"), mesmo estilo contorno dos outros
// ícones da av-bar.
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

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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

function RoomIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="m4 11 8-6.5L20 11M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5"
        stroke="currentColor"
        strokeWidth="1.7"
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
