"use client";

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import { ChatDrawer } from "./ChatDrawer";
// 1/out -- pedido direto do Douglas ("pega o chat de dentro e
// transforma ele em CHAT que acompanha toda a plataforma"): GameRoom
// não é mais dono do PRÓPRIO estado/conexão de conversa (direta/grupo)
// -- isso agora é usePlatformChat, montado uma vez em app/page.tsx e
// recebido aqui por prop (platformChat), o MESMO motor que o Lobby já
// usa (ver comentário grande no topo de usePlatformChat.ts). GameRoom
// continua dono do que é GENUINAMENTE da sala: Sala/"quem tá por
// perto" (chatLog/roomPins/roomTyping), avatar/presença/movimento.
import { usePlatformChat } from "@/components/usePlatformChat";
import { useRoomCompanyProfile } from "@/components/useRoomCompanyProfile";
type PlatformChat = ReturnType<typeof usePlatformChat>;
// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import PartySocket from "partysocket";
import MainScene, {
  DEFAULT_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  FRAME_W,
  FRAME_H,
  skinTextureKey,
  hairTextureKey,
  accessoryTextureKey,
  beardTextureKey,
  outfitTextureKey,
} from "@/game/MainScene";
import { createGameConfig } from "@/game/config";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveUserId } from "@/lib/identity";
import {
  SPACE_VOLUME_STORAGE_KEY,
  CALL_VOLUME_STORAGE_KEY,
  getStoredVolume,
  setStoredVolume,
  getStoredNotificationPrefs,
  setStoredNotificationPrefs,
  fireNotification,
  type NotificationPrefs,
} from "@/lib/settingsPrefs";
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
import RoomMembersPanel from "@/components/RoomMembersPanel";
import FriendsPanel from "@/components/FriendsPanel";
import ItemEditor from "@/components/ItemEditor";
import SettingsPanel from "@/components/SettingsPanel";
import AccountCard from "@/components/AccountCard";
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
  furnitureNearTextureKey,
  registerCustomFurnitureModels,
  FurnitureCategoryId,
  FurnitureCatalogEntry,
  FurnitureDef,
  FurnitureFacing,
  FurnitureModelDef,
  FurnitureSeatOffsetsMap,
  SeatTuningInfo,
} from "@/game/furniture";
import { FLOOR_CATALOG, FloorCatalogEntry, FloorTileDef, floorTextureKey, registerCustomFloorModels } from "@/game/floor";
import { WALL_CATALOG, WallCatalogEntry, WallSegmentDef, registerCustomWallModels, wallEdgeLengthPx } from "@/game/wall";
import {
  DOOR_CATALOG,
  DOOR_FACING_ROTATE_ORDER,
  DoorCatalogEntry,
  DoorFacing,
  DoorSegmentDef,
  DoorSide,
  registerCustomDoorModels,
  doorTextureKey,
} from "@/game/door";
import { FloorPatternSwatch } from "@/components/FloorPatternSwatch";
import { WallPatternSwatch } from "@/components/WallPatternSwatch";
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
  ColorOption,
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
  // slug da sala a entrar (ver comentário grande "MULTI-SALA" em
  // server/roomStore.js) -- pedido do Douglas: "Mapa modelo (ja pode
  // criar um, mesmo que sem decoracao, so pra gente estruturar como vai
  // ser pros clientes)". Default "mapa-publicado" (= Mapa Publicada,
  // mesmo valor hardcoded de sempre) pra quem já chamava <GameRoom />
  // sem essa prop continuar entrando EXATAMENTE na mesma sala de antes
  // -- ver roomSlug escolhido em app/page.tsx (state novo, setado pelo
  // Lobby) e ROOM_SLUGS em Lobby.tsx.
  roomSlug?: string;
  // 29/set (8), pedido do Douglas: "clicavel, o X se mantem quando
  // entra na sala, e ele vira um link de retorno pro lobby" -- o
  // logo (só o X, ver .room-logo-home-btn no JSX mais abaixo) fica
  // fixo no canto, igual o topbar do Lobby, e clicar chama isso pra
  // voltar (ver app/page.tsx, que troca `entered` de volta pra
  // false). Opcional só pra continuar aceitando <GameRoom /> sem essa
  // prop (mesmo espírito de onSignOut acima) -- sem ela, o botão
  // simplesmente não aparece.
  onBackToLobby?: (() => void) | null;
  // motor único de conversa (ver comentário grande no import de
  // usePlatformChat acima) -- montado UMA VEZ acima da troca
  // Lobby<->GameRoom (ver PlatformChatHost em app/page.tsx), não aqui.
  platformChat: PlatformChat;
  // MESMO MediaStream ref que localStreamRef usava antes (câmera/mic da
  // Sala) -- agora criado em PlatformChatHost (app/page.tsx) e passado
  // tanto pra cá quanto pro usePlatformChat (ambientStreamRef), pra
  // gravação de áudio/chamada de conversa reaproveitarem a MESMA
  // captura em vez de pedir getUserMedia de novo (ver comentário grande
  // de getLocalStreamForCalls em usePlatformChat.ts).
  ambientStreamRef: MutableRefObject<MediaStream | null>;
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
// seatDCol/seatDRow: qual ASSENTO desse item (0/0 = âncora, comportamento
// de sempre) -- ver FurnitureModelDef.extraSeats em game/furniture.ts,
// pedido do Douglas pra sofá/item com mais de um lugar. Undefined (item
// antigo sem modelId, ou item sem extraSeats) equivale a 0/0.
export type RemotePlayer = {
  id: string;
  userId: string;
  x: number;
  y: number;
  color: string;
  seatFurnitureId?: string | null;
  seatDCol?: number;
  seatDRow?: number;
  // aparência do boneco (ver LOOK_FIELDS/protocolo "look" em
  // server/index.js e setRemoteLook em MainScene.ts -- pedido do
  // Douglas, 30/set: "o estilo roupa que ele escolher do avatar, deve
  // seguir ele em qualquer ambiente que ele for"). Cada campo é
  // OPCIONAL/pode vir null -- o boneco começa com a aparência PADRÃO
  // (ver createAvatar) até o "look" de verdade chegar pela rede.
  hairId?: string | null;
  skinId?: string | null;
  beardId?: string | null;
  accessoryId?: string | null;
  outfitId?: string | null;
} & RemoteProfile;
type Toast = { id: string; text: string };

// --- chat de verdade (direta/grupo/histórico/anexos) -- ver comentário
// grande no topo de server/index.js e server/chatStore.js pro protocolo
// e a persistência. O chat de SALA (chatLog/chatInput/sendChat) usa o
// MESMO formato de mensagem (ChatMsgBase, com foto/arquivo/áudio) mas
// não fica salvo em disco -- ver o case "chat" em server/index.js --
// então "Sala" aparece junto na mesma gaveta (ver ChatDrawer) como só
// mais uma entrada na lista de conversas, mesmo não sendo uma de
// verdade (não tem conversationId, ninguém precisa abrir histórico).
export type ChatAttachmentKind = "image" | "file" | "audio";
export type ChatAttachment = { url: string; name: string; size: number; mime: string };
// cardzinho de "convidar amigo pra sua sala" / "pedir pra visitar"
// (pedido do Douglas, 30/set) -- action "invite" já vem com a sala de
// quem convidou; action "visit" não carrega sala nenhuma, é só o
// pedido (ver sendRoomCard/ChatMessageRow mais abaixo).
export type RoomCard = { action: "invite" | "visit"; roomSlug: string; roomName: string; roomLogoUrl: string };
export type ChatMsgKind = "text" | ChatAttachmentKind | "room_card";
// reação com emoji (pedido do Douglas, 1/out, comparando com o Slack)
// -- emoji -> lista de userId que reagiram com ele, ver ChatMessageRow/
// toggleReaction.
export type ChatReactions = Record<string, string[]>;
export type ChatMsgBase = {
  id: string;
  senderId: string;
  senderName: string;
  kind: ChatMsgKind;
  text: string;
  attachment: ChatAttachment | null;
  roomCard: RoomCard | null;
  ts: number;
  // true quando alguém apagou essa mensagem ("apaga pra todos") -- o
  // texto/anexo original já vem vazio do servidor nesse caso, o bubble
  // mostra só a tarja "Fulano apagou uma mensagem" (ver ChatMessageRow).
  deleted?: boolean;
  // 1/out, pedido do Douglas (comparando com o Slack) -- reação/
  // @menção. Opcionais só pra não quebrar nada que montava um
  // ChatMsgBase na mão antes dessa mudança (ver fallback `?? {}`/`?? []`
  // nos lugares que leem).
  reactions?: ChatReactions;
  mentionedUserIds?: string[];
  // "responder mensagem" (2/out, pedido do Douglas: "Dar dois clique
  // na mensagem ativar a resposta a mensagem" + "Arquivos ficam com
  // historico de mensagens mencionadas a ele") -- RETRATO congelado da
  // mensagem original na hora que essa resposta foi mandada (ver
  // comentário grande de addMessage em server/chatStore.js), não uma
  // referência viva -- mesmo espírito de companyName/lane "última
  // conhecida" que o resto do chat já usa. `deleted` conta se a
  // original JÁ TINHA sido apagada nessa hora (texto/attachmentName já
  // vêm vazios nesse caso). Opcional pelo mesmo motivo de
  // reactions/mentionedUserIds acima.
  replyTo?: {
    messageId: string;
    senderId: string;
    senderName: string;
    kind: ChatMsgKind;
    text: string;
    attachmentName: string | null;
    // "na conversa precisa aparecer a resposta selecionada ao
    // arquivo, igual no whats" (2/out, pedido do Douglas) -- caminho
    // do anexo original (mesmo formato de ChatAttachment.url, passa
    // por attachmentUrl() pra virar link completo), pra renderizar
    // miniatura de verdade na citação (ver chat-reply-quote-thumb em
    // ChatDrawer), não só ícone + nome.
    attachmentUrl: string | null;
    deleted: boolean;
  };
};
export type ChatMsg = ChatMsgBase & { conversationId: string };
// mensagem da SALA -- mesmo formato, sem conversationId (ver comentário acima)
export type ChatMessage = ChatMsgBase;
// mensagem fixada (pedido do Douglas, 1/out: "mensagem fixada (definir
// tempo de fixacao)") -- expiresAt null = sem prazo (fixa até alguém
// tirar à mão, ver PIN_DURATION_OPTIONS/ChatDrawer).
export type ChatPin = { messageId: string; pinnedBy: string; pinnedByName: string; pinnedAt: number; expiresAt: number | null };
// "fulano está digitando..." (pedido do Douglas, 1/out) -- efêmero, só
// em memória (nunca persiste) -- ts é quando a última notificação
// chegou, usado pra expirar sozinho depois de alguns segundos sem
// novidade (ver TYPING_EXPIRE_MS/ChatDrawer).
export type ChatTypingEntry = { userId: string; name: string; ts: number };
// quanto tempo um "digitando..." fica na tela sem receber novidade --
// ver comentário grande no tipo acima.
const TYPING_EXPIRE_MS = 4000;
// opções de "tempo de fixação" do composer de fixar (pedido do Douglas,
// 1/out: "mensagem fixada (definir tempo de fixacao)") -- durationMs
// null = sem prazo (fixa até alguém tirar à mão).
export const PIN_DURATION_OPTIONS: { label: string; durationMs: number | null }[] = [
  { label: "1 hora", durationMs: 60 * 60 * 1000 },
  { label: "6 horas", durationMs: 6 * 60 * 60 * 1000 },
  { label: "24 horas", durationMs: 24 * 60 * 60 * 1000 },
  { label: "7 dias", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "Sem prazo", durationMs: null },
];
// conjunto fixo de emoji rápidos pro popover de reação (pedido do
// Douglas, 1/out: "reação com emoji nas mensagens") -- mesmo conjunto
// do chat de fora da sala, ver QUICK_REACTION_EMOJIS em Lobby.tsx.
export const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "👏"];
// item do painel lateral "arquivos da conversa" (pedido do Douglas,
// 1/out) -- igual uma mensagem, só os campos que o painel precisa pra
// listar/baixar/mencionar de novo.
export type ChatAttachmentItem = {
  messageId: string;
  senderId: string;
  senderName: string;
  kind: ChatMsgKind;
  attachment: ChatAttachment;
  ts: number;
};
export type ConversationParticipant = { id: string; name: string; color: string; photoUrl: string };
export type Conversation = {
  id: string;
  kind: "direct" | "group";
  // "company" (conversa normal, sempre foi assim -- qualquer um com
  // qualquer um) ou "private" (só entre amigos mútuos), ver comentário
  // grande em server/chatStore.js/getOrCreateDirectConversation.
  // Grupos (kind "group") são sempre "company" (servidor nunca manda
  // "private" num grupo, ver chat:create_group em server/index.js).
  lane: "company" | "private";
  name: string | null;
  // 29/set (13), pedido do Douglas: "quero a logo da empresa em que
  // ele abriu o chat, porque funcionarios podem participar de mais
  // empresas" -- nome/logo da empresa (sala) onde essa conversa
  // nasceu, congelados na criação (ver companyName/companyLogoUrl em
  // server/chatStore.js/getOrCreateDirectConversation). Só lane
  // "company" tem valor aqui -- "private" e conversa criada ANTES
  // dessa mudança ficam null.
  companyName: string | null;
  companyLogoUrl: string | null;
  participantIds: string[];
  participants: ConversationParticipant[]; // só os OUTROS, sem mim
  updatedAt: number;
  // 29/set (14), pedido do Douglas: "gostei da forma de mostrar que
  // tem mensagem, mantenha / mas nao esta funcionando" -- contador de
  // mensagem não vista de verdade (ver unreadCount em
  // server/chatStore.js/listConversationsForUser). Opcional só pra
  // não quebrar nada que construía um Conversation na mão antes dessa
  // mudança (nenhum lugar faz isso hoje, mas por segurança).
  unreadCount?: number;
  lastMessage: { senderId: string; senderName: string; kind: ChatMsgKind; text: string; ts: number } | null;
  // "Silenciar" (2/out, pedido do Douglas) -- SÓ pra mim (ver mutedBy
  // em server/chatStore.js/listConversationsForUser), nunca afeta os
  // outros participantes nem o unreadCount. Opcional pelo mesmo motivo
  // de unreadCount acima.
  muted?: boolean;
};

// --- chamada de voz/vídeo de uma conversa (chat direto/grupo, "tipo
// discord") -- ver comentário grande em server/index.js (call:join/
// call:leave/call:state). connectionId é o que endereça o mesh de
// WebRTC (ver callPeersRef em GameRoom), userId/name/color/photoUrl são
// só pra desenhar (quem já tá dentro, o botão verde na lista, etc). ---
export type ChatCallParticipant = { connectionId: string; userId: string; name: string; color: string; photoUrl: string };

// --- Agenda (marcar call: data/horário/participantes, necessidades de
// câmera/áudio/tela, aprovação dos convidados) -- ver comentário grande
// no topo de server/index.js e server/agendaStore.js pro protocolo e a
// persistência. Mora na MESMA gaveta de chat (ver ChatDrawer), como uma
// segunda aba (Conversas | Agenda). ---
export type CallNeeds = { camera: boolean; audio: boolean; screen: boolean };
export type CallParticipantStatus = "pending" | "approved" | "declined";
export type CallParticipant = { id: string; name: string; color: string; status: CallParticipantStatus };
export type CallVisibility = "public" | "private";
export type CallEvent = {
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
export type DirectoryUser = { userId: string; name: string; color: string; photoUrl: string };
// rascunho do formulário "Marcar call" -- fica num objeto só (em vez de
// um useState por campo) pra dar pra passar/atualizar de um jeito só
// pro ChatDrawer (ver onChangeAgendaForm).
export type AgendaFormState = {
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
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function localTimeStr(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Junta os campos separados de data/horário do formulário (horário
 * LOCAL do navegador, igual um <input type="datetime-local">) num
 * único epoch ms -- o que o servidor usa pra checar conflito e ordenar
 * (ver server/agendaStore.js). NaN se algum campo ainda tiver vazio. */
export function combineLocalDateTime(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return NaN;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}
export function formatCallDateTime(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Nome pra mostrar de uma conversa: nome do grupo se tiver, senão o
 * nome do outro participante (direta) -- usado na lista E no cabeçalho
 * da conversa aberta. */
export function conversationDisplayName(conv: Conversation): string {
  if (conv.kind === "group") return conv.name || "Grupo sem nome";
  return conv.participants[0]?.name || "Sem nome";
}

/** Texto curto de preview pra lista de conversas -- mensagens com anexo
 * não têm texto (ou só uma legenda opcional), então mostra um rótulo
 * pelo tipo em vez de deixar a prévia em branco. */
export function previewText(last: { kind: ChatMsgKind; text: string }): string {
  if (last.kind === "text") return last.text;
  if (last.kind === "image") return "📷 Foto";
  if (last.kind === "audio") return "🎤 Áudio";
  if (last.kind === "room_card") return "🔑 Convite de sala";
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

// mesma ideia de pickRemoteProfile acima, só que pros 5 campos de
// APARÊNCIA (ver comentário grande em RemotePlayer/setRemoteLook,
// MainScene.ts) -- SEM fallback pro padrão de propósito (undefined, não
// string vazia): setRemoteLook já ignora campo ausente/null sozinho
// (mantém o que o boneco já tinha), aplicar um id "vazio" aqui quebraria
// o find() no catálogo do lado da cena.
function pickLook(p: Partial<RemotePlayer> | undefined) {
  return {
    hairId: p?.hairId ?? undefined,
    skinId: p?.skinId ?? undefined,
    beardId: p?.beardId ?? undefined,
    accessoryId: p?.accessoryId ?? undefined,
    outfitId: p?.outfitId ?? undefined,
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
  outfitColorId?: string | null;
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
// USER_ID_STORAGE_KEY/getOrCreateUserId MOVERAM pra lib/identity.ts
// (28/set) -- Lobby.tsx precisa do MESMO id pra buscar chat/agenda
// ANTES da pessoa entrar na sala (ver comentário grande lá), então
// virou um módulo compartilhado em vez de só existir aqui.
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

export function attachmentUrl(path: string): string {
  return path.startsWith("http") ? path : `${REALTIME_HTTP_BASE}${path}`;
}

// mesmo link "?visitar=<slug>" que handleCopyRoomLink (Lobby.tsx) copia
// pra área de transferência -- POST /api/room/visit só registra um
// bookmark (nunca vira membro, ver comentário grande na rota), então
// clicar em "Entrar" num cardzinho de convite nunca torna quem clicou
// um membro da sala (pedido do Douglas: "visitante nao se tornam
// membros"). Navegação de página cheia mesmo (não é troca de state
// interna) -- o Lobby é quem resolve o parâmetro ao carregar.
export function visitRoomLink(roomSlug: string): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/?visitar=${encodeURIComponent(roomSlug)}`;
}

/** Monta a URL de uma rota REST /room/* já com o slug da sala (ver
 * comentário grande "MULTI-SALA" em server/roomStore.js e
 * roomSlugFromUrl em server/index.js) -- toda chamada de
 * GET/POST /room/shape|floor|walls|doors|areas|furniture precisa
 * passar por aqui agora, em vez de montar `${REALTIME_HTTP_BASE}/room/...`
 * direto (senão sempre bateria na sala padrão, "mapa-publicado",
 * mesmo dentro do Mapa Modelo). */
function roomApiPath(roomSlug: string, path: string): string {
  return `${REALTIME_HTTP_BASE}${path}?room=${encodeURIComponent(roomSlug)}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// "0:07", "1:23" etc -- usado no contador de gravação de áudio (ver
// recordingElapsedSec) e no preview antes de mandar.
export function formatRecordingTime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad2(s)}`;
}

// "25/set", "26/set" -- ver o "strip" de dias da Minha Agenda.
const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export function dayChipLabel(dateKey: string, todayKey: string, tomorrowKey: string): string {
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
  roomSlug = "mapa-publicado",
  onBackToLobby = null,
  platformChat,
  ambientStreamRef,
}: GameRoomProps) {
  // atalho curto (mesmo nome que Lobby.tsx já usa pra isso).
  const chat = platformChat;
  // funções 100% de conversa (sem variante de Sala nenhuma) -- ficam só
  // de passagem com o MESMO nome que esse arquivo já chamava, pra não
  // precisar mudar cada chamador: agora são literalmente
  // usePlatformChat.ts, não uma cópia daqui.
  const {
    startDirectWith,
    moveConversationLane,
    muteConversation,
    deleteConversation,
    replyingTo,
    startReplyToMessage,
    cancelReply,
    submitNewConversation,
    toggleNewConvSelection,
    changeNewConvMode,
    submitRenameGroup,
    openFilesPanel,
    closeFilesPanel,
    mentionAttachmentInChat,
    joinCall,
    leaveCall,
    // 1/out (unificação Lobby/GameRoom) -- gravação de áudio também
    // era duas implementações separadas (ver comentário grande em
    // usePlatformChat.ts); agora é 100% dela, aqui só de passagem.
    recordingAudio,
    recordingElapsedSec,
    recordedPreview,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    discardRecordedAudio,
    sendRecordedAudio,
    // 2/out (unificação Lobby/GameRoom) -- Agenda também virou 100%
    // dela (ver comentário grande em usePlatformChat.ts); a gaveta em
    // si nem renderiza mais daqui (ver PlatformAgendaHost em
    // app/page.tsx), só o botão que abre/fecha fica aqui.
    agendaOpen,
    setAgendaOpen,
  } = chat;
  const containerRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<MainScene | null>(null);

  // "página de carregamento" antes de cair na sala -- pedido do Douglas
  // (29/set): "minha acesso na pagina caindo em uma mesa aleatoria ta
  // aparecendo o balao de assumir, isos seria por um delay de
  // carregamento? / se a gente criar uma pagina de carregamento antes
  // de cair direto na sala, resolveria... inclusive assim a pessoa faz
  // o download da sala toda antes de entrar pra nao ir vendo carregando
  // as coisas aos poucos". Fica true só depois que as 6 buscas de
  // estado salvo da sala (piso/mobília/parede/porta/área/formato, ver
  // *LoadedRef mais abaixo e markRoomAssetsReadyIfDone dentro de
  // runWhenSceneReady) já tiverem TODAS terminado -- sucesso ou falha,
  // mesma regra de cada *LoadedRef individual (o autosave de cada aba
  // já confiava nelas antes disso, só nunca tinha um "e quando TODAS
  // terminam" combinado até agora). Não cobre o balão de "Assumir essa
  // mesa?" aparecer sozinho no spawn -- isso é bug à parte, de POSIÇÃO
  // (ver o fix em updateAreaDim, MainScene.ts), não de tempo: essa tela
  // aqui só evita ver piso/móvel/parede aparecendo aos poucos.
  const [roomAssetsReady, setRoomAssetsReady] = useState(false);
  // continua MONTADA até o próprio fade-out da RoomLoadingScreen
  // terminar (ver onExited/onTransitionEnd nela) -- só desmonta de
  // vez depois disso, senão sumiria seco (sem a transição de
  // opacidade) assim que roomAssetsReady virasse true.
  const [roomLoadingScreenMounted, setRoomLoadingScreenMounted] = useState(true);

  // balão "destituir mesa de fulano?" (ver
  // scene.onAreaDestituirPromptChange logo abaixo) -- pedido do Douglas
  // depois do resultado ficar "pixelado, meio estilo do jogo" mesmo
  // depois de várias rodadas de ajuste no Phaser: "nao tem como ele
  // ficar como as coisas de fora? afinal ele e um balao com botao".
  // Esse state só guarda SE tem balão aberto e a MENSAGEM/ÂNCORA
  // (coordenada de MUNDO do Phaser, não de tela) -- a aparência em si
  // (cor/blur/sombra/fonte) é 100% CSS agora (ver AreaConfirmBalloon
  // mais abaixo no arquivo), não mais desenhada pelo Phaser.
  // areaDestituirBalloonRef é o DIV de verdade na tela, reposicionado A
  // CADA FRAME via requestAnimationFrame (ver efeito logo abaixo) direto
  // no .style (sem passar por state/re-render -- 60x por segundo é caro
  // demais pra isso), convertendo mundo -> câmera
  // (scene.worldToCameraPoint) -> pixel de CSS de verdade
  // (canvas.getBoundingClientRect() vs game.scale.width/height, já que o
  // canvas pode estar redimensionado em tela de forma diferente da
  // resolução interna do jogo, ver Scale.ENVELOP em game/config.ts). Um
  // balão irmão "deseja assumir essa mesa?" (convite automático ao
  // entrar andando numa mesa livre) chegou a existir com o MESMO padrão
  // -- removido por pedido do Douglas ("ainda ta aparecendo pra eu pegar
  // a mesa toda hora"), mesmo motivo do balão de "soltar mesa" removido
  // antes ("tira ele"). Depois disso ele tirou a confirmação de assumir
  // por completo (clique chamava onClaimArea direto) -- e sentiu falta
  // do CARD: "cade o CARD que a gente tinha criado? em css bem bonitinho
  // com sim e nao". areaClaimPrompt logo abaixo é o MESMO padrão de
  // novo, mas só no clique deliberado do botão "Assumir mesa", nunca
  // sozinho andando (ver showAreaClaimPrompt em MainScene.ts).
  const [areaDestituirPrompt, setAreaDestituirPrompt] = useState<{
    areaId: string;
    message: string;
    x: number;
    y: number;
  } | null>(null);
  const areaDestituirBalloonRef = useRef<HTMLDivElement>(null);
  // balão "Assumir essa mesa?" (ver scene.onAreaClaimPromptChange logo
  // abaixo) -- MESMO padrão exato do areaDestituirPrompt acima, campo a
  // campo (state só com mensagem/âncora, ref reposicionado a cada frame
  // no mesmo efeito único de ambos os balões).
  const [areaClaimPrompt, setAreaClaimPrompt] = useState<{
    areaId: string;
    message: string;
    x: number;
    y: number;
  } | null>(null);
  const areaClaimBalloonRef = useRef<HTMLDivElement>(null);
  // card "quem é o dono dessa mesa" ao passar o mouse numa mesa JÁ
  // assumida (ver scene.onAreaOwnerHoverCardChange logo abaixo) --
  // pedido do Douglas com print de referência: foto de perfil (moldura
  // circular), nome+bolinha de status, status embaixo, linha
  // separadora, fileira de botões só de ÍCONE (Perfil/Chamar/"posso ir
  // aí?"/abrir conversa). MESMO padrão de posicionamento por
  // requestAnimationFrame dos balões acima, mas SEM Sim/Não -- é hover
  // puro, não confirmação -- por isso precisa de um pequeno "atraso pra
  // esconder" (areaOwnerHoverCardHideTimer): a cena manda null assim
  // que o mouse sai da hitbox da mesa (Phaser), o que também acontece
  // ao entrar com o mouse EM CIMA do próprio card (ele fica por cima do
  // canvas) -- sem esse atraso, o card sumiria na hora que o usuário
  // tenta clicar num dos botões dele. onMouseEnter/onMouseLeave do
  // próprio card (ver JSX) cancelam/reagendam esse timer, então ele só
  // fecha de verdade quando o mouse sai tanto da mesa quanto do card.
  const [areaOwnerHoverCard, setAreaOwnerHoverCard] = useState<{
    areaId: string;
    playerId: string;
    x: number;
    y: number;
  } | null>(null);
  const areaOwnerHoverCardRef = useRef<HTMLDivElement>(null);
  const areaOwnerHoverCardHideTimer = useRef<number | null>(null);
  function cancelHideAreaOwnerHoverCard() {
    if (areaOwnerHoverCardHideTimer.current !== null) {
      window.clearTimeout(areaOwnerHoverCardHideTimer.current);
      areaOwnerHoverCardHideTimer.current = null;
    }
  }
  function scheduleHideAreaOwnerHoverCard() {
    if (areaOwnerHoverCardHideTimer.current !== null) return;
    areaOwnerHoverCardHideTimer.current = window.setTimeout(() => {
      areaOwnerHoverCardHideTimer.current = null;
      setAreaOwnerHoverCard(null);
    }, 200);
  }
  /** Fecha o card na hora (sem o atraso de scheduleHideAreaOwnerHoverCard) -- usado ao clicar em qualquer uma das ações dele, pra não ficar flutuando atrás do que abrir em seguida (perfil/chat). */
  function closeAreaOwnerHoverCardNow() {
    cancelHideAreaOwnerHoverCard();
    setAreaOwnerHoverCard(null);
  }
  const socketRef = useRef<PartySocket | null>(null);
  // MESMO ref de sempre, só que agora vem de fora (ver
  // ambientStreamRef em GameRoomProps acima) em vez de nascer aqui --
  // nenhuma leitura/escrita abaixo precisou mudar, é o mesmo objeto.
  const localStreamRef = ambientStreamRef;
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remotePlayersRef = useRef<Map<string, RemotePlayer>>(new Map());
  const connectedPeersRef = useRef<Set<string>>(new Set());
  // último valor REALMENTE aplicado em setRemoteMeta (ver checkProximity
  // mais abaixo) -- usado só pra decidir se um novo "move" recebido
  // precisa mesmo disparar um re-render, ou se é ruído (nome/distância
  // arredondada iguais ao que já tava lá).
  const lastRemoteMetaRef = useRef<Record<string, { name: string; distance: number }>>({});
  const selfIdRef = useRef<string>("");
  // valor inicial vem do que a pessoa já tinha escolhido no LOBBY (ver
  // lib/mediaPrefs.ts, pedido do Douglas: "cade o restante,
  // configuracoes, audio, video, tela") -- sem isso, mutar o mic no
  // Lobby e entrar na sala destravaria ele de novo sozinho.
  const [micOn, setMicOn] = useState(() => getStoredMicOn());
  const [camOn, setCamOn] = useState(() => getStoredCamOn());
  const [screenOn, setScreenOn] = useState(false);

  // 2/out, pedido do Douglas: "porque a camera fica ali preta?" --
  // o <video className="local-video"> (ver JSX mais abaixo) sempre
  // ficava montado, com o stream sempre anexado (ver requestMedia
  // acima/toggleScreenShare abaixo), MESMO com a câmera desligada.
  // toggleCam só desativa a TRACK (t.enabled = false, ver mais
  // abaixo) -- e uma track de vídeo desativada, por padrão do
  // navegador (WebRTC/MediaStream), renderiza quadro PRETO sólido,
  // não "nada"/transparente. Resultado: um retângulo preto flutuando
  // no canto mesmo sem câmera nenhuma ligada.
  // Fix: só MOSTRA o quadradinho quando tem algo de verdade pra
  // exibir (câmera ligada OU tela compartilhada -- o mesmo <video>
  // é reaproveitado pra tela, ver toggleScreenShare). Como o React
  // desmonta o <video> quando os dois ficam false, o ref zera junto
  // -- esse efeito reconecta o srcObject sempre que ele reaparece
  // (camOn ou screenOn voltam a true), já que o <video> é um
  // elemento NOVO nesse remount e não herda o srcObject de antes.
  useEffect(() => {
    if (!localVideoRef.current) return;
    if (screenOn) {
      localVideoRef.current.srcObject = screenStreamRef.current;
    } else if (camOn) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [camOn, screenOn]);

  // --- Configurações (ver SettingsPanel/botão de engrenagem na av-bar)
  // -- deviceId ESCOLHIDO de cada aparelho ("" = padrão do navegador,
  // não mexeu ainda, ou escolha vinda do Lobby, ver acima), e o
  // volume: "som do espaço" é um multiplicador GERAL (afeta todo mundo
  // de uma vez, pedido do Douglas), remoteVolumes é o ajuste fino POR
  // PESSOA (id de dentro de remoteStreams -> 0..1) -- os dois se
  // multiplicam na hora de aplicar (ver RemoteVideoTile mais abaixo).
  //
  // 30/set (5), pedido do Douglas: "Volume do espaco, deixe ele
  // alterar mesmo fora de um [espaço], pra que quando entre ja esteja
  // no volume certo" -- ao contrário do que o comentário acima dizia
  // até aqui ("volume não faz sentido lembrar"), agora PERSISTE (ver
  // lib/settingsPrefs.ts, mesmo esquema de lib/mediaPrefs.ts pro
  // mic/câmera/saída) -- só remoteVolumes (ajuste POR PESSOA) continua
  // sem persistir, esse sim não faz sentido guardar (é sempre gente
  // diferente cada vez que entra). "Volume de chamadas" (callVolume) é
  // um canal SEPARADO -- volume da chamada de voz/vídeo de uma
  // conversa ("tipo Discord", ver ChatCallVideoTile mais abaixo), não
  // tem nada a ver com o áudio de proximidade do mapa.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState(() => getStoredMicDeviceId());
  const [selectedCamId, setSelectedCamId] = useState(() => getStoredCamDeviceId());
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => getStoredSpeakerDeviceId());
  const [spaceVolume, setSpaceVolumeState] = useState(() => getStoredVolume(SPACE_VOLUME_STORAGE_KEY));
  const [callVolume, setCallVolumeState] = useState(() => getStoredVolume(CALL_VOLUME_STORAGE_KEY));
  const [notificationPrefs, setNotificationPrefsState] = useState<NotificationPrefs>(() => getStoredNotificationPrefs());
  const notificationPrefsRef = useRef(notificationPrefs);
  notificationPrefsRef.current = notificationPrefs;
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
  const [remoteVolumes, setRemoteVolumes] = useState<Record<string, number>>({});

  const [status, setStatus] = useState("Conectando...");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  // nome/distância de cada jogador remoto pra opacidade/legenda dos
  // vídeos (ver RemoteVideoTile) -- NÃO é mais estado aqui (ver
  // remoteMetaSetterRef logo abaixo e RemoteVideosLayer no fim do
  // arquivo). Motivo (pedido do Douglas: "rodei de novo e tá lento
  // ainda, o caminhar todo"): checkProximity roda a cada "move" de
  // CADA jogador remoto (até 20x/s por pessoa) e, andando, a distância
  // muda o tempo todo -- um setState AQUI (componente raiz, com chat/
  // editor/painéis inteiros por baixo) re-renderizava a árvore GIGANTE
  // do GameRoom inteira a cada uma dessas mensagens. Isolado num
  // componente FILHO memoizado que guarda esse estado por conta
  // própria, só a lista pequena de vídeos re-renderiza, nunca o
  // GameRoom.
  const remoteMetaSetterRef = useRef<
    ((meta: Record<string, { name: string; distance: number }>) => void) | null
  >(null);
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
  const myUserId = useMemo(() => resolveUserId(accountUserId), [accountUserId]);
  // ref pro token de acesso ATUAL (renovado sozinho pelo Supabase de
  // tempos em tempos, ver onAuthStateChange em AuthGate.tsx -- por
  // isso é ref e não só a prop direto: o handler de "identify" abaixo
  // roda dentro de um useEffect que conecta UMA VEZ só, precisa ler o
  // valor mais novo sem depender de re-executar o efeito inteiro,
  // mesmo motivo de myProfileRef.current logo abaixo).
  const accountAccessTokenRef = useRef(accountAccessToken);
  accountAccessTokenRef.current = accountAccessToken;
  const [chatOpen, setChatOpen] = useState(false);
  // mensagem fixada/"digitando..." da SALA (pseudo-conversa, ver
  // chatInput/chatLog acima) -- conversa de verdade (direta/grupo) é
  // 100% de chat.* agora (motor único, ver usePlatformChat.ts).
  const [roomPins, setRoomPins] = useState<ChatPin[]>([]);
  const [roomTyping, setRoomTyping] = useState<ChatTypingEntry[]>([]);
  // @menção (pedido do Douglas, 1/out) -- quem foi @mencionado na
  // mensagem que tô digitando AGORA na Sala (preenchido por
  // insertMention no ChatDrawer, zerado depois que a mensagem sai, ver
  // sendChat mais abaixo). Conversa de verdade usa o pendingMentionIds
  // do motor único (ver chatDrawerProps/onAddPendingMentionId).
  const [pendingMentionIds, setPendingMentionIds] = useState<string[]>([]);
  // "fulano está digitando..." da Sala não tem "parei de digitar"
  // explícito -- quem RECEBE precisa varrer sozinho de tempos em
  // tempos e tirar quem não mandou novidade há TYPING_EXPIRE_MS, senão
  // o "digitando..." nunca sumiria se a pessoa simplesmente parasse sem
  // mandar mais nada. Conversa de verdade tem o PRÓPRIO expire-sweep
  // (ver usePlatformChat.ts).
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - TYPING_EXPIRE_MS;
      setRoomTyping((prev) => (prev.some((t) => t.ts < cutoff) ? prev.filter((t) => t.ts >= cutoff) : prev));
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  // espelha "tô literalmente vendo essa conversa AGORA" (drawer aberto
  // + na aba de thread) pro motor único saber se soma no contador de
  // não-lida ou se já considera "vista" na hora (pedido do Douglas:
  // "quando eu vejo, ela nao some a marcacao") -- ver updateReadingState
  // em usePlatformChat.ts (MESMO padrão que Lobby.tsx já usa).
  useEffect(() => {
    chat.updateReadingState(chatOpen && chat.chatView === "thread");
    return () => chat.updateReadingState(false);
  }, [chat, chatOpen, chat.chatView, chat.activeConversationId]);
  // 30/set, pedido do Douglas: "quero essa aba sempre aberta com o
  // chat, quero que eles vejam a possibilidade, sempre ali, abriu o
  // chat, ela ta junto" -- MESMA ideia do Lobby (ver myRoomLogoUrl lá
  // em components/Lobby.tsx): nome/logo da empresa dessa SALA (a que
  // tá aberta agora, "onde ele abriu o chat" -- mesma fonte que
  // getRoomCompanyInfo usa no servidor, só que essa aqui é a versão
  // pública/cliente, GET /api/room/company-profile) entram como opção
  // garantida em companyOptions do ChatDrawer, mesmo sem nenhuma
  // conversa ainda. Usado também pra avisar o motor único QUAL é
  // "minha sala agora" (ver useEffect de chat.setRoomContext mais
  // abaixo).
  // 2/out, história de 3 capítulos (ver comentário grande igual em
  // components/Lobby.tsx): isso aqui chegou a buscar o profile
  // SOZINHO (cópia quase igual à do Lobby), depois mandei a busca pra
  // dentro do motor único do chat (usePlatformChat) -- aí um bug nela
  // conseguiu derrubar a lista de CONVERSAS junto, porque moravam no
  // mesmo componente/estado ("toda hora aparece um novo, isola esse
  // chat cara, o chat tem que ser uma coisa só"). Agora a busca mora
  // em useRoomCompanyProfile.ts -- UMA implementação, usada aqui e no
  // Lobby, cada chamada com seu próprio estado ISOLADO (nunca entra
  // no motor do chat). Só avisa o motor QUAL slug é "minha sala"
  // (chat.setRoomContext recebe slug/nome/logo como PRIMITIVAS, nunca
  // um objeto montado na hora -- estruturalmente imune a loop) pra
  // ele saber carimbar "Empresa" numa conversa nova/convite.
  const { name: roomCompanyName, logoUrl: roomCompanyLogoUrl } = useRoomCompanyProfile(roomSlug);
  useEffect(() => {
    chat.setRoomContext(roomSlug, roomCompanyName, roomCompanyLogoUrl);
  }, [chat, roomSlug, roomCompanyName, roomCompanyLogoUrl]);

  // recordingAudio/recordingElapsedSec/recordedPreview/
  // startVoiceRecording/stopVoiceRecording/cancelVoiceRecording/
  // discardRecordedAudio/sendRecordedAudio agora são 100% de
  // usePlatformChat.ts (ver destructure de "chat" lá em cima) -- não
  // existem mais aqui.
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
  // autoOpenNextConversationRef (abrir sozinho a conversa que EU acabei
  // de criar) agora é interno de usePlatformChat.ts -- não existe mais
  // aqui.
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  // 2/out -- Agenda migrada pro motor único (usePlatformChat.ts, ver
  // comentário grande de lá: "quero ela toda isolada tambem, e sistema
  // unico, assim como o chat, funcionando acima de tudo, acima de
  // lobby acima de jogo"). Todo o estado/handlers que vivia aqui
  // (agendaOpen/calls/busyUserIds/agendaView/agendaForm/allUsers/etc)
  // agora é `chat.*` -- a gaveta em si (AgendaDrawer) nem renderiza
  // mais daqui, ver PlatformAgendaHost em app/page.tsx.
  // Painel "Contatos" -- pedido do Douglas: "quero agora, mais um
  // icone de contatos" (28/set) -- ainda local, fora do escopo dessa
  // migração (só a Agenda foi pedida).
  const [contactsOpen, setContactsOpen] = useState(false);

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

  // registra showErrorToast como o aviso visual genérico do motor único
  // (ver setToastHandler/toastHandlerRef em usePlatformChat.ts --
  // generalizado de "RecordingError" quando a Agenda migrou pra lá
  // também: mic falhando, convite/lembrete de compromisso, falha ao
  // anexar arquivo na agenda, tudo passa por aqui agora) -- só a Sala
  // tem esse toast; o Lobby não registra nada, continua só logando no
  // console (nunca teve esse aviso visual).
  useEffect(() => {
    chat.setToastHandler(showErrorToast);
    return () => chat.setToastHandler(null);
  }, [chat]);

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

  // --- papel GLOBAL na Sala Principal (ver supabase/migrations/0001_accounts.sql
  // e app/api/room/members) -- só quem tem conta (accountUserId, ver
  // AuthGate.tsx) tem um "role" de verdade; sem conta fica sempre
  // "visitor". NÃO é sobre a sala ATUAL (ver isCurrentRoomOwner logo
  // abaixo, que é o que importa em qualquer sala que não seja a Sala
  // Principal) -- roomRole só serve hoje pro botão "Membros" (só existe
  // conceito de time/convite lá, ver comentário dele mais abaixo).
  // presenceCounts é só decorativo (contador na tela), aparece pra todo
  // mundo. ---
  const [roomRole, setRoomRole] = useState<"owner" | "member" | "visitor">("visitor");
  // --- dono de VERDADE da sala ATUAL (roomSlug -- ver GET
  // /api/room/owner, checa public.rooms.owner_user_id) -- CORRIGIDO
  // 29/set: até aqui canEditRoom/scene.setRoomOwner usavam o roomRole
  // acima (papel GLOBAL na Sala Principal, pré multi-sala), então o
  // dono da Sala Principal aparecia como "dono" em QUALQUER sala que
  // abrisse, inclusive a de um cliente (bug de autorização real, não só
  // visual -- o servidor tinha o mesmo problema, ver callerIsOwner em
  // server/index.js, corrigido junto). Isso aqui funciona igual pra
  // Sala Principal (o Douglas já é owner_user_id dela) e pra sala
  // própria de cada cliente. ---
  const [isCurrentRoomOwner, setIsCurrentRoomOwner] = useState(false);
  const isCurrentRoomOwnerRef = useRef(isCurrentRoomOwner);
  isCurrentRoomOwnerRef.current = isCurrentRoomOwner;
  useEffect(() => {
    if (!accountAccessToken) {
      setIsCurrentRoomOwner(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/room/owner?room=${encodeURIComponent(roomSlug)}`, {
      headers: { Authorization: `Bearer ${accountAccessToken}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setIsCurrentRoomOwner(Boolean(data?.isOwner));
      })
      .catch(() => {
        if (!cancelled) setIsCurrentRoomOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken, roomSlug]);
  // libera "Editar espaço" (ver IS_ROOM_EDITOR_ENABLED acima) sempre em
  // dev, e em qualquer ambiente pro DONO DESSA sala -- membro/visitante/
  // dono de OUTRA sala nunca, em lugar nenhum.
  const canEditRoom = IS_ROOM_EDITOR_ENABLED || isCurrentRoomOwner;

  // 29/set (13): a aba "Empresa" do chat deixou de precisar de um
  // nome fixo (ver comentário grande em companyName/companyLogoUrl no
  // tipo Conversation e chat-conv-company-logo mais abaixo) -- cada
  // conversa agora carrega sua PRÓPRIA empresa (funcionário pode
  // participar de mais de uma), então mostrar aqui só a MINHA empresa
  // (GET /api/room/mine) ficaria errado/incompleto pras conversas de
  // outras empresas que ele também participa. Removido o
  // myCompanyName/fetch que só alimentava esse rótulo.

  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [presenceCounts, setPresenceCounts] = useState<{ memberCount: number; visitorCount: number } | null>(null);

  // --- admin da PLATAFORMA (tabela platform_admins, ver GET
  // /api/admin/me e lib/supabase/roomAuth.ts) -- NÃO é o mesmo que
  // roomRole==="owner" acima: dono de sala só manda na sala dele
  // (canEditRoom/"Editar espaço"); isPlatformAdmin é quem pode abrir o
  // Editor de Itens e cadastrar no catálogo GLOBAL (hoje, só o
  // Douglas). Só controla se o botão "Itens" aparece -- a permissão de
  // verdade é sempre reconferida no servidor em cada rota de
  // door-items/floor-items/items/wall-items/avatar-*/**. ---
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => {
    if (!accountAccessToken) return;
    let cancelled = false;
    fetch("/api/admin/me", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && typeof data.isPlatformAdmin === "boolean") setIsPlatformAdmin(data.isPlatformAdmin);
      })
      .catch(() => {
        // sem Supabase configurado, ou rota fora do ar -- fica false mesmo, não é crítico
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // --- Editor de Itens (item custom do catálogo GLOBAL, ver
  // components/ItemEditor.tsx / supabase/migrations/0002_room_items.sql)
  // -- itemEditorOpen só abre pro admin da plataforma (isPlatformAdmin
  // acima), NÃO pro dono de sala (ver comentário de isPlatformAdmin).
  // customItemsVersion não guarda nada -- só existe pra FORÇAR o
  // EditPanel a re-renderizar depois de registerCustomFurnitureModels
  // mutar FURNITURE_CATALOG por baixo (React não percebe sozinho que um
  // array importado mudou de conteúdo). ---
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [customItemsVersion, setCustomItemsVersion] = useState(0);
  // mesma ideia de customItemsVersion acima, só que pra tom de pele
  // CUSTOM (Editor de Itens, botão "Criar Avatar" -- ver
  // fetchAndRegisterCustomSkins/registerCustomSkins).
  const [customSkinsVersion, setCustomSkinsVersion] = useState(0);
  // mesma ideia de customItemsVersion acima, só que pra PISO custom
  // (Editor de Itens, aba "Criar Piso" -- pedido do Douglas: "eu quero
  // uma aba so pra piso tambem... vai ter funcoes totalmente diferentes
  // dos mobis", ver fetchAndRegisterCustomFloor/registerCustomFloorModels).
  const [customFloorVersion, setCustomFloorVersion] = useState(0);
  // mesma ideia de customItemsVersion acima, só que pro PADRÃO de parede
  // de sistema custom (Editor de Itens, aba "Criar Parede" -- pedido do
  // Douglas: "a gente cria uma nova aba la no criar pra configurar os
  // padroes dela", ver fetchAndRegisterCustomWall/registerCustomWallModels
  // em game/wall.ts).
  const [customWallVersion, setCustomWallVersion] = useState(0);
  // mesma ideia de customItemsVersion acima, só que pra PORTA custom
  // (Editor de Itens, aba "Criar Porta" -- pedido do Douglas: "vamos
  // criar uma nova categoria 'porta'... eu subirei a arte", ver
  // fetchAndRegisterCustomDoor/registerCustomDoorModels em game/door.ts).
  const [customDoorVersion, setCustomDoorVersion] = useState(0);

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
          "id, label, category, art, display_width, icon_url, near_image_url, offset_x, offset_y, direction_offsets, direction_display_width, sittable, seat_offset_x, seat_offset_y, seat_direction_offsets, colors, footprint_cols, footprint_rows, footprint_by_direction, stackable, stack_surface_offset_y, extra_seats"
        );
      if (error || !data || data.length === 0) return;
      const models: FurnitureModelDef[] = data.map(
        (row: {
          id: string;
          label: string;
          category: string;
          art: Partial<Record<FurnitureFacing, string>>;
          display_width: number | null;
          icon_url: string | null;
          near_image_url: string | null;
          offset_x: number | null;
          offset_y: number | null;
          direction_offsets: Partial<Record<FurnitureFacing, { x: number; y: number }>> | null;
          direction_display_width: Partial<Record<FurnitureFacing, number>> | null;
          sittable: boolean | null;
          seat_offset_x: number | null;
          seat_offset_y: number | null;
          seat_direction_offsets: Partial<Record<FurnitureFacing, { x: number; y: number }>> | null;
          colors: { id: string; label: string; art: Partial<Record<FurnitureFacing, string>> }[] | null;
          footprint_cols: number | null;
          footprint_rows: number | null;
          footprint_by_direction: Partial<Record<"down" | "left" | "right" | "up", { dCol: number; dRow: number }[]>> | null;
          stackable: boolean | null;
          stack_surface_offset_y: number | null;
          extra_seats: { dCol: number; dRow: number; x: number; y: number }[] | null;
        }) => ({
          id: row.id,
          type: CUSTOM_ITEM_CATEGORY_TYPE[row.category as FurnitureCategoryId] ?? "poltrona",
          label: row.label,
          // "default" (a arte principal, coluna `art`) + as variantes
          // geradas pelo FurnitureColorZoneTool.tsx (pedido do Douglas:
          // "adiciona a edicao de cores nos mobis tambe") -- ver
          // supabase/migrations/0012_room_items_colors.sql. Sem isso, a
          // paleta "Cores" (entryWithColor/selectFurnitureColor acima)
          // sempre mostrava "Em breve" pra item custom, mesmo depois de
          // gerar uma cor nova -- só existia a entrada única "Padrão".
          colors: [{ id: "default", label: "Padrão", art: row.art }, ...(row.colors ?? [])],
          // ajustado à mão no preview do Editor de Itens (ver
          // ItemEditor.tsx) -- null pra item cadastrado antes dessa
          // opção existir, cai no fallback por categoria (ver
          // addFurnitureSprite, MainScene.ts).
          displayWidth: typeof row.display_width === "number" ? row.display_width : undefined,
          iconUrl: row.icon_url ?? undefined,
          // imagem "de perto" (pedido do Douglas: "por proximidade, a
          // um tile de distancia, o objeto muda") -- ver
          // FurnitureModelDef.nearImageUrl/furnitureNearTextureKey em
          // game/furniture.ts e updateFurnitureProximityState em
          // game/MainScene.ts.
          nearImageUrl: row.near_image_url ?? undefined,
          offsetX: row.offset_x ?? 0,
          offsetY: row.offset_y ?? 0,
          // "editar todos os lados" + "tem interação/posição sentado"
          // (pedido do Douglas) -- ver supabase/migrations/
          // 0007_room_items_direction_offsets_seat.sql.
          directionOffsets: row.direction_offsets ?? undefined,
          // tamanho por direção (ver supabase/migrations/
          // 0021_room_items_direction_display_width.sql e o comentário
          // grande em FurnitureModelDef.directionDisplayWidth) --
          // pedido do Douglas: "nao tem como isolar?" (o tamanho não
          // ficar preso reaproveitando o mesmo valor nas 4 vistas).
          directionDisplayWidth: row.direction_display_width ?? undefined,
          sittable: row.sittable ?? undefined,
          seatOffsetX: row.seat_offset_x ?? undefined,
          seatOffsetY: row.seat_offset_y ?? undefined,
          // ajuste do assento por direção (ver supabase/migrations/
          // 0011_room_items_seat_direction_offsets.sql e o comentário
          // grande em FurnitureModelDef.seatDirectionOffsets).
          seatDirectionOffsets: row.seat_direction_offsets ?? undefined,
          // footprint (pedido do Douglas: "tenho mobis que ocupam mais
          // tiles doq um ou dois, entao preciso selecionar pra que nao
          // se suba em um item") -- ver supabase/migrations/
          // 0013_room_items_footprint.sql e furnitureFootprintTiles/
          // blockingFurnitureAt em game/furniture.ts. null/1 = comporta-
          // mento de sempre (só a âncora).
          footprintCols: typeof row.footprint_cols === "number" ? row.footprint_cols : undefined,
          footprintRows: typeof row.footprint_rows === "number" ? row.footprint_rows : undefined,
          // footprint desenhado à mão, por direção (pedido do Douglas:
          // "quero selecionar os tiles que ele ocupa, CLICANDO... pra
          // CADA POSICAO") -- ver supabase/migrations/
          // 0023_room_items_footprint_by_direction.sql e o comentário
          // grande em FurnitureModelDef.footprintByDirection,
          // game/furniture.ts. null/undefined = nenhuma direção
          // customizada, cai no retângulo footprintCols/Rows acima.
          footprintByDirection: row.footprint_by_direction ?? undefined,
          // "Sobrepor" (pedido do Douglas: notebook em cima da mesa) --
          // ver supabase/migrations/0022_room_items_stack.sql e o
          // comentário grande em FurnitureModelDef.stackable/
          // stackSurfaceOffsetY, game/furniture.ts.
          stackable: row.stackable ?? undefined,
          stackSurfaceOffsetY: typeof row.stack_surface_offset_y === "number" ? row.stack_surface_offset_y : undefined,
          // assentos EXTRA (pedido do Douglas: "preciso... configurar dois
          // avatares no caso em que tenha mais de um assento") -- ver
          // supabase/migrations/0014_room_items_extra_seats.sql e o
          // comentário grande em FurnitureExtraSeat, game/furniture.ts.
          // [] (padrão)/null = só a âncora, comportamento de sempre.
          extraSeats: Array.isArray(row.extra_seats) ? row.extra_seats : undefined,
        })
      );
      const updatedIds = registerCustomFurnitureModels(models);
      setCustomItemsVersion((v) => v + 1);
      const textureEntries: { key: string; url: string }[] = [];
      for (const model of models) {
        // TODAS as cores do modelo (não só a "default") -- ver comentário
        // em `colors` acima (fetchAndRegisterCustomFurniture). Cada cor
        // tem sua PRÓPRIA chave de textura (furnitureVariantTextureKey
        // já inclui colorId), então sem esse loop as variantes geradas
        // pelo FurnitureColorZoneTool.tsx nunca chegavam a carregar --
        // o seletor "Cores" mudava o colorId escolhido, mas a peça
        // continuava mostrando a arte "Padrão" (textura da cor nova
        // nunca tinha sido registrada na cena).
        for (const color of model.colors) {
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
        // imagem "de perto" (pedido do Douglas: "por proximidade, a um
        // tile de distancia, o objeto muda") -- UMA textura só por
        // modelo, sem cor/direção (ver furnitureNearTextureKey,
        // game/furniture.ts), carregada do mesmo jeito que as variantes
        // de cor/direção acima.
        if (model.nearImageUrl) {
          const nearKey = furnitureNearTextureKey(model.id);
          if (updatedIds.includes(model.id)) sceneRef.current?.removeFurnitureTextures([nearKey]);
          textureEntries.push({ key: nearKey, url: model.nearImageUrl });
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
   * PISO customizado (Editor de Itens, aba "Criar Piso" -- pedido do
   * Douglas: "eu quero uma aba so pra piso tambem... vai ter funcoes
   * totalmente diferentes dos mobis", ver supabase/migrations/
   * 0015_room_floor_items.sql). Bem mais simples que móvel: sem cor/
   * direção/footprint/assento, é só uma imagem por modelo -- por isso
   * não tem o loop de cores+direções nem o texture-key por
   * facing/colorId, só UMA textura por entrada (floorTextureKey(id)).
   * Chamado nos mesmos lugares que fetchAndRegisterCustomFurniture (scene-
   * ready + onItemsChanged do ItemEditor).
   */
  async function fetchAndRegisterCustomFloor(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("room_floor_items")
        .select(
          "id, label, category, kind, file_url, plank_width_px, color_a, color_b, plank_length_px, line_color, colors, wood_grain, marble, tile_aligned"
        );
      if (error || !data || data.length === 0) return;
      const entries: FloorCatalogEntry[] = data.map(
        (row: {
          id: string;
          label: string;
          category: string;
          kind: string | null;
          file_url: string | null;
          plank_width_px: number | null;
          color_a: string | null;
          color_b: string | null;
          plank_length_px: number | null;
          line_color: string | null;
          colors: string[] | null;
          wood_grain: boolean | null;
          marble: boolean | null;
          tile_aligned: boolean | null;
        }) => ({
          id: row.id,
          category: row.category as FloorCatalogEntry["category"],
          label: row.label,
          file: row.file_url ?? "",
          // piso "padrão" (pedido do Douglas: "...forma de preenchimento
          // de linhas... nao precise ser imagem mesmo") -- ver
          // FloorPatternConfig em game/floor.ts. Cor em hex STRING no
          // banco ("#rrggbb", ver supabase/migrations/
          // 0016_room_floor_items_pattern.sql e
          // 0017_room_floor_items_plank.sql) -> número que o Phaser
          // entende (Graphics.fillStyle quer um hex NUMÉRICO, não string).
          // plank_length_px/line_color/colors (0017) são OPCIONAIS --
          // tábua emendada com linha de junta e/ou paleta de várias
          // cores, os mesmos recursos que antes só existiam hard-coded
          // (ver correção do Douglas: "eu nao defini as cores, so mandei
          // exemplo, quero criar eles el criar piso" -- agora ele cria
          // tudo pela aba "Criar Piso", com as cores que ele escolher).
          pattern:
            row.kind === "pattern" && row.plank_width_px && row.color_a && row.color_b
              ? {
                  plankWidthPx: row.plank_width_px,
                  colorA: parseInt(row.color_a.replace("#", ""), 16),
                  colorB: parseInt(row.color_b.replace("#", ""), 16),
                  plankLengthPx: row.plank_length_px ?? undefined,
                  lineColor: row.line_color ? parseInt(row.line_color.replace("#", ""), 16) : undefined,
                  colors: row.colors && row.colors.length > 0 ? row.colors.map((c) => parseInt(c.replace("#", ""), 16)) : undefined,
                  // efeito "laminado" (ver supabase/migrations/
                  // 0018_room_floor_items_wood_grain.sql e
                  // FloorPatternConfig.woodGrain em game/floor.ts).
                  woodGrain: row.wood_grain ?? undefined,
                  // efeito "marmorado" + emenda alinhada à grade (pedido
                  // do Douglas: "porcelanato... do tamanho do tile...
                  // com efeito de porcelanato marmorado", ver
                  // supabase/migrations/0019_room_floor_items_marble.sql
                  // e FloorPatternConfig.marble/tileAligned em
                  // game/floor.ts).
                  marble: row.marble ?? undefined,
                  tileAligned: row.tile_aligned ?? undefined,
                }
              : undefined,
        })
      );
      const updatedIds = registerCustomFloorModels(entries);
      setCustomFloorVersion((v) => v + 1);
      // piso "padrão" não tem textura NENHUMA pra carregar (é vetor puro,
      // ver createFloorPatternGraphics em MainScene.ts) -- só os de
      // imagem entram na fila do loader.
      const textureEntries: { key: string; url: string }[] = entries
        .filter((entry) => !entry.pattern)
        .map((entry) => ({
          key: floorTextureKey(entry.id),
          url: entry.file,
        }));
      // item que já existia e mudou (ver "Editar" na aba "Criar Piso") --
      // limpa a textura ANTIGA da cena antes de recarregar com essa MESMA
      // chave, mesmo motivo de removeFurnitureTextures em
      // fetchAndRegisterCustomFurniture acima.
      for (const id of updatedIds) sceneRef.current?.removeFurnitureTextures([floorTextureKey(id)]);
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomFurnitureTextures(textureEntries, resolve);
        else resolve();
      });
      // recria na hora a sprite de todo tile JÁ PINTADO que usa um estilo
      // que acabou de ser editado -- sem isso, piso editado só atualizaria
      // visualmente depois de um F5 (mesma ideia de refreshFurnitureModel).
      for (const id of updatedIds) sceneRef.current?.refreshFloorModel(id);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem piso custom, sala funciona igual
    }
  }

  /**
   * Mesmo esquema de fetchAndRegisterCustomFloor acima, só que pro
   * PADRÃO de parede de sistema custom (Editor de Itens, aba "Criar
   * Parede" -- pedido do Douglas: "a gente não consegue criar uma
   * geometria seguindo a mesma ideia de piso, algo criado aqui, sem que
   * seja feito fora?", depois "a gente cria uma nova aba la no criar pra
   * configurar os padroes dela", ver supabase/migrations/
   * 0024_room_wall_items.sql). Mais simples ainda que piso: só existe o
   * tipo "padrão" aqui (parede com ARTE continua vindo só da pasta local,
   * ver scripts/syncWallAssets.mjs) -- nenhuma textura pra carregar (é
   * vetor puro, ver createWallPatternGraphics em MainScene.ts), então não
   * tem o loop de removeFurnitureTextures/loadCustomFurnitureTextures que
   * fetchAndRegisterCustomFloor tem. Chamado nos mesmos lugares (scene-
   * ready + onItemsChanged do ItemEditor).
   */
  async function fetchAndRegisterCustomWall(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("room_wall_items")
        .select(
          "id, label, height_px, thickness_px, brick_width_px, brick_height_px, brick_color, mortar_color, mortar_width_px, top_color"
        );
      if (error || !data || data.length === 0) return;
      const entries: WallCatalogEntry[] = data.map(
        (row: {
          id: string;
          label: string;
          height_px: number;
          thickness_px: number;
          brick_width_px: number;
          brick_height_px: number;
          brick_color: string;
          mortar_color: string;
          mortar_width_px: number;
          top_color: string;
        }) => ({
          id: row.id,
          label: row.label,
          file: "",
          // cor em hex STRING no banco ("#rrggbb") -> número que o Phaser
          // entende (Graphics.fillStyle quer hex NUMÉRICO, não string) --
          // mesma conversão de fetchAndRegisterCustomFloor acima.
          pattern: {
            heightPx: row.height_px,
            thicknessPx: row.thickness_px,
            brickWidthPx: row.brick_width_px,
            brickHeightPx: row.brick_height_px,
            brickColor: parseInt(row.brick_color.replace("#", ""), 16),
            mortarColor: parseInt(row.mortar_color.replace("#", ""), 16),
            mortarWidthPx: row.mortar_width_px,
            topColor: parseInt(row.top_color.replace("#", ""), 16),
          },
        })
      );
      const updatedIds = registerCustomWallModels(entries);
      setCustomWallVersion((v) => v + 1);
      // recria na hora o desenho de todo segmento JÁ PINTADO que usa um
      // estilo que acabou de ser editado -- sem isso, parede editada só
      // atualizaria visualmente depois de um F5 (mesma ideia de
      // refreshFloorModel acima).
      for (const id of updatedIds) sceneRef.current?.refreshWallModel(id);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem parede custom, sala funciona igual
    }
  }

  /**
   * Mesmo esquema de fetchAndRegisterCustomFloor acima, só que pra PORTA
   * (Editor de Itens, aba "Criar Porta" -- pedido do Douglas: "vamos
   * criar uma nova categoria 'porta'... eu subirei a arte", ver
   * supabase/migrations/0030_room_door_items.sql). Mais parecido com
   * piso que com parede: porta é SEMPRE imagem (nunca "padrão" desenhado
   * por código, ver comentário no topo de game/door.ts), só que com até
   * 4 texturas por estilo (2 lados x 2 estados, ver doorTextureKey em
   * game/door.ts) em vez de 1 só -- por isso o loop de textureEntries
   * abaixo passa por CADA lado presente (`entry.art.left`/
   * `entry.art.right`, "right" é opcional -- ver comentário grande de
   * DoorCatalogEntry.art) x os 2 estados (aberta/fechada), em vez de uma
   * textura única por entrada. Chamado nos mesmos lugares que
   * fetchAndRegisterCustomFloor (scene-ready + onItemsChanged do
   * ItemEditor).
   */
  async function fetchAndRegisterCustomDoor(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("room_door_items")
        .select("id, label, kind, art_left_closed, art_left_open, art_right_closed, art_right_open, display_width_px");
      if (error || !data || data.length === 0) return;
      const entries: DoorCatalogEntry[] = data.map(
        (row: {
          id: string;
          label: string;
          kind: string;
          art_left_closed: string;
          art_left_open: string;
          art_right_closed: string | null;
          art_right_open: string | null;
          display_width_px: number | null;
        }) => ({
          id: row.id,
          label: row.label,
          kind: row.kind as DoorCatalogEntry["kind"],
          art: {
            left: { closed: row.art_left_closed, open: row.art_left_open },
            // lado direito é OPCIONAL (ver POST /api/door-items) -- só
            // entra no catálogo quando os 2 estados desse lado existem
            // (não faz sentido ter só "aberta" ou só "fechada" da
            // direita); sem ele, resolveDoorTextureKey (MainScene.ts)
            // cai pro lado esquerdo sozinho.
            ...(row.art_right_closed && row.art_right_open
              ? { right: { closed: row.art_right_closed, open: row.art_right_open } }
              : {}),
          },
          // "Tamanho no jogo" (ver DoorCatalogEntry.displayWidth em
          // game/door.ts) -- null (porta cadastrada antes desse campo
          // existir, ou nunca ajustada) vira undefined, mesmo fallback
          // de sempre (encaixa exatamente na aresta, ver addDoorSprite).
          displayWidth: typeof row.display_width_px === "number" ? row.display_width_px : undefined,
        })
      );
      const updatedIds = registerCustomDoorModels(entries);
      setCustomDoorVersion((v) => v + 1);
      const textureEntries: { key: string; url: string }[] = [];
      for (const entry of entries) {
        for (const facing of ["left", "right"] as const) {
          const artSet = entry.art[facing];
          if (!artSet) continue;
          textureEntries.push({ key: doorTextureKey(entry.id, facing, false), url: artSet.closed });
          textureEntries.push({ key: doorTextureKey(entry.id, facing, true), url: artSet.open });
        }
      }
      // item que já existia e mudou (ver "Editar" na aba "Criar Porta") --
      // limpa as 4 texturas possíveis ANTES de recarregar (mesmo motivo
      // de removeFurnitureTextures em fetchAndRegisterCustomFloor acima;
      // sem problema apagar uma chave que nunca existiu, ver comentário
      // de removeFurnitureTextures em MainScene.ts).
      for (const id of updatedIds) {
        sceneRef.current?.removeFurnitureTextures([
          doorTextureKey(id, "left", false),
          doorTextureKey(id, "left", true),
          doorTextureKey(id, "right", false),
          doorTextureKey(id, "right", true),
        ]);
      }
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomFurnitureTextures(textureEntries, resolve);
        else resolve();
      });
      // recria na hora a sprite de toda porta JÁ PINTADA que usa um
      // estilo que acabou de ser editado -- sem isso, porta editada só
      // atualizaria visualmente depois de um F5 (mesma ideia de
      // refreshFloorModel/refreshWallModel).
      for (const id of updatedIds) sceneRef.current?.refreshDoorModel(id);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem porta custom, sala funciona igual
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
      const { data, error } = await supabase
        .from("avatar_skins")
        .select("id, label, gender, sheet_url, hex, colors");
      if (error || !data || data.length === 0) return;
      type SkinRow = {
        id: string;
        label: string;
        gender: string;
        sheet_url: string;
        hex: string | null;
        // variantes de cor GERADAS pelo ColorZoneTool.tsx (Editor de
        // Itens > Criar Avatar > Avatar, botão "Gerar cor" -- pedido do
        // Douglas: "adicionar cores pra avatar tambem" / "edicao encima
        // do ja subido") -- ausente/null em quem ainda não rodou
        // supabase/migrations/0010_avatar_skins_colors.sql, ou em quem
        // nunca gerou nenhuma cor pro tom. Mesmo formato de ColorOption
        // (avatar_items.colors, ver fetchAndRegisterCustomAvatarItems).
        colors: ColorOption[] | null;
      };
      const rows = data as SkinRow[];
      const skins: SkinOption[] = rows.map((row) => ({
        id: row.id,
        label: row.label,
        file: row.sheet_url,
        gender: row.gender === "feminino" ? "feminino" : "masculino",
        hex: row.hex ?? undefined,
      }));
      // cada cor gerada é UM TOM A MAIS no catálogo (mesmo esquema de
      // "traje" em fetchAndRegisterCustomAvatarItems -- tom de pele já é
      // uma entrada FLAT, sem bySkin/nesting, então aqui é só um push a
      // mais) -- reaproveita a MESMA folha gerada (sheet_url = c.file) e
      // o sexo do tom pai, pra aparecer certo no seletor "Tom de pele"
      // (filtro por gender, ver SKIN_CATALOG.filter no ProfileCard).
      const colorSkins: SkinOption[] = [];
      for (const row of rows) {
        for (const c of row.colors ?? []) {
          colorSkins.push({
            id: c.id,
            label: `${row.label} -- ${c.label}`,
            file: c.file,
            gender: row.gender === "feminino" ? "feminino" : "masculino",
            hex: c.hex,
          });
        }
      }
      const allSkins = [...skins, ...colorSkins];
      registerCustomSkins(allSkins);
      setCustomSkinsVersion((v) => v + 1);
      const textureEntries = allSkins.map((skin) => ({ key: skinTextureKey(skin.id), url: skin.file }));
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomAvatarLayerTextures(textureEntries, resolve);
        else resolve();
      });
      // SKIN_CATALOG agora começa vazio (pedido do Douglas: "tira as
      // cabeças da pasta") -- a primeira chamada de setLocalSkinId (ver
      // init() no useEffect do Phaser.Game) pode ter rodado ANTES da
      // textura de verdade terminar de carregar aqui em cima, e nesse
      // caso o boneco ficou escondido (ver checagem em setLocalSkinId,
      // MainScene.ts). Chama de novo agora que a textura já existe, pra
      // reaparecer sem precisar de F5 -- reaplicar com o mesmo id de
      // sempre é inofensivo quando já estava tudo certo.
      sceneRef.current?.setLocalSkinId(selectedSkinId);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem tom custom, sala funciona igual
    }
  }

  /**
   * "Avatar Padrão" por sexo (ver avatar_default_reference,
   * supabase/migrations/0008_avatar_default_reference.sql) -- pedido do
   * Douglas: "sim, quero que apareça pro jogador agora" (antes só era
   * guia de alinhamento do Editor de Itens). Leitura pública (mesma
   * policy de avatar_skins/avatar_items), só metadados/URL -- não
   * precisa carregar textura nenhuma no Phaser (ainda só usado no
   * preview de "Editar meu personagem", ver ProfileCard, que é HTML/CSS
   * puro). Chamado uma vez quando a cena fica pronta, mesmo lugar de
   * fetchAndRegisterCustomSkins/fetchAndRegisterCustomAvatarItems.
   */
  async function fetchDefaultReferences(): Promise<void> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from("avatar_default_reference")
        .select("gender, head_sheet_url, body_sheet_url");
      if (error || !data) return;
      const next: Record<AvatarGender, { headUrl: string; bodyUrl: string } | null> = {
        masculino: null,
        feminino: null,
      };
      for (const row of data as { gender: string; head_sheet_url: string; body_sheet_url: string }[]) {
        if (row.gender === "masculino" || row.gender === "feminino") {
          next[row.gender] = { headUrl: row.head_sheet_url, bodyUrl: row.body_sheet_url };
        }
      }
      setDefaultReferences(next);
    } catch {
      // Supabase fora do ar/não configurado -- segue sem avatar padrão, sala funciona igual
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
        .select("id, category, gender, label, skin_ids, sheet_url, colors");
      if (error || !data || data.length === 0) return;

      type AvatarItemRow = {
        id: string;
        category: string;
        gender: string;
        label: string;
        skin_ids: string[] | null;
        sheet_url: string;
        // variantes de cor GERADAS pelo ColorZoneTool.tsx (Editor de
        // Itens, botão "Gerar cor") -- ausente/null em quem ainda não
        // rodou supabase/migrations/0009_avatar_items_colors.sql, ou em
        // quem nunca gerou nenhuma cor pro item.
        colors: ColorOption[] | null;
      };
      const rows = data as AvatarItemRow[];
      const textureEntries: { key: string; url: string }[] = [];

      const hairRows = rows.filter((r) => r.category === "cabelo");
      if (hairRows.length > 0) {
        // `gender` já vinha salvo na linha (cadastrado no Editor de
        // Itens) mas ficava sem uso aqui -- bug reportado pelo Douglas:
        // "cabelo e itens masculinos não vão pro feminino se não seta, e
        // estão indo" (o seletor mostrava TODO mundo pros dois sexos).
        const items: HairOption[] = hairRows.map((r) => ({
          id: r.id,
          label: r.label,
          file: r.sheet_url,
          gender: r.gender === "feminino" ? "feminino" : "masculino",
          colors: r.colors ?? undefined,
        }));
        registerCustomHair(items);
        for (const item of items) {
          textureEntries.push({ key: hairTextureKey(item.id), url: item.file });
          // cada cor gerada É UMA FOLHA PRÓPRIA (ver ColorZoneTool.tsx) --
          // precisa da sua própria textura registrada, igual ao item
          // "base": selecionar uma cor troca pro id DELA (ver
          // selectedHairColorId/setLocalHairId em GameRoom.tsx), não do
          // item pai.
          for (const c of item.colors ?? []) textureEntries.push({ key: hairTextureKey(c.id), url: c.file });
        }
      }

      const accessoryRows = rows.filter((r) => r.category === "acessorio");
      if (accessoryRows.length > 0) {
        const items: AccessoryOption[] = accessoryRows.map((r) => ({
          id: r.id,
          label: r.label,
          file: r.sheet_url,
          gender: r.gender === "feminino" ? "feminino" : "masculino",
          colors: r.colors ?? undefined,
        }));
        registerCustomAccessories(items);
        for (const item of items) {
          textureEntries.push({ key: accessoryTextureKey(item.id), url: item.file });
          for (const c of item.colors ?? []) textureEntries.push({ key: accessoryTextureKey(c.id), url: c.file });
        }
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
          colors: r.colors ?? undefined,
        }));
        // cada cor gerada (ColorZoneTool.tsx, botão "Gerar cor" -- pedido
        // do Douglas: "trajes eu edito tbm? adiciona") vira uma entrada
        // PRÓPRIA no catálogo, com o MESMO esquema de bySkin do traje
        // pai (reaproveitando a MESMA arte gerada -- 1 folha só -- pros
        // mesmos tons que o traje pai cobre, ver comentário de
        // OutfitOption.colors em game/customization.ts). É assim que
        // setLocalOutfitId/resolveOutfitSkinId acham a cor pelo id dela,
        // igual acham qualquer outro traje.
        const colorItems: OutfitOption[] = [];
        for (const item of items) {
          for (const c of item.colors ?? []) {
            colorItems.push({
              id: c.id,
              label: `${item.label} -- ${c.label}`,
              bySkin: Object.fromEntries(Object.keys(item.bySkin).map((skinId) => [skinId, c.file])),
            });
          }
        }
        registerCustomOutfits([...items, ...colorItems]);
        for (const item of items) {
          for (const skinId of Object.keys(item.bySkin)) {
            textureEntries.push({ key: outfitTextureKey(item.id, skinId), url: item.bySkin[skinId]! });
          }
        }
        for (const colorItem of colorItems) {
          for (const skinId of Object.keys(colorItem.bySkin)) {
            textureEntries.push({ key: outfitTextureKey(colorItem.id, skinId), url: colorItem.bySkin[skinId]! });
          }
        }
      }

      setCustomSkinsVersion((v) => v + 1);
      await new Promise<void>((resolve) => {
        if (sceneRef.current) sceneRef.current.loadCustomAvatarLayerTextures(textureEntries, resolve);
        else resolve();
      });
      // MESMA corrida de fetchAndRegisterCustomSkins acima (ver comentário
      // grande lá, perto de setLocalSkinId) -- só que essa reaplicação
      // tava faltando AQUI: a primeira chamada de setLocalHairId/
      // setLocalBeardId/setLocalAccessoryId/setLocalOutfitId (init() no
      // useEffect do Phaser.Game) roda antes da textura custom (cabelo/
      // acessório/barba/traje) terminar de chegar do Supabase, e sem
      // reaplicar depois, a camada fica escondida pro resto da sessão
      // (createAvatar só desenha camada com textura já carregada). Bug
      // reportado pelo Douglas: "editar traje e nao puxa as fotos" / "nem
      // editar avatar tb nao puxa" -- tom de pele (setLocalSkinId) já
      // tinha esse reforço, cabelo/traje/etc nunca tiveram. Reaplicar com
      // o mesmo id de sempre é inofensivo quando já estava tudo certo.
      sceneRef.current?.setLocalHairId(selectedHairColorId ?? selectedHairId);
      sceneRef.current?.setLocalBeardId(selectedBeardId);
      sceneRef.current?.setLocalAccessoryId(selectedAccessoryColorId ?? selectedAccessoryId);
      sceneRef.current?.setLocalOutfitId(selectedOutfitColorId ?? selectedOutfitId);
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

  // avisa a cena quem é o "CEO" (dono da sala, mesmo roomRole usado em
  // canEditRoom acima) toda vez que ele mudar -- roomRole só chega
  // (assíncrono, ver efeito logo acima) DEPOIS da cena já poder existir,
  // então não dá pra confiar só numa atribuição na hora de criar a cena
  // (ver scene.onForceReleaseArea mais abaixo); precisa desse efeito à
  // parte pra propagar uma atualização tardia também. Só decide se o
  // clique na mesa de outra pessoa oferece "destituir" (ver
  // updateAreaHoverLabels em MainScene.ts) -- a permissão de verdade é
  // sempre reconferida no servidor.
  useEffect(() => {
    sceneRef.current?.setRoomOwner(isCurrentRoomOwner);
  }, [isCurrentRoomOwner]);

  // contador de membro/visitante ONLINE -- reaproveita GET
  // /room/presence do servidor WebSocket (ver handleGetPresence em
  // server/index.js), que já sabe quem tá conectado AGORA; polling
  // simples (10s) em vez de mais um tipo de mensagem no protocolo do
  // WS só pra isso.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(roomApiPath(roomSlug, "/room/presence"));
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
  const [activeCategory, setActiveCategory] = useState<
    FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho"
  >("poltrona");
  const [selectedFloorToolId, setSelectedFloorToolId] = useState<string | "erase" | null>(null);
  const [draftFloorItems, setDraftFloorItems] = useState<FloorTileDef[]>([]);
  const [floorSaveStatus, setFloorSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // true só depois que a busca inicial do piso salvo (GET /room/floor,
  // ver game.events.once(READY, ...) mais abaixo) terminar -- ver o
  // useEffect de autosave logo depois, que confere essa flag antes de
  // mandar qualquer POST.
  const floorLoadedRef = useRef(false);

  // --- formato da sala (aba "Tamanho", ver selectRoomShapeTool em
  // MainScene.ts) -- pedido do Douglas: "eu quero adicionar mais piso
  // alem do limite que ja tem da sala, quero aumentar a sala" (formato
  // livre, tile por tile, não um retângulo esticável -- ver comentário
  // grande de roomShape em MainScene.ts). MESMO esquema piso/parede/
  // porta/área: fonte de verdade fica na cena (MainScene.roomShape),
  // React só espelha pra desenhar o painel/autosave.
  const [selectedRoomShapeToolId, setSelectedRoomShapeToolId] = useState<"add" | "erase" | null>(null);
  const [draftRoomShapeItems, setDraftRoomShapeItems] = useState<{ col: number; row: number }[]>([]);
  const [roomShapeSaveStatus, setRoomShapeSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const roomShapeLoadedRef = useRef(false);

  // --- parede de sistema do editor de espaço (aba "Parede" dentro da
  // seção "Mapa", ver game/wall.ts) -- MESMO esquema/nomes do piso
  // acima, só troca "Floor"/"floor" por "Wall"/"wall" e FloorTileDef por
  // WallSegmentDef (item = uma ARESTA pintada, não um tile inteiro).
  const [selectedWallToolId, setSelectedWallToolId] = useState<string | "erase" | null>(null);
  const [draftWallItems, setDraftWallItems] = useState<WallSegmentDef[]>([]);
  const [wallSaveStatus, setWallSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const wallLoadedRef = useRef(false);
  // "Borda" (de sempre, aresta entre 2 tiles) ou "Centro do tile" --
  // pedido do Douglas: "eu quero tambem a opcao de inserir ela no
  // centro do tile", que TRAVA passagem ao contrário da parede de
  // aresta ("no centro do tile, ela tem que bloquear o caminhar dai, no
  // canto nao bloqueia" -- ver isMovementBlockedAt em MainScene.ts).
  // Só um toggle de UI, não vai pro banco -- a decisão vira parte do
  // PRÓPRIO segmento salvo (WallSegmentDef.side === "center", ver
  // paintWallAt em MainScene.ts), então não precisa persistir a escolha
  // do toggle em si.
  const [wallPlacementMode, setWallPlacementModeState] = useState<"edge" | "center">("edge");
  // Orientação usada só dentro do modo "Centro do tile" (ver
  // setWallCenterOrientation em MainScene.ts) -- pedido posterior do
  // Douglas: "as paredes de centro de tile precisam poder nas duas
  // direcoes, so ta em uma". Mesma ideia de wallPlacementMode acima: só
  // um toggle de UI, a escolha vira parte do PRÓPRIO segmento salvo
  // (WallSegmentDef.side === "center"/"centerRow"), não precisa
  // persistir o toggle em si.
  const [wallCenterOrientation, setWallCenterOrientationState] = useState<"center" | "centerRow">("center");

  // --- porta do editor de espaço (aba "Porta" dentro da seção "Mapa",
  // ver game/door.ts -- pedido do Douglas: "vamos criar uma nova
  // categoria 'porta'... porque ela precisa abrir de diferentes
  // formas") -- MESMO esquema/nomes de parede acima (item = uma ARESTA
  // pintada), só que sem o modo "Centro do tile" (porta não tem essa
  // opção, ver DoorSide em game/door.ts) e com um campo A MAIS
  // (doorFacing): qual lado (esquerda/direita, ver DoorFacing) a
  // PRÓXIMA porta pintada vai usar -- escolhido ANTES de posicionar,
  // mesmo mecanismo de girar um móvel antes de colocar
  // (FURNITURE_ROTATE_ORDER/rotateSelected), ver toggleDoorFacing
  // abaixo.
  const [selectedDoorToolId, setSelectedDoorToolId] = useState<string | "erase" | null>(null);
  const [doorFacing, setDoorFacing] = useState<DoorFacing>(DOOR_FACING_ROTATE_ORDER[0]);
  const [draftDoorItems, setDraftDoorItems] = useState<DoorSegmentDef[]>([]);
  const [doorSaveStatus, setDoorSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const doorLoadedRef = useRef(false);

  // --- área do editor de espaço (aba "Área", ver game/areas.ts) --
  // primeiro cria a área na LISTA (nome + tipo, ver createArea), DEPOIS
  // seleciona ela pra pintar (selectedAreaToolId: id da ÁREA armada pra
  // pintura, não mais um tipo fixo -- ou "erase"/null).
  const [selectedAreaToolId, setSelectedAreaToolId] = useState<string | "erase" | null>(null);
  const [draftAreaDefs, setDraftAreaDefs] = useState<AreaDef[]>([]);
  // espelha draftAreaDefs pra poder ler o valor ATUAL de dentro de um
  // callback assíncrono (ver merge no GET /room/areas mais abaixo, bug
  // "as areas que eu crio nao tao salvando") -- mesmo padrão de
  // accountAccessTokenRef acima, sempre em dia (reatribuído todo render).
  const draftAreaDefsRef = useRef(draftAreaDefs);
  draftAreaDefsRef.current = draftAreaDefs;
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

  // Reposiciona o(s) balão(ões) de confirmação de área (ver comentário
  // grande de areaDestituirPrompt lá em cima) A CADA FRAME enquanto
  // algum estiver aberto -- a câmera do Phaser pode continuar se mexendo
  // (pan/zoom) com o balão na tela, então a posição em CSS precisa
  // acompanhar ao vivo, não só recalcular quando abre. useLayoutEffect
  // (não useEffect) + já chamando o cálculo uma vez SÍNCRONO antes do
  // primeiro requestAnimationFrame, pra nunca pintar o balão em (0,0)
  // por um frame ao abrir. Não passa por state/re-render (custo demais
  // em 60fps) -- escreve direto no .style.transform do próprio DIV via
  // ref. destituir e "Assumir essa mesa?" (areaClaimPrompt) nunca
  // acontecem na MESMA área ao mesmo tempo (uma exige dono, a outra
  // exige área livre), mas nada impede os dois estarem abertos pra
  // áreas DIFERENTES juntos -- por isso um laço só reposiciona os dois,
  // em vez de duplicar o efeito inteiro.
  useLayoutEffect(() => {
    if (!areaDestituirPrompt && !areaClaimPrompt && !areaOwnerHoverCard) return;
    let raf = 0;
    function positionBalloons() {
      const scene = sceneRef.current;
      const game = gameRef.current;
      const canvas = game?.canvas as HTMLCanvasElement | undefined;
      // o balão vive em .room-wrapper (irmão de .phaser-container, ver
      // JSX), não DENTRO de .phaser-container -- esse tem overflow:hidden
      // e cortaria o balão sempre que ele crescesse pra cima da borda do
      // canvas visível (exatamente o caso comum aqui: balão ancorado
      // ACIMA da mesa).
      const wrapper = containerRef.current?.parentElement as HTMLElement | null;
      if (scene && canvas && game && wrapper) {
        const canvasRect = canvas.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        // canvas pode estar em escala DIFERENTE da resolução interna do
        // jogo (Scale.ENVELOP, ver game/config.ts) -- por isso não dá pra
        // usar o ponto de worldToCameraPoint direto em pixel de CSS, tem
        // que escalar pela razão entre o tamanho REAL do canvas em tela
        // e o tamanho lógico (game.scale.width/height).
        const scaleX = canvasRect.width / game.scale.width;
        const scaleY = canvasRect.height / game.scale.height;
        const baseLeft = canvasRect.left - wrapperRect.left;
        const baseTop = canvasRect.top - wrapperRect.top;
        if (areaDestituirPrompt && areaDestituirBalloonRef.current) {
          const p = scene.worldToCameraPoint(areaDestituirPrompt.x, areaDestituirPrompt.y);
          areaDestituirBalloonRef.current.style.transform = `translate(${baseLeft + p.x * scaleX}px, ${
            baseTop + p.y * scaleY
          }px) translate(-50%, -100%)`;
        }
        if (areaClaimPrompt && areaClaimBalloonRef.current) {
          const p = scene.worldToCameraPoint(areaClaimPrompt.x, areaClaimPrompt.y);
          areaClaimBalloonRef.current.style.transform = `translate(${baseLeft + p.x * scaleX}px, ${
            baseTop + p.y * scaleY
          }px) translate(-50%, -100%)`;
        }
        if (areaOwnerHoverCard && areaOwnerHoverCardRef.current) {
          const p = scene.worldToCameraPoint(areaOwnerHoverCard.x, areaOwnerHoverCard.y);
          areaOwnerHoverCardRef.current.style.transform = `translate(${baseLeft + p.x * scaleX}px, ${
            baseTop + p.y * scaleY
          }px) translate(-50%, -100%)`;
        }
      }
      raf = requestAnimationFrame(positionBalloons);
    }
    positionBalloons();
    return () => cancelAnimationFrame(raf);
  }, [areaDestituirPrompt, areaClaimPrompt, areaOwnerHoverCard]);

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
  // "Avatar Padrão" (ver avatar_default_reference, cadastrado no Editor
  // de Itens > aba "Avatar Padrão") -- pedido do Douglas: "sim, quero
  // que apareça pro jogador agora" (antes só era guia de alinhamento
  // interno do editor, nunca aparecia aqui). Usado como FALLBACK do
  // boneco em "Editar meu personagem" (ver ProfileCard) quando
  // SKIN_CATALOG não tem nenhum tom cadastrado pro sexo escolhido --
  // SKIN_CATALOG agora começa vazio (tom "de fábrica" saiu, ver
  // customization.ts), só ganha conteúdo quando o Douglas sobe algo em
  // "Tons cadastrados". Buscado uma vez quando a cena fica pronta (ver
  // fetchDefaultReferences abaixo).
  const [defaultReferences, setDefaultReferences] = useState<
    Record<AvatarGender, { headUrl: string; bodyUrl: string } | null>
  >({ masculino: null, feminino: null });
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
  // cor escolhida DENTRO do traje atual -- mesmo esquema de
  // selectedHairColorId acima (pedido do Douglas: "trajes eu edito
  // tbm? adiciona", depois do Gerador de cor já funcionar pra cabelo/
  // acessório). Reseta pra null ao trocar de TRAJE (ver selectOutfit).
  const [selectedOutfitColorId, setSelectedOutfitColorId] = useState<string | null>(
    () => loadSavedAvatar().outfitColorId ?? null
  );
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
    // ACHADO investigando "eu atualizo e na primeira aparece assim,
    // atualizo de novo e fica certo" (Douglas, sala com mais de uma
    // pessoa/aba aberta): a MESMA corrida que já foi corrigida pro
    // jogador LOCAL (ver "ACHADO investigando o quadrado de erro" mais
    // abaixo, em runWhenSceneReady) nunca foi coberta pros jogadores
    // REMOTOS. O WebSocket conecta e já começa a receber mensagens
    // (handlePartyMessage) assim que o socket abre -- em paralelo com o
    // Phaser subindo, sem esperar scene.sceneReady nenhum. Como o
    // servidor de tempo real é local (bem mais rápido que o Loader do
    // Phaser terminando preload()+create()), a mensagem "init" (lista de
    // quem já tá na sala) quase sempre chegava ANTES da cena terminar de
    // carregar o catálogo -- upsertRemotePlayer (MainScene.ts) cria o
    // boneco na hora (createAvatar), usando texturas de cabelo/base/
    // traje/barba que ainda podem nem existir nesse instante, e o Phaser
    // desenha o quadriculado de "textura faltando" no lugar. Pior: como o
    // container do jogador remoto já foi criado (mesmo quebrado), a
    // PRÓXIMA mensagem pra ele (ex: "move") só atualiza posição -- nunca
    // recria o boneco -- então ele fica quebrado o resto da sessão, só
    // corrigindo num F5 que, por sorte, perca essa corrida. Fix: enfileira
    // toda mensagem que chegar antes de scene.sceneReady, e processa a
    // fila inteira (na ordem) assim que a cena avisar que tá pronta (ver
    // flush logo no fim de runWhenSceneReady, abaixo).
    const pendingPartyMessages: unknown[] = [];

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
      // dist ARREDONDADA (não crua) -- é só o que a UI mostra/usa (ver
      // RemoteVideoTile), então um passo de 1px de diferença não deveria
      // contar como "mudou de verdade" (ver comparação com
      // lastRemoteMetaRef logo abaixo).
      let changed = Object.keys(lastRemoteMetaRef.current).length !== remotePlayersRef.current.size;

      remotePlayersRef.current.forEach((p, id) => {
        const dist = Math.hypot(p.x - lx, p.y - ly);
        const roundedDist = Math.round(dist);
        metaUpdate[id] = { name: p.name, distance: roundedDist };
        const prev = lastRemoteMetaRef.current[id];
        if (!prev || prev.name !== p.name || prev.distance !== roundedDist) changed = true;

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

      // pedido de performance (Douglas: "abri uma guia anônima e loguei
      // em outro lá ficou BEM travado", depois "rodei de novo e tá
      // lento ainda, o caminhar todo") -- checkProximity roda a cada
      // "move" recebido de CADA jogador remoto (até 20x/s por pessoa,
      // ver reportPosition em MainScene.ts). Só chama o setState
      // quando algo realmente mudou (nome ou distância arredondada) --
      // e o setState em si NÃO mexe mais em estado do GameRoom (ver
      // remoteMetaSetterRef/RemoteVideosLayer): quem "escuta" aqui é um
      // componente FILHO isolado, que só re-renderiza a listinha de
      // vídeos, nunca a árvore inteira do GameRoom (chat, editor,
      // criador de avatar...) -- é isso que resolvia de verdade o
      // travamento andando perto de alguém, não só cortar updates
      // redundantes.
      if (changed) {
        lastRemoteMetaRef.current = metaUpdate;
        remoteMetaSetterRef.current?.(metaUpdate);
      }
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
          // dCol/dRow (ver comentário grande em RemotePlayer acima) pra
          // já sentar no assento CERTO de um item com mais de um lugar.
          if (p.seatFurnitureId) scene?.setRemoteSeat(p.id, p.seatFurnitureId, p.name, p.seatDCol, p.seatDRow);
          // aparência de verdade (cabelo/tom de pele/barba/acessório/
          // traje) de quem já tava na sala ANTES de mim -- se ele já
          // mandou o "look" dele antes de eu entrar (ver protocolo em
          // server/index.js), já chega pronto aqui no "init", sem
          // precisar esperar ele trocar de roupa de novo pra eu ver
          // certo (ver comentário grande em RemotePlayer/setRemoteLook).
          scene?.setRemoteLook(p.id, pickLook(p));
        }
        setRemoteProfiles((prev) => ({ ...prev, ...nextProfiles }));

        // posse de mesa privada já existente antes de eu entrar (ver
        // roomStore.getAreaOwners/areaOwnerWireEntry em server/index.js)
        // -- sem isso, quem chega depois nunca saberia quem já é dono de
        // qual mesa. playerId pode vir null agora (dono offline, mas a
        // mesa continua dele -- pedido do Douglas: "ela e sua, ate
        // apagarem o espaco"), name nesse caso continua vindo preenchido.
        const owners = (data.areaOwners as { areaId: string; playerId: string | null; name: string }[]) ?? [];
        for (const o of owners) {
          const playerId = o.playerId === data.selfId ? "local" : o.playerId;
          scene?.setAreaOwner(o.areaId, playerId, o.name);
        }
        // pedido do Douglas, 30/set (20): "esse balao [Assumir essa
        // mesa?] ainda aparece quando eu dou spawn na sala, mesmo eu
        // ja tendo mesa assumida" -- ver comentário grande de
        // areaOwnersSynced em MainScene.ts. Só DEPOIS que o for acima
        // já aplicou toda posse (inclusive a minha própria, ver
        // "local" acima) é que faz sentido o balão de "Assumir essa
        // mesa?" confiar no que updateAreaDim vê em areaOwnerByAreaId.
        scene?.markAreaOwnersSynced();

        // status de cada jogador (parado/ocupado/etc, ver "profile" abaixo)
        // já vindo no "init" -- sem isso, updateDoorOpenState (MainScene.ts)
        // só saberia o status do dono de uma mesa privada depois que ele
        // mudasse de status DE NOVO já com todo mundo conectado.
        for (const p of players) {
          if (p.status) scene?.setPlayerStatus(p.id === data.selfId ? "local" : p.id, p.status);
        }

        // portas travadas manualmente ANTES de eu entrar (ver roomDoorLocks
        // em server/index.js) -- mesmo motivo de "posse de mesa privada"
        // logo acima: sem isso quem chega depois nunca saberia quais portas
        // já estão travadas.
        const doorLocks = (data.doorLocks as { col: number; row: number; side: DoorSide }[]) ?? [];
        for (const l of doorLocks) {
          scene?.setDoorLock(l.col, l.row, l.side, true);
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
        // mesma ideia do profile logo acima, só que pra aparência (ver
        // AVATAR_STORAGE_KEY/loadSavedAvatar lá no topo do arquivo) --
        // o servidor sempre me dá o boneco PADRÃO nesse primeiro momento
        // (ver player em server/index.js), então mando a MINHA aparência
        // de verdade (já lida do localStorage no useState inicial de
        // selectedHairId/etc.) assim que a conexão abre, pra sala
        // inteira já me ver certo -- sem isso, só quem entrasse na sala
        // DEPOIS de eu editar o traje no editor (ver saveEditingCharacter
        // mais abaixo, mesmo esquema) me veria com a roupa certa.
        sendLookUpdate({
          hairId: selectedHairColorId ?? selectedHairId,
          skinId: selectedSkinId,
          beardId: selectedBeardId,
          accessoryId: selectedAccessoryColorId ?? selectedAccessoryId,
          outfitId: selectedOutfitColorId ?? selectedOutfitId,
        });
      } else if (data.type === "join") {
        const p: RemotePlayer = data.player;
        remotePlayersRef.current.set(p.id, p);
        setRemoteProfiles((prev) => ({ ...prev, [p.id]: pickRemoteProfile(p) }));
        scene?.upsertRemotePlayer(p.id, p.x, p.y, p.color, p.name, statusColorFor(p.status));
        if (p.seatFurnitureId) scene?.setRemoteSeat(p.id, p.seatFurnitureId, p.name, p.seatDCol, p.seatDRow);
        // quem tá chegando ainda não mandou o "look" dele (só manda
        // DEPOIS do próprio "init", ver comentário grande acima) --
        // normalmente esse pickLook(p) não faz nada ainda (undefined em
        // tudo), mas cobre a corrida rara em que os dois já vieram
        // juntos, e deixa o boneco no padrão certinho até a mensagem
        // "look" de verdade chegar logo em seguida.
        scene?.setRemoteLook(p.id, pickLook(p));
      } else if (data.type === "seat") {
        // ver protocolo "seat" em server/index.js -- outra pessoa sentou
        // ou levantou (furnitureId null); só pose-sync, não mexe em posse
        // de mesa privada (ver "area-owner" abaixo pra isso). dCol/dRow:
        // qual assento desse item (ver comentário grande em RemotePlayer).
        const existing = remotePlayersRef.current.get(data.id);
        if (existing) {
          existing.seatFurnitureId = data.furnitureId;
          existing.seatDCol = data.dCol;
          existing.seatDRow = data.dRow;
        }
        scene?.setRemoteSeat(data.id, data.furnitureId, existing?.name ?? "?", data.dCol, data.dRow);
      } else if (data.type === "area-owner") {
        // ver protocolo "claim-area"/"release-area"/"area-owner" em
        // server/index.js -- alguém tomou posse de uma mesa privada, OU
        // ela voltou a ficar sem dono de verdade (playerId/name null,
        // release/destituir/área apagada), OU o dono continua o mesmo
        // mas ficou online/offline agora (playerId null COM name
        // preenchido = offline, mesa continua dele -- pedido do Douglas:
        // "ela e sua, ate apagarem o espaco", ver
        // broadcastAreaOwnershipFor no servidor).
        const playerId = data.playerId === selfIdRef.current ? "local" : data.playerId;
        scene?.setAreaOwner(data.areaId, playerId, data.name ?? null);
      } else if (data.type === "claim-area-denied") {
        // ver protocolo "claim-area"/"claim-area-denied" em
        // server/index.js -- pedido do Douglas: "uma pessoa só pode
        // assumir uma mesa por espaço". A cena já evita mandar
        // "claim-area" nesse caso (ver localOwnsAnyArea em MainScene.ts),
        // isso aqui só cobre a corrida rara (dois cliques quase juntos,
        // ou estado do cliente momentaneamente desatualizado) em que o
        // pedido chegou a sair mesmo assim.
        showErrorToast("Você já tem uma mesa nessa sala -- solte ela antes de assumir outra.");
      } else if (data.type === "door-lock") {
        // ver protocolo "lock-door"/"unlock-door" em server/index.js --
        // servidor é quem decide de verdade (mesmo motivo de "area-owner"
        // acima), nunca aplicado otimista (ver onLockDoor/onUnlockDoor
        // acima -- só manda o pedido, espera esse broadcast confirmado).
        scene?.setDoorLock(data.col, data.row, data.side, data.locked);
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
        // status (parado/ocupado/foco/etc) muda o comportamento da porta
        // que guarda a mesa privada dele (ver updateDoorOpenState em
        // MainScene.ts: dono com status "focus" força a porta fechada) --
        // "local" quando sou eu mesmo, mesma convenção de "area-owner"
        // acima (setAreaOwner) e do "init" logo mais acima.
        if (typeof data.status === "string") {
          scene?.setPlayerStatus(data.id === selfIdRef.current ? "local" : data.id, data.status);
        }
      } else if (data.type === "look") {
        // aparência de verdade de alguém (cabelo/tom de pele/barba/
        // acessório/traje) trocou ou chegou pela primeira vez -- ver
        // protocolo "look" em server/index.js e comentário grande em
        // RemotePlayer/setRemoteLook (MainScene.ts). Mesmo esquema de
        // "profile" logo acima.
        const existingForLook = remotePlayersRef.current.get(data.id);
        if (existingForLook) Object.assign(existingForLook, data);
        scene?.setRemoteLook(data.id, pickLook(data));
      } else if (data.type === "poke") {
        const text =
          data.kind === "available"
            ? `${data.fromName} perguntou se você tá disponível`
            : data.kind === "call"
              ? `${data.fromName} te chamou pra ir até lá`
              : data.kind === "note"
                ? `${data.fromName} deixou um recado: "${typeof data.text === "string" ? data.text : ""}"`
                : `${data.fromName} quer falar com você no chat`;
        const toastId = `${Date.now()}-${Math.random()}`;
        setToasts((prev) => [...prev.slice(-3), { id: toastId, text }]);
        // recado tem mais texto pra ler que os outros pokes -- fica um
        // pouco mais de tempo na tela (7s em vez de 4.5s) antes de sumir
        // sozinho (nenhum poke fica salvo em lugar nenhum, ver comentário
        // grande do protocolo "poke" em server/index.js).
        const dismissAfter = data.kind === "note" ? 7000 : 4500;
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), dismissAfter);
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
        // chamada de conversa (direta/grupo) migrou pro socket da
        // PLATAFORMA (ver usePlatformChat.ts) -- esse socket da sala só
        // sinaliza proximidade (handleSignal) agora.
        handleSignal(data.from, data.data);
      } else if (data.type === "chat:room_history") {
        // "semente" do histórico da Sala pra essa conexão (pedido do
        // Douglas, 1/out: "histórico persistido por conversa ... chat
        // da Sala ... tem que salvar!!!") -- mandada uma vez só logo
        // depois de "identify" (ver comentário grande em server/
        // index.js); daí em diante os "chat"/"chat:pins"/"chat:reaction"
        // ao vivo (abaixo) já mantêm o chatLog/roomPins sozinhos, sem
        // precisar pedir de novo.
        setChatLog((data.messages as ChatMessage[]) ?? []);
        setRoomPins((data.pins as ChatPin[]) ?? []);
      } else if (data.type === "chat") {
        const msg = data.message as ChatMessage;
        // defesa: se por algum motivo "message" não vier junto (payload
        // malformado, versão antiga do servidor etc.), NÃO empurra
        // undefined pro log -- isso derrubava a tela inteira (ver
        // ChatMessageRow, que lê msg.senderId sem checar) em vez de só
        // ignorar essa mensagem quebrada.
        if (msg && typeof msg === "object") setChatLog((prev) => [...prev.slice(-199), msg]);
      } else if (data.type === "chat_room_deleted") {
        // "apagar mensagem" na Sala (ver deleteRoomMessage) -- não tem
        // histórico salvo (ver comentário grande no topo), então isso só
        // tarja a mensagem no log local de quem tá com a sala aberta
        // AGORA, igual o broadcast original já era só pra quem tava
        // conectado na hora.
        const messageId = data.messageId as string;
        setChatLog((prev) => prev.map((m) => (m.id === messageId ? { ...m, deleted: true, text: "", attachment: null } : m)));
      } else if (data.type === "chat:reaction") {
        // reação com emoji na Sala (pedido do Douglas, 1/out) --
        // "reactions" já vem PRONTO (substitui, não mescla, ver
        // comentário grande em server/index.js). Conversa de verdade
        // (direta/grupo) migrou pro socket da PLATAFORMA -- ver
        // usePlatformChat.ts, que tem o MESMO case pro lado dela.
        const { conversationId, messageId, reactions } = data as {
          conversationId: string | null;
          messageId: string;
          reactions: ChatReactions;
        };
        if (conversationId === null) {
          setChatLog((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
        }
      } else if (data.type === "chat:pins") {
        // "mensagem fixada" na Sala (pedido do Douglas, 1/out) -- "pins"
        // já vem a LISTA INTEIRA atualizada. Conversa de verdade migrou
        // pro socket da plataforma (ver comentário acima).
        const { conversationId, pins } = data as { conversationId: string | null; pins: ChatPin[] };
        if (conversationId === null) setRoomPins(pins);
      } else if (data.type === "chat:typing") {
        // "fulano está digitando..." na Sala (pedido do Douglas, 1/out)
        // -- efêmero, nunca persiste. Conversa de verdade migrou pro
        // socket da plataforma (ver comentário acima).
        const { conversationId, userId, name } = data as { conversationId: string | null; userId: string; name: string };
        if (conversationId === null && userId !== myUserId) {
          const entry: ChatTypingEntry = { userId, name, ts: Date.now() };
          setRoomTyping((prev) => [...prev.filter((t) => t.userId !== userId), entry]);
        }
      }
    }

    // Pede câmera/microfone SEM travar o resto: a sala e o multiplayer sobem
    // imediatamente (abaixo), e o vídeo local entra assim que (e se) o
    // navegador liberar a permissão — mesmo que a pessoa demore ou nunca
    // responda ao aviso.
    async function requestMedia() {
      // dispositivo/mudo já escolhido no LOBBY (ver lib/mediaPrefs.ts,
      // pedido do Douglas: "cade o restante, configuracoes, audio,
      // video, tela") -- pede JÁ com esse aparelho; se ele não existir
      // mais (desconectou o headset entre o Lobby e agora), cai pro
      // padrão do navegador em vez de falhar tudo (getUserMedia com
      // deviceId inválido dá OverconstrainedError na constraint INTEIRA,
      // não só nessa track).
      const micDeviceId = getStoredMicDeviceId();
      const camDeviceId = getStoredCamDeviceId();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: camDeviceId ? { deviceId: { exact: camDeviceId } } : true,
          audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
          console.warn("Sem acesso a câmera/microfone — seguindo só com posição/chat.", e);
          return;
        }
      }
      if (destroyed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // mudo/câmera desligada escolhidos no Lobby também valem aqui --
      // sem isso, mutar lá e entrar destravaria o mic sozinho (o
      // getUserMedia sempre devolve a track LIGADA, ver toggleMic).
      const wantMicOn = getStoredMicOn();
      const wantCamOn = getStoredCamOn();
      stream.getAudioTracks().forEach((t) => (t.enabled = wantMicOn));
      stream.getVideoTracks().forEach((t) => (t.enabled = wantCamOn));
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      if (stream.getAudioTracks()[0]?.getSettings().deviceId) {
        setSelectedMicId(stream.getAudioTracks()[0].getSettings().deviceId as string);
      }
      if (stream.getVideoTracks()[0]?.getSettings().deviceId) {
        setSelectedCamId(stream.getVideoTracks()[0].getSettings().deviceId as string);
      }

      // se algum peer já tinha conectado por proximidade antes da câmera
      // liberar, adiciona as tracks agora nas conexões já abertas.
      peersRef.current.forEach((pc) => {
        stream.getTracks().forEach((track) => {
          const alreadyAdded = pc.getSenders().some((s) => s.track === track);
          if (!alreadyAdded) pc.addTrack(track, stream);
        });
      });
    }

    function init() {
      if (!containerRef.current || destroyed) return;

      const config = createGameConfig(containerRef.current);
      const game = new Phaser.Game(config);
      gameRef.current = game;

      game.events.once(Phaser.Core.Events.READY, () => {
        const scene = game.scene.getScene("main") as MainScene;
        sceneRef.current = scene;

        // ACHADO investigando o "quadrado de erro"/item sumido que o
        // Douglas reportou ("oq e esse quadrado de erro embaixo?" /
        // "continua la", mesmo depois de uma correção anterior que só
        // escondia o sintoma -- ver addFloorSprite/addFurnitureSprite em
        // MainScene.ts): Phaser.Core.Events.READY é do JOGO, não da CENA
        // -- conferindo o código-fonte do Phaser (node_modules/phaser/src/
        // core/Game.js, texturesReady()), esse evento dispara ANTES até
        // do game LOOP começar a rodar (this.start() só é chamado DEPOIS
        // de emitir "ready"), ou seja, ANTES da cena "main" começar o
        // preload() dela -- que é quem carrega TODO o catálogo de
        // piso/mobília de fábrica. Só que esse bloco inteiro (aparência
        // salva + as buscas de piso/mobília/área salvos, GET /room/*)
        // rodava direto AQUI, no "ready" do jogo -- disparando as buscas
        // ANTES do catálogo terminar de carregar. Como o servidor de
        // tempo real é local (bem mais rápido que o Loader do Phaser
        // buscando/decodificando as imagens), essas buscas quase sempre
        // respondiam primeiro, e loadSavedFloor/loadSavedFurniture
        // desenhavam com textura de catálogo ainda faltando -- por isso o
        // bug acontecia TODA vez que a página carregava, não só às vezes.
        //
        // Fix: espera scene.sceneReady (ver comentário grande nele/no fim
        // de create(), MainScene.ts) -- só vira true na ÚLTIMA linha de
        // create(), que o Phaser garante rodar depois do Loader terminar
        // 100%. runWhenSceneReady roda na hora se já tiver passado
        // (raça teórica: create() terminar ANTES desse callback do
        // "ready" do jogo rodar), senão espera o evento "scene-ready" que
        // create() emite -- funciona nas duas ordens possíveis.
        const runWhenSceneReady = () => {
          // nome/status do card de perfil (ver useEffect logo abaixo, que
        // cobre trocas DEPOIS que a cena já tá pronta) -- aqui só o
        // valor inicial, pra não esperar o próximo render pra aparecer.
        scene.setLocalProfile(
          myProfileRef.current.name || "Você",
          statusColorFor(myProfileRef.current.status)
        );
        // idem (ver comentário grande de isCurrentRoomOwnerRef acima) --
        // valor inicial na hora, o useEffect logo abaixo (dependência
        // [isCurrentRoomOwner]) cobre qualquer troca DEPOIS que a cena já
        // tá pronta.
        scene.setRoomOwner(isCurrentRoomOwnerRef.current);
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
        scene.setLocalOutfitId(selectedOutfitColorId ?? selectedOutfitId);
        scene.onLocalMove = (x, y) => {
          socketRef.current?.send(JSON.stringify({ type: "move", x, y }));
          checkProximity();
        };
        // senta/levanta (só pose-sync, ver protocolo "seat" em
        // server/index.js -- não mexe mais em posse de mesa privada) --
        // muda bem menos vezes que a posição, então manda direto, sem
        // passar pelo mesmo throttle de reportPosition do onLocalMove.
        scene.onLocalSeatChange = (furnitureId, dCol, dRow) => {
          socketRef.current?.send(JSON.stringify({ type: "seat", furnitureId, dCol, dRow }));
        };
        // botão "Assumir mesa" (ex-"Tomar posse") numa mesa privada (ver
        // protocolo "claim-area" em server/index.js) -- servidor é quem
        // decide de verdade (primeiro a clicar ganha); não atualiza nada
        // aqui na hora, espera o broadcast "area-owner" voltar (ver
        // handlePartyMessage acima), pra nunca dessincronizar se duas
        // pessoas clicarem quase ao mesmo tempo. Clicar na PRÓPRIA mesa
        // não solta mais nada (pedido do Douglas: "a mesa só solta quando
        // apago o espaco dela", ver comentário grande de
        // areaOwnerByAreaId em MainScene.ts) -- "release-area" continua
        // existindo no protocolo do servidor, só não tem mais nenhum
        // caminho no cliente que o dispare.
        scene.onClaimArea = (areaId) => {
          // TEMP debug -- ver comentário em "area-owner"/"claim-area-denied" acima.
          socketRef.current?.send(JSON.stringify({ type: "claim-area", areaId }));
        };
        // "destituir mesa de fulano" -- só o CEO (ver scene.setRoomOwner
        // logo abaixo) consegue de fato disparar isso na tela (o clique
        // nem chama onForceReleaseArea se não for CEO, ver
        // updateAreaHoverLabels em MainScene.ts), mas quem decide de
        // VERDADE é sempre o servidor (protocolo "force-release-area" em
        // server/index.js, que reconfere o papel de quem mandou antes de
        // aceitar).
        scene.onForceReleaseArea = (areaId) => {
          socketRef.current?.send(JSON.stringify({ type: "force-release-area", areaId }));
        };
        scene.onDraftChange = (items) => setDraftItems(items);
        scene.onDraftFloorChange = (items) => setDraftFloorItems(items);
        scene.onDraftRoomShapeChange = (items) => setDraftRoomShapeItems(items);
        // aviso quando um clique em "Apagar" (aba "Tamanho") é bloqueado
        // (ver eraseRoomShapeAt em MainScene.ts -- tile com conteúdo,
        // alguém em pé nele, isolaria um pedaço da sala, ou é o último
        // tile restante) -- window.alert é o mesmo recurso simples já
        // usado noutro lugar do editor pra avisos bloqueantes assim.
        scene.onRoomShapeEraseBlocked = (reason) => window.alert(reason);
        scene.onDraftWallChange = (items) => setDraftWallItems(items);
        scene.onDraftDoorChange = (items) => setDraftDoorItems(items);
        // Clique numa porta cuja área guardada é do jogador local (ver
        // handleRoomPointerDown em MainScene.ts) -- servidor é quem decide
        // de verdade (mesmo motivo de onClaimArea acima: nunca aplica
        // otimista, só reage ao broadcast "door-lock" confirmado, ver
        // handlePartyMessage abaixo e setDoorLock).
        scene.onLockDoor = (col, row, side) => {
          socketRef.current?.send(JSON.stringify({ type: "lock-door", col, row, side }));
        };
        scene.onUnlockDoor = (col, row, side) => {
          socketRef.current?.send(JSON.stringify({ type: "unlock-door", col, row, side }));
        };
        scene.onDraftAreaChange = (items) => setDraftAreaItems(items);
        // balão "destituir mesa de fulano?" (ver comentário grande de
        // areaDestituirPrompt acima) -- a cena só avisa QUEM/ONDE (null =
        // fechar), quem desenha o balão de verdade é este componente, em
        // DOM/CSS.
        scene.onAreaDestituirPromptChange = (info) => setAreaDestituirPrompt(info);
        // balão "Assumir essa mesa?" (ver comentário grande de
        // areaClaimPrompt acima) -- mesmo padrão exato do destituir logo
        // acima.
        scene.onAreaClaimPromptChange = (info) => setAreaClaimPrompt(info);
        // card "quem é o dono dessa mesa" ao passar o mouse (ver
        // comentário grande de areaOwnerHoverCard acima) -- info !== null
        // cancela qualquer "esconder" pendente (troca de mesa/reentrada
        // rápida), null AGENDA o esconder em vez de fechar na hora (dá
        // tempo do mouse "atravessar" pro card de verdade sem piscar,
        // ver scheduleHideAreaOwnerHoverCard).
        scene.onAreaOwnerHoverCardChange = (info) => {
          if (info) {
            cancelHideAreaOwnerHoverCard();
            setAreaOwnerHoverCard(info);
          } else {
            scheduleHideAreaOwnerHoverCard();
          }
        };
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
        // formato salvo da sala (ver GET /room/shape em server/index.js)
        // -- pedido do Douglas: "eu quero adicionar mais piso alem do
        // limite que ja tem da sala, quero aumentar a sala". Busca em
        // PARALELO com o resto (não bloqueia piso/mobília/área) --
        // MainScene já nasce com um retângulo padrão em roomShape (ver
        // create()), então ninguém fica travado sem conseguir andar
        // enquanto essa busca não responde. roomShapeLoadedRef só vira
        // true DEPOIS da tentativa (sucesso ou falha), mesmo padrão de
        // floorLoadedRef -- o autosave logo abaixo confere essa flag
        // antes de mandar qualquer POST, senão o primeiro render
        // (draftRoomShapeItems ainda vazio) salvaria um formato vazio
        // por cima do que já tava salvo antes mesmo da busca responder.
        // ver comentário grande de roomAssetsReady lá em cima -- só
        // esconde a RoomLoadingScreen quando as 6 buscas abaixo (shape/
        // furniture/floor/wall/door/area) já tiverem TODAS terminado,
        // chamada no finally() de cada uma (a ORDEM não importa, cada
        // uma seta seu próprio *LoadedRef antes de checar as outras).
        const markRoomAssetsReadyIfDone = () => {
          if (
            roomShapeLoadedRef.current &&
            furnitureLoadedRef.current &&
            floorLoadedRef.current &&
            wallLoadedRef.current &&
            doorLoadedRef.current &&
            areaLoadedRef.current
          ) {
            setRoomAssetsReady(true);
          }
        };
        fetch(roomApiPath(roomSlug, "/room/shape"))
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (destroyed) return;
            if (Array.isArray(data?.items) && data.items.length > 0) {
              sceneRef.current?.loadSavedRoomShape(data.items);
              setDraftRoomShapeItems(data.items);
            } else {
              setDraftRoomShapeItems(sceneRef.current?.getDraftRoomShapeList() ?? []);
            }
          })
          .catch(() => {
            setDraftRoomShapeItems(sceneRef.current?.getDraftRoomShapeList() ?? []);
          })
          .finally(() => {
            roomShapeLoadedRef.current = true;
            markRoomAssetsReadyIfDone();
          });
        fetchAndRegisterCustomSkins();
        fetchAndRegisterCustomAvatarItems();
        fetchDefaultReferences();
        fetchAndRegisterCustomFurniture().finally(() => {
          fetch(roomApiPath(roomSlug, "/room/furniture"))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              // trava contra StrictMode/dev double-invoke (ver comentário
              // grande logo abaixo, no fetch de /room/floor -- mesmo bug,
              // mesma correção) -- sem isso, essa busca (disparada pelo
              // MOUNT #1, já destruído) podia responder DEPOIS de
              // sceneRef.current já apontar pra cena do MOUNT #2 (ou,
              // pior, ainda apontar pra cena #1 destruída nesse meio-
              // tempo) e desenhar mobília sobre uma cena/texture manager
              // que não deveria mais existir.
              if (destroyed) return;
              if (data?.seatOffsets) {
                setSeatOffsetsState(data.seatOffsets);
                sceneRef.current?.setSeatOffsets(data.seatOffsets);
              }
              if (data?.items) sceneRef.current?.loadSavedFurniture(data.items);
            })
            .catch(() => {})
            .finally(() => {
              furnitureLoadedRef.current = true;
              markRoomAssetsReadyIfDone();
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
        // salvo antes mesmo da busca responder. Espera
        // fetchAndRegisterCustomFloor() terminar ANTES (mesma corrida já
        // corrigida pra mobília, ver "ACHADO" no create() acima e
        // fetchAndRegisterCustomFurniture().finally() logo acima) -- senão
        // um piso salvo usando um estilo CUSTOM carregaria antes da
        // textura dele existir na cena.
        fetchAndRegisterCustomFloor().finally(() => {
          fetch(roomApiPath(roomSlug, "/room/floor"))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              // ACHADO investigando o erro "TypeError: Cannot read
              // properties of null (reading 'glTexture')" que o Douglas
              // reportou (print do jogo travado, WebGLRenderer.render ->
              // Frame.get glTexture): next.config.js tem
              // reactStrictMode:true, então em DEV (só em dev -- é
              // exatamente por isso que só acontecia com "npm run dev")
              // o React monta esse efeito, DESLIGA ele (destroyed=true,
              // gameRef.current.destroy(true) -- apaga o Phaser.Game #1
              // inteiro, textura/WebGL incluso) e MONTA de novo (Game #2)
              // de propósito, pra pegar bug de cleanup incompleto (ver
              // https://react.dev/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development).
              // Esse fetch aqui é disparado pelo MOUNT #1 -- se ele só
              // responde DEPOIS do destroy (rede é mais lenta que o
              // remount), sceneRef.current (um ref COMPARTILHADO entre
              // as duas montagens, não uma variável local de cada
              // efeito) já pode estar apontando pra cena do MOUNT #2 (daí
              // loadSavedFloor roda 2x, uma vez por mount -- inofensivo
              // sozinho, o draftFloor.has(key) do MainScene.ts já
              // deduplica) OU, pior, ainda apontar pra cena #1 JÁ
              // DESTRUÍDA (a atribuição sceneRef.current = scene só
              // acontece dentro do Phaser.Core.Events.READY de CADA
              // Game, que pode demorar um pouco mais que o destroy do
              // Game anterior) -- nesse caso loadSavedFloor ia criar
              // textura de canvas (this.textures.createCanvas) e Image
              // (this.add.image) num texture manager/cena JÁ destruídos,
              // exatamente o tipo de objeto quebrado (frame sem source
              // WebGL de verdade) que gera esse erro no próximo render.
              // Mesma trava que requestMedia (mais acima nesse mesmo
              // efeito) já usa pro getUserMedia -- `destroyed` É local de
              // CADA invocação do efeito (uma closure por mount), então
              // só o mount que criou ESSE fetch específico consegue ver
              // o SEU PRÓPRIO destroyed=true, é exatamente o guard certo.
              if (destroyed) return;
              if (data?.items) sceneRef.current?.loadSavedFloor(data.items);
            })
            .catch(() => {})
            .finally(() => {
              floorLoadedRef.current = true;
              markRoomAssetsReadyIfDone();
            });
        });
        // parede já salva (ver GET /room/walls em server/index.js) --
        // mesmo timing/tratamento de falha/trava StrictMode do piso
        // acima (ver loadSavedWall em MainScene.ts). Agora TEM modelo
        // CUSTOM (padrão de tijolo, ver fetchAndRegisterCustomWall acima
        // -- pedido do Douglas: "a gente cria uma nova aba la no criar
        // pra configurar os padroes dela"), então espera
        // fetchAndRegisterCustomWall() terminar ANTES, mesma corrida já
        // corrigida pro piso (ver comentário grande dele logo acima) --
        // senão uma parede salva usando um estilo CUSTOM cairia no
        // "textura/estilo não encontrado" de addWallSprite antes do
        // estilo existir em WALL_CATALOG.
        fetchAndRegisterCustomWall().finally(() => {
          fetch(roomApiPath(roomSlug, "/room/walls"))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (destroyed) return;
              if (data?.items) sceneRef.current?.loadSavedWall(data.items);
            })
            .catch(() => {})
            .finally(() => {
              wallLoadedRef.current = true;
              markRoomAssetsReadyIfDone();
            });
        });
        // porta já salva (ver GET /room/doors em server/index.js) -- mesmo
        // timing/tratamento de falha/trava StrictMode da parede acima
        // (espera fetchAndRegisterCustomDoor() terminar antes, senão uma
        // porta salva com estilo custom cairia no "textura não encontrada"
        // de addDoorSprite antes do estilo existir em DOOR_CATALOG -- porta
        // é SEMPRE custom hoje, ver comentário grande em game/door.ts).
        fetchAndRegisterCustomDoor().finally(() => {
          fetch(roomApiPath(roomSlug, "/room/doors"))
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (destroyed) return;
              if (data?.items) sceneRef.current?.loadSavedDoor(data.items);
            })
            .catch(() => {})
            .finally(() => {
              doorLoadedRef.current = true;
              markRoomAssetsReadyIfDone();
            });
        });
        // área já salva (ver GET /room/areas em server/index.js) -- mesmo
        // timing/tratamento de falha do piso acima, só que a resposta tem
        // DUAS listas ({list, tiles}, ver getAreaState em roomStore.js):
        // a lista de áreas CRIADAS precisa entrar primeiro (setAreaDefs),
        // porque a cor de cada tile pintado vem da área dona dele (ver
        // addAreaTileRect em MainScene.ts, que já precisa da lista
        // carregada antes de desenhar).
        fetch(roomApiPath(roomSlug, "/room/areas"))
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            // trava contra StrictMode/dev double-invoke -- mesmo bug/
            // mesma correção do fetch de /room/floor logo acima (ver
            // comentário grande lá).
            if (destroyed) return;
            if (data?.list) {
              // MESCLA em vez de SOBRESCREVER -- bug encontrado
              // investigando "as areas que eu crio nao tao salvando"
              // (Douglas): diferente do piso/mobília (que só entram na
              // cena, nunca pisam por cima do estado React direto, ver
              // onDraftFloorChange/loadSavedFloor), a lista de áreas
              // (nome+tipo) vivia SÓ no React (draftAreaDefs) e essa
              // busca a SOBRESCREVIA inteira assim que respondia. Se o
              // Douglas criasse uma área (createArea -> setDraftAreaDefs)
              // ANTES dessa busca (disparada no mount) terminar, a
              // resposta chegava com a lista ANTIGA do servidor (sem a
              // área nova) e apagava ela da lista -- o que também torna
              // "órfão" (e apaga) qualquer tile já pintado nela, ver
              // pruning em setAreaDefs (MainScene.ts) -- daí o autosave
              // seguinte persistia esse estado já sem a área, LEVANDO O
              // TILE JUNTO. Agora mantém qualquer área criada localmente
              // que ainda não apareceu na resposta do servidor (id que o
              // servidor não conhece), só troca pelo valor do servidor as
              // que já existiam nos dois lados. Usa draftAreaDefsRef (não
              // o `draftAreaDefs` direto, que aqui dentro seria sempre o
              // valor "congelado" do momento em que essa função foi
              // criada) pra pegar o estado ATUAL, e chama
              // sceneRef.setAreaDefs SÍNCRONO com o resultado já
              // mesclado -- loadSavedAreas (linha logo abaixo) precisa da
              // área já registrada na cena pra não jogar fora um tile
              // dela como "órfão" (setState sozinho só reflete no
              // próximo render, tarde demais pra essa ordem).
              const serverIds = new Set(data.list.map((a: AreaDef) => a.id));
              const localOnly = draftAreaDefsRef.current.filter((a) => !serverIds.has(a.id));
              const merged = localOnly.length > 0 ? [...data.list, ...localOnly] : data.list;
              setDraftAreaDefs(merged);
              sceneRef.current?.setAreaDefs(merged);
            }
            if (data?.tiles) sceneRef.current?.loadSavedAreas(data.tiles);
          })
          .catch(() => {})
          .finally(() => {
            areaLoadedRef.current = true;
            markRoomAssetsReadyIfDone();
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
        // ver comentário grande no início do efeito (pendingPartyMessages)
        // -- só agora, com a cena garantidamente pronta (textura padrão de
        // cabelo/base/traje/barba já carregada), processa qualquer
        // "init"/"join"/"move"/etc. de jogador remoto que chegou cedo
        // demais e ficou esperando na fila. Ordem preservada (splice tira
        // tudo de uma vez, antes de processar, pra nenhuma mensagem NOVA
        // que chegue durante esse loop furar a fila).
        if (pendingPartyMessages.length > 0) {
          const queued = pendingPartyMessages.splice(0, pendingPartyMessages.length);
          for (const queuedMessage of queued) handlePartyMessage(queuedMessage);
        }
        };
        // ver comentário grande logo acima (runWhenSceneReady) -- cobre as
        // duas ordens possíveis entre o "ready" do jogo e o create() da
        // cena terminar.
        if (scene.sceneReady) runWhenSceneReady();
        else scene.events.once("scene-ready", runWhenSceneReady);
      });

      const socket = new PartySocket({ host: REALTIME_HOST, room: roomSlug });
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
        // "chat:list"/"agenda:list" saíram daqui (2/out) -- essas
        // listas inteiras (conversas, compromissos) já chegam pela
        // conexão de PLATAFORMA (usePlatformChat.ts manda a mesma
        // mensagem assim que ELA conecta, uma vez só, nunca por sala) --
        // mandar de novo aqui só gerava um round-trip morto: o servidor
        // responde (ws.send) nesse MESMO socket de sala, que não tem
        // mais handler nenhum pra "chat:conversations"/"agenda:calls"
        // (removido junto do resto do estado local, ver comentário
        // grande logo abaixo sobre chat/agenda virarem `chat.*`).
      });
      socket.addEventListener("close", () => setStatus("Desconectado"));
      socket.addEventListener("error", () => setStatus("Erro de conexão"));
      socket.addEventListener("message", (evt) => {
        try {
          const data = JSON.parse(evt.data);
          // ver comentário grande no início do efeito (pendingPartyMessages)
          // -- sem isso, um "init"/"join"/"move" que chegasse rápido demais
          // criava o boneco do jogador remoto com textura ainda faltando,
          // quebrado até o próximo F5 (às vezes).
          if (!sceneRef.current?.sceneReady) {
            pendingPartyMessages.push(data);
            return;
          }
          handlePartyMessage(data);
        } catch (e) {
          console.warn("Mensagem inválida do servidor", e);
        }
      });

      // câmera/microfone rodam à parte, sem bloquear nada acima
      requestMedia();
    }

    init();

    // Rede de segurança pra RoomLoadingScreen NUNCA travar pra sempre --
    // o pedido do Douglas era só "nao ir vendo carregando aos poucos",
    // não trocar esse problema por um pior (tela de carregamento presa
    // se UMA das 6 buscas nunca responder, ex: servidor caiu bem no
    // meio -- hoje nenhuma delas tem timeout próprio, só .catch(erro de
    // rede de verdade)+.finally, ver markRoomAssetsReadyIfDone lá em
    // cima). 10s é bem mais que o normal (mesmo servidor Render do
    // WebSocket, que já responde na casa dos ms) -- só existe pra
    // cobrir o servidor de verdade travado/sem resposta nenhuma.
    const roomAssetsReadyFallback = setTimeout(() => {
      if (!destroyed) setRoomAssetsReady(true);
    }, 10000);

    return () => {
      destroyed = true;
      clearTimeout(roomAssetsReadyFallback);
      gameRef.current?.destroy(true);
      socketRef.current?.close();
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peersRef.current.forEach((pc) => pc.close());
      peersRef.current.clear();
      // NÃO fecha a chamada de conversa aqui -- ela mora no motor único
      // (usePlatformChat.ts, callPeersRef interno dele) e precisa
      // SOBREVIVER a sair da sala (voltar pro Lobby não deveria
      // derrubar uma chamada em andamento, mesmo espírito de
      // conversas/mensagens continuarem abertas). Quem fecha é
      // leaveCall (botão) ou o próprio hook ao desmontar de vez
      // (logout, ver PlatformChatHost em app/page.tsx).
    };
  }, []);

  // 2/out, bug achado (Douglas: "entrei com um visitante e na
  // aproximidade clico nos botoes de audio e camera e nao ativou") --
  // os dois tinham `if (!stream) return;` ANTES de mexer em qualquer
  // state -- enquanto requestMedia() ainda não tinha resolvido o
  // getUserMedia (aguardando a pessoa responder o aviso de permissão
  // do navegador, que pra visitante novo pode demorar) ou se o
  // getUserMedia falhou de vez (permissão negada), localStreamRef.current
  // é null e o clique virava NADA -- nem o ícone mudava, nenhum feedback,
  // silencioso. Agora sempre atualiza o state/preferência (feedback
  // na hora, sempre) e só mexe nas tracks do stream de verdade SE ele
  // já existir -- requestMedia() lê getStoredMicOn()/getStoredCamOn()
  // quando o stream finalmente chega, então um toggle que aconteceu
  // antes dele existir ainda é respeitado certinho assim que a
  // permissão libera.
  function toggleMic() {
    const stream = localStreamRef.current;
    if (stream) stream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setMicOn((v) => {
      setStoredMicOn(!v); // persiste (ver lib/mediaPrefs.ts) -- próxima visita ao Lobby já abre mutado/desmutado igual deixou aqui
      return !v;
    });
  }

  function toggleCam() {
    const stream = localStreamRef.current;
    if (stream) stream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setCamOn((v) => {
      setStoredCamOn(!v);
      return !v;
    });
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
      peersRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        sender?.replaceTrack(newTrack);
      });
      chat.replaceCallTrack(newTrack);
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
      // com tela compartilhada agora, o sender de vídeo tá ocupado com a
      // tela (ver toggleScreenShare) -- não mexe nele aqui, a câmera nova
      // só assume quando a pessoa PARAR o compartilhamento
      // (stopScreenShare já pega a track atual de localStreamRef sozinho).
      if (!screenOn) {
        peersRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          sender?.replaceTrack(newTrack);
        });
        chat.replaceCallTrack(newTrack);
        if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      }
      setSelectedCamId(deviceId);
      setStoredCamDeviceId(deviceId);
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
    setStoredSpeakerDeviceId(deviceId);
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
    // @menção (pedido do Douglas, 1/out) -- manda junto quem foi
    // @mencionado nessa mensagem (ver pendingMentionIds/insertMention em
    // ChatDrawer); zera só depois que o envio deu certo, senão perderia
    // a menção se o socket tivesse caído na hora.
    if (!wsSend({ type: "chat", text, mentionedUserIds: pendingMentionIds })) return;
    setChatInput("");
    setPendingMentionIds([]);
  }

  // --- chat de verdade (direta/grupo) -- ver tipos Conversation/ChatMsg
  // lá em cima. "Sala" (activeConversationId === null) continua usando
  // sendChat/chatLog de cima -- mesmo formato de mensagem (com anexo),
  // só que sem histórico salvo (ver comentário no tipo ChatMessage). ---

  // Sala (conversationId===null) continua sendo o PRÓPRIO socket da
  // sala (wsSend); conversa de verdade (direta/grupo) delega inteiro
  // pro motor único (chat.*, ver usePlatformChat.ts) -- startDirectWith/
  // moveConversationLane/submitNewConversation/toggleNewConvSelection/
  // changeNewConvMode/submitRenameGroup/openFilesPanel/closeFilesPanel/
  // mentionAttachmentInChat/joinCall/leaveCall já vêm de lá (ver
  // destructure de "chat" lá em cima), chamados pelo MESMO nome de
  // sempre.
  function openConversation(id: string | null) {
    chat.openConversation(id);
    // chat.openConversation(null) assume "list" (não existe Sala pra
    // ela) -- aqui null É a Sala, então força "thread" de novo por
    // cima (mesmo comportamento de sempre: abrir a Sala já mostra o
    // histórico dela, nunca a lista de conversas).
    if (id === null) chat.setChatView("thread");
  }

  async function sendChatAttachment(file: Blob, filename: string, kind: ChatAttachmentKind) {
    if (chat.activeConversationId === null) {
      setSendingAttachment(true);
      try {
        const attachment = await uploadChatFile(file, filename);
        wsSend({ type: "chat", attachment, kind });
      } catch (e) {
        console.warn("Falha ao enviar anexo no chat", e);
        showErrorToast("Não deu pra enviar o anexo -- tenta de novo.");
      } finally {
        setSendingAttachment(false);
      }
    } else {
      setSendingAttachment(true);
      try {
        await chat.sendChatAttachment(file, filename, kind);
      } finally {
        setSendingAttachment(false);
      }
    }
  }

  function handleChatFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    sendChatAttachment(file, file.name, file.type.startsWith("image/") ? "image" : "file");
  }

  // --- "Convidar amigo" / "Visitar amigo" (pedido do Douglas, 30/set):
  // botão com seta do lado do nome, dentro de uma conversa direta --
  // "Convidar amigo" manda um cardzinho com a sala ATUAL (ver
  // roomSlug/roomCompanyName/roomCompanyLogoUrl lá em cima, mesma sala
  // que a pessoa tá vendo agora); "Visitar amigo" manda só o pedido
  // ("Fulano está querendo ir até você"), sem sala nenhuma -- quem
  // recebe decide convidar de volta clicando no próprio cardzinho (ver
  // onAcceptVisit em ChatMessageRow). Só faz sentido numa conversa
  // direta de verdade (nunca no chat da Sala), mas aceita o mesmo
  // "roteamento" de sempre (conversationId null cairia no chat da
  // Sala, só não tem botão nenhum chamando isso nesse caso).
  function sendRoomCard(action: "invite" | "visit") {
    if (chat.activeConversationId === null) {
      const roomCard =
        action === "invite"
          ? { action, roomSlug, roomName: roomCompanyName || "Minha sala", roomLogoUrl: roomCompanyLogoUrl || "" }
          : { action, roomSlug: "", roomName: "", roomLogoUrl: "" };
      wsSend({ type: "chat", roomCard });
    } else {
      chat.sendRoomCard(action);
    }
  }

  // gravação de áudio: startVoiceRecording/stopVoiceRecording/
  // cancelVoiceRecording/discardRecordedAudio/sendRecordedAudio agora
  // são 100% de usePlatformChat.ts (ver destructure de "chat" lá em
  // cima) -- não existem mais aqui.

  // "apagar mensagem" -- apaga PRA TODOS (ver server/chatStore.js
  // deleteMessage e o case chat:delete/chat:delete_room em
  // server/index.js). conversationId null = mensagem da Sala.
  // "apagar mensagem" -- apaga PRA TODOS. Sala usa o PRÓPRIO socket
  // (chat:delete_room, sem histórico persistido só pra quem tá
  // conectado agora); conversa de verdade delega pro motor único.
  function deleteMessage(conversationId: string | null, messageId: string) {
    if (conversationId === null) {
      wsSend({ type: "chat:delete_room", messageId });
    } else {
      chat.deleteMessage(conversationId, messageId);
    }
  }

  // --- reação/fixar/digitando (pedido do Douglas, 1/out, comparando
  // com o Slack) -- mesmo esquema de deleteMessage acima: Sala usa o
  // socket da sala, conversa de verdade delega pro motor único. ---

  function toggleReaction(conversationId: string | null, messageId: string, emoji: string) {
    if (conversationId === null) {
      wsSend({ type: "chat:react", messageId, emoji });
    } else {
      chat.toggleReaction(conversationId, messageId, emoji);
    }
  }

  function pinMessage(conversationId: string | null, messageId: string, durationMs: number | null) {
    if (conversationId === null) {
      wsSend({ type: "chat:pin", messageId, durationMs: durationMs ?? undefined });
    } else {
      chat.pinMessage(conversationId, messageId, durationMs);
    }
  }

  function unpinMessage(conversationId: string | null, messageId: string) {
    if (conversationId === null) {
      wsSend({ type: "chat:unpin", messageId });
    } else {
      chat.unpinMessage(conversationId, messageId);
    }
  }

  // "fulano está digitando..." -- throttled (no máximo 1x a cada 2.5s),
  // chamado a cada tecla do composer enquanto tiver conteúdo. Sala usa
  // um throttle local (só ela mora aqui agora); conversa de verdade
  // delega pro motor único (que já tem o PRÓPRIO throttle por
  // conversationId, ver usePlatformChat.ts).
  const TYPING_THROTTLE_MS = 2500;
  const lastRoomTypingSentAtRef = useRef(0);
  function sendTypingNotification(conversationId: string | null) {
    if (conversationId === null) {
      const now = Date.now();
      if (now - lastRoomTypingSentAtRef.current < TYPING_THROTTLE_MS) return;
      lastRoomTypingSentAtRef.current = now;
      wsSend({ type: "chat:typing" });
    } else {
      chat.sendTypingNotification(conversationId);
    }
  }

  // "mencionar na conversa" (pedido do Douglas, 1/out: "...e botao de
  // baixar e de mencionar na conversa") -- insere "@Nome" referenciando
  // o arquivo no composer da conversa aberta agora (sem reabrir a
  // mensagem original, só um atalho pra comentar sobre ele); fecha o
  // painel em seguida, igual clicar "Mencionar" fecha o dropdown normal.
  // mentionAttachmentInChat/joinCall/leaveCall: usePlatformChat.ts (ver
  // destructure de "chat" lá em cima) -- painel de arquivos e chamada
  // de conversa são 100% dela, nunca existiram pra Sala.

  // --- Agenda (ver usePlatformChat.ts, comentário grande dela) --
  // todas as ações (updateAgendaForm/toggleAgendaParticipant/
  // startNewCall/submitCreateCall/handleAgendaFileChange/
  // removeAgendaFormAttachment/handleAgendaDetailFileChange/
  // toggleAgendaDay/openCallDetail/respondToCall/viewColleagueAgenda/
  // backToMyAgenda) migraram pro motor único, chamadas como
  // chat.nomeDaFuncao agora (ver destructure de "chat" no topo do
  // componente).

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
    setSelectedWallToolId(null);
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
      setSelectedWallToolId(null);
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
      setSelectedWallToolId(null);
      setDeleteToolActive(false);
    }
    sceneRef.current?.selectMoveTool(next);
  }

  // troca de categoria na barra de ícones -- separado de setActiveCategory
  // direto (era só isso antes) porque "assento" precisa ligar/desligar o
  // modo de ajuste na cena (ver setSeatTuningMode em MainScene.ts, muda o
  // que as setas de direção fazem enquanto sentado).
  function changeCategory(
    category: FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho"
  ) {
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
    setSelectedWallToolId(null);
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

  // MESMO padrão "clica de novo desarma" das ferramentas de piso acima,
  // pro formato da sala (aba "Tamanho", ver selectRoomShapeTool em
  // MainScene.ts) -- sem "Limpar tudo" aqui de propósito (diferente do
  // piso): a sala nunca pode ficar sem nenhum tile, não faz sentido
  // apagar tudo de uma vez (ver eraseRoomShapeAt em MainScene.ts).
  function selectRoomShapeAdd() {
    const next = selectedRoomShapeToolId === "add" ? null : "add";
    setSelectedRoomShapeToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectRoomShapeTool(next);
  }

  function selectRoomShapeErase() {
    const next = selectedRoomShapeToolId === "erase" ? null : "erase";
    setSelectedRoomShapeToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectRoomShapeTool(next);
  }

  // MESMO padrão "clica de novo desarma" das duas funções de piso acima,
  // pra parede de sistema (ver selectWallTool em MainScene.ts).
  function selectWallPaint(entry: WallCatalogEntry) {
    const next = selectedWallToolId === entry.id ? null : entry.id;
    setSelectedWallToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectWallTool(next === null ? null : { kind: "paint", entry });
  }

  function selectWallEraser() {
    const next = selectedWallToolId === "erase" ? null : "erase";
    setSelectedWallToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectWallTool(next === null ? null : { kind: "erase" });
  }

  function clearDraftWallItems() {
    sceneRef.current?.clearDraftWall();
  }

  // Troca o modo de inserção (ver comentário de wallPlacementMode acima)
  // e já avisa a cena (ver setWallPlacementMode em MainScene.ts) -- não
  // desarma a ferramenta de parede escolhida, só muda ONDE o próximo
  // clique planta ela.
  function selectWallPlacementMode(mode: "edge" | "center") {
    setWallPlacementModeState(mode);
    sceneRef.current?.setWallPlacementMode(mode);
  }

  // Troca a ORIENTAÇÃO usada dentro do modo "Centro do tile" (ver
  // comentário de wallCenterOrientation acima) e já avisa a cena (ver
  // setWallCenterOrientation em MainScene.ts) -- mesma ideia de
  // selectWallPlacementMode acima, não desarma a ferramenta.
  function selectWallCenterOrientation(orientation: "center" | "centerRow") {
    setWallCenterOrientationState(orientation);
    sceneRef.current?.setWallCenterOrientation(orientation);
  }

  // MESMO padrão "clica de novo desarma" da parede de sistema acima, pra
  // porta (ver selectDoorTool em MainScene.ts) -- usa o `doorFacing`
  // escolhido no momento (ver toggleDoorFacing abaixo) igual peça de
  // móvel gira ANTES de colocar.
  function selectDoorPaint(entry: DoorCatalogEntry) {
    const next = selectedDoorToolId === entry.id ? null : entry.id;
    setSelectedDoorToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectDoorTool(next === null ? null : { kind: "paint", entry, facing: doorFacing });
  }

  function selectDoorEraser() {
    const next = selectedDoorToolId === "erase" ? null : "erase";
    setSelectedDoorToolId(next);
    setSelectedCatalogIndex(null);
    setDeleteToolActive(false);
    setMoveToolActive(false);
    sceneRef.current?.selectDoorTool(next === null ? null : { kind: "erase" });
  }

  function clearDraftDoorItems() {
    sceneRef.current?.clearDraftDoor();
  }

  /** Botão de virar lado ("esquerdo"/"direito") no painel "Porta" -- mesma
   * mecânica de girar um móvel antes de colocar (FURNITURE_ROTATE_ORDER),
   * ver DOOR_FACING_ROTATE_ORDER em game/door.ts. Se já tiver uma porta
   * armada pra pintar, reenvia a ferramenta pra cena já com o novo lado
   * (senão só o próximo "armar" pegaria o valor certo). */
  function toggleDoorFacing() {
    const idx = DOOR_FACING_ROTATE_ORDER.indexOf(doorFacing);
    const next = DOOR_FACING_ROTATE_ORDER[(idx + 1) % DOOR_FACING_ROTATE_ORDER.length];
    setDoorFacing(next);
    if (selectedDoorToolId && selectedDoorToolId !== "erase") {
      const entry = DOOR_CATALOG.find((e) => e.id === selectedDoorToolId);
      if (entry) sceneRef.current?.selectDoorTool({ kind: "paint", entry, facing: next });
    }
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
      fetch(roomApiPath(roomSlug, "/room/floor"), {
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

  // autosave do FORMATO da sala -- MESMA lógica/timing do autosave do
  // piso acima (POST /room/shape, ver server/index.js), disparado por
  // qualquer mudança em draftRoomShapeItems (pintar/apagar um tile na
  // aba "Tamanho", ou o carregamento inicial). roomShapeLoadedRef evita
  // salvar ANTES da busca inicial responder (mesmo cuidado de
  // floorLoadedRef -- senão o primeiro render, ainda com o retângulo
  // padrão da cena, salvaria por cima de um formato já customizado).
  useEffect(() => {
    if (!roomShapeLoadedRef.current) return;
    const timer = setTimeout(() => {
      setRoomShapeSaveStatus("saving");
      fetch(roomApiPath(roomSlug, "/room/shape"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ items: draftRoomShapeItems }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setRoomShapeSaveStatus("saved");
        })
        .catch(() => setRoomShapeSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftRoomShapeItems]);

  // autosave da parede -- MESMA lógica/timing do autosave do piso acima
  // (POST /room/walls, ver server/index.js).
  useEffect(() => {
    if (!wallLoadedRef.current) return;
    const timer = setTimeout(() => {
      setWallSaveStatus("saving");
      fetch(roomApiPath(roomSlug, "/room/walls"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ items: draftWallItems }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setWallSaveStatus("saved");
        })
        .catch(() => setWallSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftWallItems]);

  // autosave da porta -- MESMA lógica/timing do autosave da parede acima
  // (POST /room/doors, ver server/index.js).
  useEffect(() => {
    if (!doorLoadedRef.current) return;
    const timer = setTimeout(() => {
      setDoorSaveStatus("saving");
      fetch(roomApiPath(roomSlug, "/room/doors"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accountAccessTokenRef.current
            ? { Authorization: `Bearer ${accountAccessTokenRef.current}` }
            : {}),
        },
        body: JSON.stringify({ items: draftDoorItems }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          setDoorSaveStatus("saved");
        })
        .catch(() => setDoorSaveStatus("error"));
    }, 600);
    return () => clearTimeout(timer);
  }, [draftDoorItems]);

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
      fetch(roomApiPath(roomSlug, "/room/areas"), {
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
      fetch(roomApiPath(roomSlug, "/room/furniture"), {
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

  // checagem de disponibilidade da agenda -- migrada pro usePlatformChat.ts
  // (sistema único, roda igual dentro da sala e no Lobby).

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
  // comentário em selectedHairColorId acima). colorId=null volta pra
  // arte "padrão" do penteado, sem nenhuma cor escolhida (pedido do
  // Douglas: "quando eu adiciono a cor nao consigo voltar a cor
  // original" -- ver skin-swatch-reset no JSX).
  function selectHairColor(colorId: string | null) {
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
  // colorId=null volta pra arte "padrão" do acessório (mesmo esquema
  // de selectHairColor acima).
  function selectAccessoryColor(colorId: string | null) {
    setSelectedAccessoryColorId(colorId);
  }

  // traje: mesmo par de funções do cabelo/acessório (troca de traje
  // reseta a cor escolhida; trocar só a cor mantém o traje atual). A
  // arte BASE (sem cor) continua combinando sozinha com o tom de pele
  // escolhido acima (outfitFileForSkin/resolveOutfitSkinId) -- uma cor
  // escolhida também, já que cada cor vira sua própria entrada com
  // bySkin (ver fetchAndRegisterCustomAvatarItems).
  function selectOutfit(outfitId: string) {
    setSelectedOutfitId(outfitId);
    setSelectedOutfitColorId(null);
  }
  // colorId=null volta pra arte "padrão" do traje (mesmo esquema de
  // selectHairColor acima).
  function selectOutfitColor(colorId: string | null) {
    setSelectedOutfitColorId(colorId);
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
  const outfitColorBeforeEditRef = useRef(selectedOutfitColorId);
  function startEditingCharacter() {
    hairBeforeEditRef.current = selectedHairId;
    hairColorBeforeEditRef.current = selectedHairColorId;
    genderBeforeEditRef.current = selectedGender;
    skinBeforeEditRef.current = selectedSkinId;
    beardBeforeEditRef.current = selectedBeardId;
    accessoryBeforeEditRef.current = selectedAccessoryId;
    accessoryColorBeforeEditRef.current = selectedAccessoryColorId;
    outfitBeforeEditRef.current = selectedOutfitId;
    outfitColorBeforeEditRef.current = selectedOutfitColorId;
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
    setSelectedOutfitColorId(outfitColorBeforeEditRef.current);
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
    sceneRef.current?.setLocalOutfitId(selectedOutfitColorId ?? selectedOutfitId);

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
          outfitColorId: selectedOutfitColorId,
        } satisfies SavedAvatar)
      );
    } catch {
      // localStorage indisponível (modo privado, etc.) -- segue só em memória
    }

    // avisa a sala inteira da aparência nova (ver protocolo "look" em
    // server/index.js) -- sem isso, só EU veria a roupa/cabelo/etc que
    // acabei de trocar (ver comentário grande em RemotePlayer/
    // setRemoteLook, MainScene.ts: pedido do Douglas, 30/set, "o estilo
    // roupa que ele escolher do avatar, deve seguir ele em qualquer
    // ambiente que ele for" -- isso cobre TODO mundo ver, em QUALQUER
    // sala; a persistência local pro F5/pra sala seguinte já tava feita
    // no localStorage.setItem logo acima).
    sendLookUpdate({
      hairId: selectedHairColorId ?? selectedHairId,
      skinId: selectedSkinId,
      beardId: selectedBeardId,
      accessoryId: selectedAccessoryColorId ?? selectedAccessoryId,
      outfitId: selectedOutfitColorId ?? selectedOutfitId,
    });

    setEditingCharacter(false);
  }

  function sendProfileUpdate(fields: ProfileFields) {
    socketRef.current?.send(JSON.stringify({ type: "profile", ...fields }));
  }

  // aparência do boneco (ver comentário grande em RemotePlayer/
  // setRemoteLook, MainScene.ts, e protocolo "look" em server/index.js)
  // -- mesmo esquema de sendProfileUpdate acima, cada campo já chega
  // RESOLVIDO pra cor escolhida quando houver (colorId ?? id, mesma
  // convenção dos scene?.setLocal*Id de sempre), undefined pula o campo
  // (o servidor mantém o que já tinha, ver case "look" nele).
  function sendLookUpdate(fields: {
    hairId?: string;
    skinId?: string;
    beardId?: string;
    accessoryId?: string;
    outfitId?: string;
  }) {
    socketRef.current?.send(JSON.stringify({ type: "look", ...fields }));
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

  // "Conversar" no painel de Amigos (antigo "Contatos", ver
  // FriendsPanel.tsx) -- mesma ideia de sendMessageTo acima (abre/cria
  // a conversa direta e já mostra a gaveta de chat), só que a pessoa
  // já vem com o userId PERSISTENTE certinho (não precisa resolver via
  // remotePlayersRef, a lista de amigos já é indexado por userId) e
  // fecha o painel ao entrar no chat. SEMPRE lane "private" -- esse
  // painel só lista amigo mútuo (ver aba "Conversas Privadas" em
  // LobbyChatPanel/ChatDrawer, mesma trava do servidor em
  // chat:create_direct).
  function startConversationFromContacts(targetUserId: string) {
    startDirectWith(targetUserId, "private");
    setChatOpen(true);
    setContactsOpen(false);
  }

  /** "Deixar um recado" no card de outro jogador -- pedido do Douglas:
   * "deixar um recado, igual o gather". DIFERENTE de sendMessageTo acima
   * (que abre a conversa de verdade, persistente): aqui é um aviso avulso
   * com texto livre, mesmo espírito de "Disponível?"/"Chamar até você"
   * (ver sendPoke) -- vira só um toast momentâneo do lado de quem
   * recebe, nunca fica salvo em lugar nenhum (nem chat, nem banco). Texto
   * já vem digitado do composer inline do próprio card (ver
   * ProfileCard/recado-composer no JSX) -- por isso não fecha o card
   * depois (mesmo comportamento de onAskAvailable/onCallOver, que também
   * não fecham; só sendMessageTo fecha, porque esse navega pra outro
   * lugar, o chat).
   */
  function sendNote(targetId: string, text: string) {
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed) return;
    socketRef.current?.send(JSON.stringify({ type: "poke", to: targetId, kind: "note", text: trimmed }));
  }

  // 29/set (14), pedido do Douglas: "gostei da forma de mostrar que
  // tem mensagem, mantenha / mas nao esta funcionando" -- soma real de
  // não-lida (ver unreadCount em server/chatStore.js/
  // listConversationsForUser), usada no badge do botão "Chat" da
  // av-bar (ver mais abaixo).
  // props compartilhadas do ChatDrawer -- o MESMO componente é usado em
  // dois lugares do JSX agora (flutuante por cima do jogo, ou fixo como
  // barra lateral à esquerda, ver chatPinned), só a posição/pinned muda.
  // Tudo que é CONVERSA de verdade (direta/grupo) vem de chat.* (motor
  // único, ver usePlatformChat.ts); só o que é GENUINAMENTE da Sala
  // (chatLog/roomPins/roomTyping/pendingMentionIds locais, "hasRoom")
  // continua daqui.
  const activeConversationId = chat.activeConversationId;

  // 2/out, pedido do Douglas: "o balaozinho nao veio na conversa da
  // sala" -- o balãozinho de não-lida (chat-conv-unread-badge, ver
  // ChatDrawer) já existia pras conversas de verdade (unreadCount vem
  // do SERVIDOR, ver chat:history acima), mas a "Sala" é a
  // pseudo-conversa local (chatLog, sem persistência -- ver comentário
  // grande lá em cima de myUserId) e nunca teve esse conceito. Local
  // porque a Sala em si já é local/efêmera (nunca existiu um
  // "unreadCount da Sala" no servidor pra reaproveitar); o badge em si
  // é o MESMO componente/classe CSS das conversas de verdade, só a
  // CONTAGEM é própria daqui.
  //
  // "visto" = thread da Sala estava de fato ABERTA (gaveta aberta +
  // Sala selecionada + view "thread", não só "list" no fundo) na hora
  // que a mensagem chegou. roomChatSeenIdsRef guarda os ids já vistos
  // (Set, não contagem -- sobrevive a chatLog sendo truncado/
  // substituído por snapshot do servidor, ver setChatLog acima).
  const roomChatSeenIdsRef = useRef<Set<string>>(new Set());
  const [roomUnreadCount, setRoomUnreadCount] = useState(0);
  useEffect(() => {
    const isRoomThreadOpen = chatOpen && activeConversationId === null && chat.chatView === "thread";
    if (isRoomThreadOpen) {
      for (const m of chatLog) roomChatSeenIdsRef.current.add(m.id);
      setRoomUnreadCount(0);
      return;
    }
    let count = 0;
    for (const m of chatLog) {
      if (m.senderId !== myUserId && !roomChatSeenIdsRef.current.has(m.id)) count++;
    }
    setRoomUnreadCount(count);
  }, [chatLog, chatOpen, activeConversationId, chat.chatView, myUserId]);
  const chatDrawerProps = {
    view: chat.chatView,
    onChangeView: chat.setChatView,
    conversations: chat.conversations,
    activeConversationId,
    onOpenConversation: openConversation,
    messages: activeConversationId === null ? [] : chat.messagesByConv[activeConversationId] ?? [],
    // 29/set (14): corte "mensagens não vistas" da conversa aberta
    // agora -- null enquanto ainda não chegou (ou é a Sala, que não tem
    // esse conceito).
    unreadSinceTs: activeConversationId === null ? null : chat.unreadSinceTsByConv[activeConversationId] ?? null,
    roomChatLog: chatLog,
    roomUnreadCount,
    // 1/out (unificação Lobby/GameRoom) -- ver comentário grande de
    // hasRoom em components/ChatDrawer.tsx; a sala de verdade sempre tem
    // "Sala" na lista, só o Lobby (sem WebSocket/sem "por perto") passa
    // false.
    hasRoom: true,
    myUserId,
    onlinePlayers: Array.from(remotePlayersRef.current.values()),
    roomCompanyName,
    roomCompanyLogoUrl,
    accountAccessToken,
    // pedido do Douglas, 30/set (5): "volume de chamadas" -- aplicado
    // no vídeo/áudio da chamada de conversa (ver ChatCallVideoTile
    // mais abaixo), ajustável em Configurações mesmo fora da sala.
    callVolume,
    // "Conversa" vs "Criar grupo" (pedido do Douglas, 1/out) -- agora
    // 100% de chat.* (motor único).
    newConvMode: chat.newConvMode,
    onChangeNewConvMode: changeNewConvMode,
    newConvSelection: chat.newConvSelection,
    onToggleNewConvSelection: toggleNewConvSelection,
    newConvName: chat.newConvName,
    onChangeNewConvName: chat.setNewConvName,
    onSubmitNewConversation: submitNewConversation,
    newConvFilter: chat.newConvFilter,
    onChangeNewConvFilter: chat.setNewConvFilter,
    newConvQuery: chat.newConvQuery,
    onChangeNewConvQuery: chat.setNewConvQuery,
    newConvSearchResults: chat.newConvSearchResults,
    newConvFriends: chat.newConvFriends,
    renamingGroup: chat.renamingGroup,
    onStartRenameGroup: (currentName: string) => {
      chat.setGroupNameDraft(currentName);
      chat.setRenamingGroup(true);
    },
    onCancelRenameGroup: () => chat.setRenamingGroup(false),
    groupNameDraft: chat.groupNameDraft,
    onChangeGroupNameDraft: chat.setGroupNameDraft,
    onSubmitRenameGroup: submitRenameGroup,
    // composer/gravação/anexo: Sala continua com o PRÓPRIO (chatInput/
    // sendChat local, reaproveitando localStreamRef pra gravar, ver
    // startVoiceRecording) -- conversa de verdade usa o do motor único.
    composerText: activeConversationId === null ? chatInput : chat.composerText,
    onChangeComposerText: activeConversationId === null ? setChatInput : chat.setComposerText,
    onSendComposer: activeConversationId === null ? sendChat : chat.onSendComposer,
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
    onSendRoomCard: sendRoomCard,
    onMoveConversationLane: moveConversationLane,
    onMuteConversation: muteConversation,
    onDeleteConversation: deleteConversation,
    replyingTo,
    onStartReply: startReplyToMessage,
    onCancelReply: cancelReply,
    callParticipantsByConversation: chat.callParticipantsByConversation,
    myCallConversationId: chat.myCallConversationId,
    callRemoteStreams: chat.callRemoteStreams,
    onJoinCall: joinCall,
    onLeaveCall: leaveCall,
    localStreamRef,
    camOn,
    micOn,
    onToggleMic: toggleMic,
    onToggleCam: toggleCam,
    onClose: () => setChatOpen(false),
    pinMode: chatPinMode,
    onToggleSidePin: toggleChatPinSide,
    // 29/set (11), pedido do Douglas: "quadnoa bro a conversa com uma
    // pessoa direta / Quero a foto dela ali encima, e essa parte de
    // cima clicavel, abrindo o perfil dela ali dentro" -- abre o MESMO
    // ProfileCard que já existe pra qualquer jogador da sala (mesmo
    // profileCard/setProfileCard usado pelo clique num avatar/
    // AreaOwnerHoverCard, ver JSX dele mais abaixo) -- participants[].id
    // de uma conversa "direct" é o MESMO id que remoteProfiles usa
    // (ver comentário grande de ConversationParticipant no topo do
    // arquivo), então funciona pra visitante sem conta também (não dá
    // pra usar o ProfileViewCard "de conta" aqui, ele exige login).
    onOpenProfile: (playerId: string) => setProfileCard({ playerId, isLocal: false }),
    // reação/fixar/digitando/visto por (pedido do Douglas, 1/out) --
    // "pins"/"typingUsers"/"lastRead" trocam de fonte conforme a aba
    // aberta (Sala usa roomPins/roomTyping locais, conversa de verdade
    // usa chat.*); onToggleReaction/onPinMessage/onUnpinMessage já
    // fecham sobre o activeConversationId certo, ChatMessageRow não
    // precisa saber qual conversa é.
    pins: activeConversationId === null ? roomPins : chat.pinsByConv[activeConversationId] ?? [],
    typingUsers: activeConversationId === null ? roomTyping : chat.typingByConv[activeConversationId] ?? [],
    lastRead: activeConversationId === null ? {} : chat.lastReadByConv[activeConversationId] ?? {},
    onToggleReaction: (messageId: string, emoji: string) => toggleReaction(activeConversationId, messageId, emoji),
    onPinMessage: (messageId: string, durationMs: number | null) => pinMessage(activeConversationId, messageId, durationMs),
    onUnpinMessage: (messageId: string) => unpinMessage(activeConversationId, messageId),
    onTypingNotify: () => sendTypingNotification(activeConversationId),
    // painel lateral "arquivos da conversa" -- só existe pra conversa de
    // VERDADE aberta, 100% de chat.* (nunca existiu pra Sala).
    filesPanelOpen: chat.filesPanelOpen,
    filesPanelItems: chat.filesPanelItems,
    filesPanelFilter: chat.filesPanelFilter,
    onChangeFilesPanelFilter: chat.setFilesPanelFilter,
    filesPanelQuery: chat.filesPanelQuery,
    onChangeFilesPanelQuery: chat.setFilesPanelQuery,
    onOpenFilesPanel: openFilesPanel,
    onCloseFilesPanel: closeFilesPanel,
    onMentionAttachmentInChat: mentionAttachmentInChat,
    // @menção (pedido do Douglas, 1/out) -- Sala usa pendingMentionIds
    // local, conversa de verdade usa o do motor único (ver comentário
    // grande em pendingMentionIds lá em cima); onAddPendingMentionId é
    // chamado por insertMention (local ao ChatDrawer) quando a pessoa
    // escolhe um candidato no dropdown -- despacha pro lado certo
    // conforme o que tá aberto agora.
    pendingMentionIds: activeConversationId === null ? pendingMentionIds : chat.pendingMentionIds,
    onAddPendingMentionId: (userId: string) => {
      if (activeConversationId === null) {
        setPendingMentionIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
      } else {
        chat.setPendingMentionIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
      }
    },
  };

  // 2/out -- props/render do AgendaDrawer saíram daqui (ver
  // PlatformAgendaHost em app/page.tsx, "funcionando acima de tudo,
  // acima de lobby acima de jogo" -- pedido do Douglas): a gaveta
  // agora é UMA instância só, hospedada fora da troca Lobby<->GameRoom,
  // não mais renderizada (e portanto não mais duplicada) dentro de
  // cada tela. O botão abaixo só abre/fecha o estado compartilhado
  // (chat.agendaOpen).

  return (
    <div className="room-and-editor">
      {roomLoadingScreenMounted && (
        <RoomLoadingScreen ready={roomAssetsReady} onExited={() => setRoomLoadingScreenMounted(false)} />
      )}
      {/* 29/set (8), pedido do Douglas: "Aumente o X 1/3 / deixe o
          tower na altura exatra do X / clicavel, o X se mantem quando
          entra na sala, e ele vira um link de retorno pro lobby" --
          depois (29/set (14)): "cade o balao branco quadrado com
          bordas arredondadas?? nao ta nem na mesma posicao nem no
          mesmo tamanho" -- a primeira versão usava só o traço do X
          (logo-x-light.png) dentro de um balão redondo translúcido
          (bolha "vidro" tipo av-bar). Trocado pelo ÍCONE de verdade
          do app (public/logo-x-badge.png -- MESMA imagem de
          app/icon.png, o favicon/ícone que Douglas desenhou: já é o
          quadrado branco de cantos arredondados com o X escuro
          dentro, cantos de fora transparentes) -- sem precisar de
          fundo/borda própria aqui, a imagem já É o selo inteiro.
          onBackToLobby vem de app/page.tsx (troca `entered` de volta
          pra false). */}
      {onBackToLobby && (
        <button type="button" className="room-logo-home-btn" onClick={onBackToLobby} title="Voltar pro Lobby">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-x-dark.png" alt="Voltar pro Lobby" className="room-logo-home-mark" />
        </button>
      )}
      {/* pedido do Douglas, 30/set: "esse card, mantenha ele em toda
          tela que o usuario vai inclusive no jogo" -- MESMO
          <AccountCard /> que já existia só no Lobby (ver
          components/Lobby.tsx), agora fixo aqui no canto igual o
          logo/botão de voltar do lado esquerdo (ver
          .room-account-card-pin). */}
      <div className="room-account-card-pin">
        <AccountCard
          accountUserId={accountUserId}
          accountProfile={accountProfile}
          accountAccessToken={accountAccessToken}
          onStartConversation={(targetUserId) => startDirectWith(targetUserId)}
          onSignOut={onSignOut}
        />
      </div>
      {/* pedido do Douglas, 30/set (9): "coloque o sair da conta dentro
          das opcoes que abrem clicando no balao foto+nome, por ultimo,
          e em texto vermelho" -- morava aqui, um botão avulso (que
          inclusive colidia visualmente com o catálogo depois do
          "Editar espaço" ficar mais largo), agora é o último item do
          menu do <AccountCard /> acima (ver comentário grande lá). */}
      {chatOpen && chatPinMode === "side" && <ChatDrawer {...chatDrawerProps} />}
      <div className="room-wrapper">
        <div ref={containerRef} className="phaser-container" />

        {areaDestituirPrompt && (
          <AreaConfirmBalloon
            innerRef={areaDestituirBalloonRef}
            message={areaDestituirPrompt.message}
            onYes={() => sceneRef.current?.confirmDestituir(areaDestituirPrompt.areaId)}
            onNo={() => sceneRef.current?.cancelDestituir()}
          />
        )}

        {areaClaimPrompt && (
          <AreaConfirmBalloon
            innerRef={areaClaimBalloonRef}
            message={areaClaimPrompt.message}
            onYes={() => sceneRef.current?.confirmAreaClaim(areaClaimPrompt.areaId)}
            onNo={() => sceneRef.current?.cancelAreaClaim()}
          />
        )}

        {areaOwnerHoverCard && (
          <AreaOwnerHoverCard
            innerRef={areaOwnerHoverCardRef}
            remoteProfile={remoteProfiles[areaOwnerHoverCard.playerId]}
            onMouseEnter={cancelHideAreaOwnerHoverCard}
            onMouseLeave={scheduleHideAreaOwnerHoverCard}
            onProfile={() => {
              const playerId = areaOwnerHoverCard.playerId;
              closeAreaOwnerHoverCardNow();
              setProfileCard({ playerId, isLocal: false });
            }}
            onCallOver={() => {
              sendPoke(areaOwnerHoverCard.playerId, "call");
              closeAreaOwnerHoverCardNow();
            }}
            onAskAvailable={() => {
              sendPoke(areaOwnerHoverCard.playerId, "available");
              closeAreaOwnerHoverCardNow();
            }}
            onSendMessage={() => {
              sendMessageTo(areaOwnerHoverCard.playerId);
              closeAreaOwnerHoverCardNow();
            }}
          />
        )}

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
            defaultReferences={defaultReferences}
            selectedBeardId={selectedBeardId}
            onSelectBeard={selectBeard}
            selectedAccessoryId={selectedAccessoryId}
            onSelectAccessory={selectAccessory}
            selectedAccessoryColorId={selectedAccessoryColorId}
            onSelectAccessoryColor={selectAccessoryColor}
            selectedOutfitId={selectedOutfitId}
            onSelectOutfit={selectOutfit}
            selectedOutfitColorId={selectedOutfitColorId}
            onSelectOutfitColor={selectOutfitColor}
            editorCategory={editorCategory}
            onSelectCategory={setEditorCategory}
            measuredHeight={profileCardHeight}
            onMeasuredHeight={setProfileCardHeight}
            onAskAvailable={() => sendPoke(profileCard.playerId, "available")}
            onCallOver={() => sendPoke(profileCard.playerId, "call")}
            onSendMessage={() => sendMessageTo(profileCard.playerId)}
            onSendNote={(text) => sendNote(profileCard.playerId, text)}
          />
        )}

        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.text}
            </div>
          ))}
        </div>

        {(camOn || screenOn) && (
          <video ref={localVideoRef} autoPlay muted playsInline className="local-video" />
        )}

        <RemoteVideosLayer
          remoteStreams={remoteStreams}
          remoteVolumes={remoteVolumes}
          spaceVolume={spaceVolume}
          selectedSpeakerId={selectedSpeakerId}
          metaSetterRef={remoteMetaSetterRef}
        />

        <div className="status-badge">{status}</div>

        {presenceCounts && (
          <div className="presence-badge" title="Quem tá na sala agora">
            {presenceCounts.memberCount} membro{presenceCounts.memberCount === 1 ? "" : "s"} · {presenceCounts.visitorCount}{" "}
            visitante{presenceCounts.visitorCount === 1 ? "" : "s"}
          </div>
        )}

        <div className="controls">
          {roomSlug === "mapa-publicado" && isCurrentRoomOwner && (
            <button
              className="av-btn"
              onClick={() => setMembersPanelOpen(true)}
              aria-label="Configurar membros da sala"
              data-tooltip="Membros"
            >
              <UsersIcon />
            </button>
          )}
          {isPlatformAdmin && (
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
            onItemsChanged={(seatModelIdToClear) => {
              // Douglas: "a planta que cadastrei, adicionei varias
              // posicoes dela em frente esq frente dir, e no catalogo
              // clicando em girar, nao funciona" -- selectedCatalogIndex
              // é um ÍNDICE cru dentro de FURNITURE_CATALOG (ver
              // useState mais acima), mas registerCustomFurnitureModels
              // (chamado por fetchAndRegisterCustomFurniture logo
              // abaixo, disparado toda vez que o Editor de Itens salva
              // algo) RECONSTRÓI do zero as entradas do modelo editado
              // (splice + push no fim, ver comentário grande em
              // game/furniture.ts) -- editar um item JÁ selecionado no
              // catálogo (ex: voltar e subir mais uma direção de arte)
              // faz o array inteiro deslizar, então o índice antigo
              // passa a apontar pra OUTRA entrada (ou pra nenhuma). Daí
              // canRotate/rotateSelected (calculados em cima de
              // catalogEntryGroupKey(selectedEntry), EditPanel mais
              // abaixo) passavam a enxergar o grupo errado -- às vezes
              // um grupo de 1 direção só, sem nada pra girar. Guarda
              // modelId+facing do item selecionado ANTES do refetch (a
              // única forma estável de achar "a mesma entrada" depois
              // que o array já mudou de posição) pra reencontrar o novo
              // índice quando a promise resolver.
              const selectedBefore =
                selectedCatalogIndex !== null ? FURNITURE_CATALOG[selectedCatalogIndex] : null;
              const selectedModelId = selectedBefore?.modelId;
              const selectedFacing = selectedBefore?.facing;

              const furnitureRefreshed = fetchAndRegisterCustomFurniture();
              fetchAndRegisterCustomFloor();
              fetchAndRegisterCustomWall();
              fetchAndRegisterCustomDoor();
              fetchAndRegisterCustomSkins();
              fetchAndRegisterCustomAvatarItems();
              fetchDefaultReferences();

              if (selectedModelId) {
                furnitureRefreshed.finally(() => {
                  // mesma direção que tava selecionada, na entrada NOVA
                  // (mesmo modelId+facing, índice pode ter mudado).
                  const sameDirection = FURNITURE_CATALOG.findIndex(
                    (e) => e.modelId === selectedModelId && e.facing === selectedFacing
                  );
                  if (sameDirection !== -1) {
                    setSelectedCatalogIndex(sameDirection);
                    return;
                  }
                  // a direção selecionada não existe mais (ex: removida
                  // na edição) -- cai pra primeira direção que sobrou
                  // desse modelo, ou limpa a seleção se o modelo inteiro
                  // sumiu.
                  const fallback = FURNITURE_CATALOG.findIndex((e) => e.modelId === selectedModelId);
                  setSelectedCatalogIndex(fallback !== -1 ? fallback : null);
                });
              }
              // Douglas: "eu fui editar ela pra posicionar o carinha
              // melhor e ficou assim -- no editor ta certo no mapa real
              // nao ficou" -- ver comentário grande em
              // clearSeatOffsetsForModel (MainScene.ts) e em
              // handleSubmit (ItemEditor.tsx) pro porquê: um ajuste
              // "Assento" salvo POR CIMA na sala (seatOffsets) escondia
              // o seat_offset_x/y novo que acabou de ser salvo no
              // modelo. Limpa nos dois lugares -- na cena AO VIVO (pra
              // valer na hora, sem F5) e no estado React (seatOffsets),
              // que já autosalva sozinho (ver useEffect combinado de
              // mobília+assento mais abaixo, depende de [draftItems,
              // seatOffsets]).
              //
              // "continua torto" (2ª rodada): esse bloco rodava ANTES
              // de fetchAndRegisterCustomFurniture() terminar (chamada
              // sem await, só disparada) -- clearSeatOffsetsForModel já
              // reposicionava quem tava sentado, só que com o MODELO
              // AINDA velho em FURNITURE_MODELS (seat_offset_x/y novo
              // só chega depois do fetch+registerCustomFurnitureModels
              // resolver). Agora espera essa promise terminar antes de
              // reposicionar, pra pegar o valor fresco de verdade.
              if (seatModelIdToClear) {
                furnitureRefreshed.finally(() => {
                  sceneRef.current?.clearSeatOffsetsForModel(seatModelIdToClear);
                  setSeatOffsetsState((prev) => {
                    if (!(seatModelIdToClear in prev)) return prev;
                    const next = { ...prev };
                    delete next[seatModelIdToClear];
                    return next;
                  });
                });
              }
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
            {/* 29/set (14), pedido do Douglas: "gostei da forma de
                mostrar que tem mensagem, mantenha / mas nao esta
                funcionando" -- mesma marcação vermelha que o Lobby já
                tinha (ver .lobby-badge-wrap/.lobby-icon-badge em
                app/globals.css, reaproveitada aqui igual pedido de
                sempre "quero X igual a Y"), só que de dentro da sala
                não existia NENHUMA ainda. Soma real (unreadCount de
                cada conversa, ver server/chatStore.js), não mais
                quantidade de conversa. */}
            <span className="lobby-badge-wrap">
              <ChatIcon />
              {chat.totalUnreadMessages > 0 && <span className="lobby-icon-badge">{chat.totalUnreadMessages}</span>}
            </span>
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
            className={contactsOpen ? "av-btn on" : "av-btn"}
            onClick={() => setContactsOpen((v) => !v)}
            aria-label={contactsOpen ? "Fechar amigos" : "Abrir amigos"}
            data-tooltip={contactsOpen ? "Fechar amigos" : "Amigos"}
          >
            <ContactsIcon />
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
        {contactsOpen && (
          <FriendsPanel
            accountAccessToken={accountAccessToken}
            onStartConversation={(targetUserId) => startConversationFromContacts(targetUserId)}
            onClose={() => setContactsOpen(false)}
          />
        )}
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
            remoteUsers={Object.keys(remoteStreams).map((id) => ({
              id,
              // nome vem do ref (não de estado React, ver comentário em
              // remoteMetaSetterRef acima) -- painel de Configurações só
              // reabre de vez em quando, não precisa de nome "ao vivo"
              // atualizando a cada frame igual a distância nos vídeos.
              name: remotePlayersRef.current.get(id)?.name || "Jogador",
            }))}
            remoteVolumes={remoteVolumes}
            onChangeRemoteVolume={changeRemoteVolume}
            callVolume={callVolume}
            onChangeCallVolume={setCallVolume}
            notificationPrefs={notificationPrefs}
            onChangeNotificationPrefs={setNotificationPrefs}
          />
        )}
        <input
          ref={chatFileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleChatFileChange}
        />
      </div>

      {canEditRoom && editMode && (
        <EditPanel
          activeCategory={activeCategory}
          onChangeCategory={changeCategory}
          isPlatformAdmin={isPlatformAdmin}
          selectedRoomShapeToolId={selectedRoomShapeToolId}
          onSelectRoomShapeAdd={selectRoomShapeAdd}
          onSelectRoomShapeErase={selectRoomShapeErase}
          draftRoomShapeItems={draftRoomShapeItems}
          roomShapeSaveStatus={roomShapeSaveStatus}
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
          selectedWallToolId={selectedWallToolId}
          onSelectWallPaint={selectWallPaint}
          onSelectWallEraser={selectWallEraser}
          draftWallItems={draftWallItems}
          onClearAllWall={clearDraftWallItems}
          wallSaveStatus={wallSaveStatus}
          wallPlacementMode={wallPlacementMode}
          onSelectWallPlacementMode={selectWallPlacementMode}
          wallCenterOrientation={wallCenterOrientation}
          onSelectWallCenterOrientation={selectWallCenterOrientation}
          selectedDoorToolId={selectedDoorToolId}
          onSelectDoorPaint={selectDoorPaint}
          onSelectDoorEraser={selectDoorEraser}
          draftDoorItems={draftDoorItems}
          onClearAllDoor={clearDraftDoorItems}
          doorSaveStatus={doorSaveStatus}
          doorFacing={doorFacing}
          onToggleDoorFacing={toggleDoorFacing}
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
// FurnitureFacing (não Direction puro) só por causa do tipo de
// seatTuningInfo.facing (ver game/furniture.ts) -- na prática nunca
// chega "quina de cima/baixo" aqui, parede não senta, mas o tipo
// precisa aceitar pra indexar sem erro de compilação.
const FACING_LABEL: Record<FurnitureFacing, string> = {
  down: "frente",
  left: "lado esq.",
  right: "lado dir.",
  up: "costas",
  cornerTop: "quina de cima",
  cornerBottom: "quina de baixo",
};

const EDIT_CATEGORY_TABS: {
  id: FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho";
  label: string;
  icon: () => JSX.Element;
}[] = [
  { id: "poltrona", label: "Poltrona", icon: ArmchairIcon },
  { id: "sofa", label: "Sofá", icon: SofaIcon },
  { id: "mesa", label: "Mesa", icon: TableIcon },
  { id: "planta", label: "Planta", icon: PlantIcon },
  { id: "computador", label: "Computador", icon: ComputerIcon },
  // era "Divisória" -- pedido do Douglas: essa categoria (tipo "vidro",
  // ver FURNITURE_TYPE_CATEGORY em game/furniture.ts) vivia sozinha
  // dentro da seção "Mapa" com o rótulo "Parede" (ver EDIT_SECTIONS/
  // CATEGORY_SECTION abaixo) -- MESMO sistema de sempre (objeto que
  // bloqueia passagem, ver FURNITURE_BLOCKS_MOVEMENT.vidro). Rebatizada
  // de volta pro nome original ("Divisória") agora que "Parede" virou o
  // rótulo da aba NOVA logo abaixo (a parede de sistema de verdade que o
  // Douglas pediu) -- as duas continuam na mesma seção "Mapa", só que
  // agora com 2 abas em vez de 1 (ver categoryTabsInSection dentro de
  // EditPanel: com >1 categoria na seção, a barrinha de sub-abas aparece
  // sozinha, sem precisar de nenhum layout novo).
  { id: "divisoria", label: "Divisória", icon: DividerIcon },
  // parede de SISTEMA (ver game/wall.ts) -- pedido do Douglas: "paredes
  // de sistema igual o piso, mesma ideia do habbo... essa opção de
  // parede aí, eu quero ela LÁ no catálogo". Pinta ARESTA da grade (não
  // um tile inteiro, ver WallSegmentDef), por isso tem painel próprio
  // (activeCategory === "parede-sistema" mais abaixo) em vez de cair no
  // fluxo genérico de FURNITURE_CATALOG das outras abas.
  { id: "parede-sistema", label: "Parede", icon: WallIcon },
  // porta -- pedido do Douglas: "vamos criar uma nova categoria 'porta'"
  // (ver comentário grande no topo de game/door.ts). Mesma ideia de
  // "Parede" logo acima: pinta ARESTA da grade, painel próprio
  // (activeCategory === "porta" mais abaixo), mesma seção "Mapa".
  { id: "porta", label: "Porta", icon: DoorIcon },
  { id: "piso", label: "Piso", icon: FloorIcon },
  { id: "area", label: "Área", icon: AreaIcon },
  // "Tamanho": aumenta/diminui a sala (GRID_COLS/GRID_ROWS, ver
  // game/grid.ts) -- pedido do Douglas: "eu quero aumentar ou diminuir
  // a sala, adicionando NOVOS tiles". Mesma seção "Piso" (construir),
  // painel próprio (activeCategory === "tamanho" mais abaixo) sem
  // paleta nenhuma pra procurar -- só os controles +/- de largura/altura.
  { id: "tamanho", label: "Tamanho", icon: ResizeIcon },
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
  defaultCategory: FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho";
}[] = [
  // rótulos ajustados a pedido do Douglas: "Minha mesa"->"Mobília",
  // "Construir"->"Piso", "Mapa"->"Parede" (ids internos continuam os
  // mesmos, só o texto exibido mudou). defaultCategory da seção "mapa"
  // trocou de "divisoria" pra "parede-sistema" -- clicar na seção
  // "Parede" agora abre direto na ferramenta de pintar parede de
  // sistema (o pedido de verdade do Douglas), com "Divisória" (o objeto
  // de vidro que já existia) acessível pela sub-aba ao lado.
  { id: "moveis", label: "Mobília", icon: DeskIcon, defaultCategory: "poltrona" },
  { id: "construir", label: "Piso", icon: BuildIcon, defaultCategory: "piso" },
  { id: "mapa", label: "Parede", icon: MapIcon, defaultCategory: "parede-sistema" },
];

// categoria -> seção (inverso de EDIT_SECTIONS[].defaultCategory, mas
// com TODAS as categorias de cada seção, não só a padrão). "assento"
// entra em "moveis" -- é ajuste fino de móvel sentável, não faz sentido
// em outra seção.
const CATEGORY_SECTION: Record<
  FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho",
  "moveis" | "construir" | "mapa"
> = {
  poltrona: "moveis",
  sofa: "moveis",
  mesa: "moveis",
  planta: "moveis",
  computador: "moveis",
  assento: "moveis",
  piso: "construir",
  area: "construir",
  tamanho: "construir",
  divisoria: "mapa",
  "parede-sistema": "mapa",
  porta: "mapa",
};

function EditPanel({
  activeCategory,
  onChangeCategory,
  isPlatformAdmin,
  selectedRoomShapeToolId,
  onSelectRoomShapeAdd,
  onSelectRoomShapeErase,
  draftRoomShapeItems,
  roomShapeSaveStatus,
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
  selectedWallToolId,
  onSelectWallPaint,
  onSelectWallEraser,
  draftWallItems,
  onClearAllWall,
  wallSaveStatus,
  wallPlacementMode,
  onSelectWallPlacementMode,
  wallCenterOrientation,
  onSelectWallCenterOrientation,
  selectedDoorToolId,
  onSelectDoorPaint,
  onSelectDoorEraser,
  draftDoorItems,
  onClearAllDoor,
  doorSaveStatus,
  doorFacing,
  onToggleDoorFacing,
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
  activeCategory: FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho";
  onChangeCategory: (
    category: FurnitureCategoryId | "piso" | "area" | "assento" | "parede-sistema" | "porta" | "tamanho"
  ) => void;
  selectedRoomShapeToolId: "add" | "erase" | null;
  onSelectRoomShapeAdd: () => void;
  onSelectRoomShapeErase: () => void;
  draftRoomShapeItems: { col: number; row: number }[];
  roomShapeSaveStatus: "idle" | "saving" | "saved" | "error";
  // Douglas (28/set): "retire essa opcao do catalogo, nao quero que os
  // clientes mexam nisso" -- ver comentário grande em EDIT_CATEGORY_TABS
  // (a aba "Assento" ajusta o MODELO inteiro no catálogo GLOBAL, não só
  // a peça dessa sala; servidor já travava isso em app/api/items/[id]
  // via isPlatformAdmin, só a ABA continuava visível pra qualquer dono
  // de sala). Some da lista de categorias pra quem não é admin da
  // plataforma.
  isPlatformAdmin: boolean;
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
  selectedWallToolId: string | "erase" | null;
  onSelectWallPaint: (entry: WallCatalogEntry) => void;
  onSelectWallEraser: () => void;
  draftWallItems: WallSegmentDef[];
  onClearAllWall: () => void;
  wallSaveStatus: "idle" | "saving" | "saved" | "error";
  wallPlacementMode: "edge" | "center";
  onSelectWallPlacementMode: (mode: "edge" | "center") => void;
  wallCenterOrientation: "center" | "centerRow";
  onSelectWallCenterOrientation: (orientation: "center" | "centerRow") => void;
  selectedDoorToolId: string | "erase" | null;
  onSelectDoorPaint: (entry: DoorCatalogEntry) => void;
  onSelectDoorEraser: () => void;
  draftDoorItems: DoorSegmentDef[];
  onClearAllDoor: () => void;
  doorSaveStatus: "idle" | "saving" | "saved" | "error";
  doorFacing: DoorFacing;
  onToggleDoorFacing: () => void;
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
  const categoryTabsInSection = EDIT_CATEGORY_TABS.filter(
    (cat) => CATEGORY_SECTION[cat.id] === activeSection && (cat.id !== "assento" || isPlatformAdmin)
  );

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
  const filteredWallCatalog = normalizedQuery
    ? WALL_CATALOG.filter((entry) => entry.label.toLowerCase().includes(normalizedQuery))
    : WALL_CATALOG;
  const filteredDoorCatalog = normalizedQuery
    ? DOOR_CATALOG.filter((entry) => entry.label.toLowerCase().includes(normalizedQuery))
    : DOOR_CATALOG;
  // comprimento de UMA aresta da grade, só pro thumbnail do padrão de
  // parede na paleta abaixo -- mesma constante/motivo de
  // WALL_PREVIEW_EDGE_LENGTH_PX em ItemEditor.tsx.
  const wallPreviewEdgeLengthPx = wallEdgeLengthPx(0, 0, "colPlus");

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
    activeCategory === "piso" ||
    activeCategory === "area" ||
    activeCategory === "assento" ||
    activeCategory === "parede-sistema" ||
    activeCategory === "porta"
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

      {activeCategory === "tamanho" && (
        <>
          <p className="edit-hint">
            "Adicionar" pinta um tile NOVO encostado na sala (fora do
            limite de hoje conta -- é assim que ela cresce). "Apagar"
            tira um tile já pintado (bloqueado se tiver piso, móvel,
            parede, porta ou área nele, ou se isso separasse a sala em
            duas partes). Salva sozinho.
          </p>
          <div className="room-shape-tool-row">
            <button
              type="button"
              className={selectedRoomShapeToolId === "add" ? "room-shape-tool-btn selected" : "room-shape-tool-btn"}
              onClick={onSelectRoomShapeAdd}
            >
              <PlusIcon />
              Adicionar
            </button>
            <button
              type="button"
              className={selectedRoomShapeToolId === "erase" ? "room-shape-tool-btn selected" : "room-shape-tool-btn"}
              onClick={onSelectRoomShapeErase}
            >
              <TrashIcon />
              Apagar
            </button>
          </div>
          <p className="edit-hint">{draftRoomShapeItems.length} quadrados na sala hoje.</p>
          {roomShapeSaveStatus === "error" && (
            <p className="edit-hint">Não deu pra salvar -- tenta de novo.</p>
          )}
        </>
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
                // piso "padrão" (ver FloorPatternConfig em game/floor.ts)
                // não tem imagem nenhuma pra usar de miniatura -- desenha
                // os MESMOS polígonos do jogo de verdade via
                // <FloorPatternSwatch> (ver floorPatternPolygons em
                // game/floor.ts), não uma aproximação.
                style={entry.pattern ? undefined : { backgroundImage: `url(${furnitureAssetUrl(entry.file)})` }}
                onClick={() => onSelectFloorPaint(entry)}
                title={entry.label}
              >
                {entry.pattern && <FloorPatternSwatch pattern={entry.pattern} />}
              </button>
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
      ) : activeCategory === "parede-sistema" ? (
        <>
          {/* parede de sistema (ver game/wall.ts) -- MESMA ideia/estrutura
              do painel de piso acima, só que pintando uma ARESTA da grade
              em vez de um quadrado inteiro (ver nearestWallEdge em
              MainScene.ts, e o destaque em linha verde que segue o cursor
              -- o "tile verde" do desenho de referência do Douglas). */}
          <p className="edit-hint">
            Escolha um estilo abaixo e clique numa BORDA entre dois quadrados
            da sala pra levantar a parede ali ("unitário"), ou clique e
            arraste pra levantar vários segmentos de uma vez. Pode ficar em
            qualquer lugar da sala, não só na borda dela. "Apagar parede"
            derruba o segmento. Salva sozinho.
          </p>

          {/* modo de inserção -- pedido do Douglas: "eu quero tambem a
              opcao de inserir ela no centro do tile" -- "Borda" é o
              comportamento de sempre (decorativo, não trava passagem);
              "Centro do tile" planta a parede dentro do próprio quadrado
              e TRAVA o caminho por ali (ver isMovementBlockedAt em
              MainScene.ts -- "no centro do tile, ela tem que bloquear o
              caminhar dai, no canto nao bloqueia"). */}
          <div className="wall-placement-mode-toggle">
            <button
              type="button"
              className={wallPlacementMode === "edge" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"}
              onClick={() => onSelectWallPlacementMode("edge")}
              title="Planta na borda entre 2 quadrados (não trava passagem)"
            >
              Borda
            </button>
            <button
              type="button"
              className={wallPlacementMode === "center" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"}
              onClick={() => onSelectWallPlacementMode("center")}
              title="Planta no meio do quadrado (trava passagem ali)"
            >
              Centro do tile
            </button>
          </div>

          {/* orientação do pilar "Centro do tile" -- pedido posterior do
              Douglas: "as paredes de centro de tile precisam poder nas
              duas direcoes, so ta em uma". Só aparece nesse modo (na
              "Borda" a orientação já vem do lado clicado, não tem o que
              escolher aqui). "/" e "\" marcam as 2 diagonais possíveis
              do losango (ver WallSide em game/wall.ts: "center" segue
              colPlus, "centerRow" segue rowPlus) -- pilares na mesma
              orientação+estilo em tiles vizinhos na direção certa
              emendam retos (ver wallJunctionAt em MainScene.ts). */}
          {wallPlacementMode === "center" && (
            <div className="wall-placement-mode-toggle">
              <button
                type="button"
                className={
                  wallCenterOrientation === "center" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"
                }
                onClick={() => onSelectWallCenterOrientation("center")}
                title="Diagonal igual à parede de Borda 'colPlus' (\\)"
              >
                {"\\"}
              </button>
              <button
                type="button"
                className={
                  wallCenterOrientation === "centerRow" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"
                }
                onClick={() => onSelectWallCenterOrientation("centerRow")}
                title="Diagonal igual à parede de Borda 'rowPlus' (/)"
              >
                {"/"}
              </button>
            </div>
          )}

          <button
            className={selectedWallToolId === "erase" ? "floor-erase-standalone-btn selected" : "floor-erase-standalone-btn"}
            onClick={onSelectWallEraser}
            title="Apagar segmento de parede"
          >
            <TrashIcon />
            Apagar parede
          </button>

          <input
            type="search"
            className="catalog-search-input"
            placeholder="Pesquisar paredes"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="floor-palette">
            {filteredWallCatalog.map((entry) => (
              <button
                key={entry.id}
                className={selectedWallToolId === entry.id ? "floor-swatch selected" : "floor-swatch"}
                // parede "padrão" (ver WallPatternConfig em game/wall.ts)
                // não tem imagem nenhuma pra usar de miniatura -- desenha
                // o mesmo tijolo + argamassa + faixa de espessura (cor
                // sólida clareada) do jogo de verdade via
                // <WallPatternSwatch>, mesma ideia de
                // FloorPatternSwatch acima (achado testando ao vivo: sem
                // isso, o estilo cadastrado pela aba "Criar Parede"
                // entrava no catálogo mas ficava com o botão em branco --
                // sem imagem nenhuma pro background-image de sempre
                // mostrar -- então "sumia" da paleta na prática).
                style={entry.pattern ? undefined : { backgroundImage: `url(${furnitureAssetUrl(entry.file)})` }}
                onClick={() => onSelectWallPaint(entry)}
                title={entry.label}
              >
                {entry.pattern && <WallPatternSwatch pattern={entry.pattern} edgeLengthPx={wallPreviewEdgeLengthPx} />}
              </button>
            ))}
          </div>
          {filteredWallCatalog.length === 0 && (
            <p className="edit-hint">
              {normalizedQuery
                ? `Nada encontrado pra "${searchQuery.trim()}".`
                : "Nenhum modelo de parede ainda -- suba as imagens na pasta de origem."}
            </p>
          )}

          <h3>
            Parede levantada ({draftWallItems.length})
            <span className={`floor-save-status floor-save-status-${wallSaveStatus}`}>
              {wallSaveStatus === "saving" && "Salvando…"}
              {wallSaveStatus === "saved" && "Salvo ✓"}
              {wallSaveStatus === "error" && "Erro ao salvar"}
            </span>
          </h3>
          {draftWallItems.length === 0 && <p className="edit-hint">Nenhum segmento levantado ainda.</p>}
          {draftWallItems.length > 0 && (
            <button className="clear-btn" onClick={onClearAllWall}>
              Limpar tudo
            </button>
          )}
        </>
      ) : activeCategory === "porta" ? (
        <>
          {/* porta (ver game/door.ts) -- MESMA estrutura do painel de
              parede acima (pinta uma ARESTA da grade), só que em vez do
              modo de inserção tem o LADO da arte (esquerdo/direito,
              escolhido ANTES de posicionar, igual girar um móvel) e ela
              abre/fecha sozinha (proximidade) ou por travamento do dono
              da área que ela guarda -- ver comentário grande no topo de
              game/door.ts. */}
          <p className="edit-hint">
            Escolha um modelo abaixo e clique numa BORDA entre dois quadrados
            da sala pra encaixar a porta ali. Ela abre sozinha quando alguém
            se aproxima e fecha ao afastar; o dono da área que ela guarda (se
            houver) pode travar/destravar clicando nela. "Apagar porta"
            derruba o segmento. Salva sozinho.
          </p>

          <div className="wall-placement-mode-toggle">
            <button
              type="button"
              className={doorFacing === "left" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"}
              onClick={() => doorFacing !== "left" && onToggleDoorFacing()}
              title="Usar a arte do lado esquerdo"
            >
              Lado esquerdo
            </button>
            <button
              type="button"
              className={doorFacing === "right" ? "wall-placement-mode-btn selected" : "wall-placement-mode-btn"}
              onClick={() => doorFacing !== "right" && onToggleDoorFacing()}
              title="Usar a arte do lado direito"
            >
              Lado direito
            </button>
          </div>

          <button
            className={selectedDoorToolId === "erase" ? "floor-erase-standalone-btn selected" : "floor-erase-standalone-btn"}
            onClick={onSelectDoorEraser}
            title="Apagar segmento de porta"
          >
            <TrashIcon />
            Apagar porta
          </button>

          <input
            type="search"
            className="catalog-search-input"
            placeholder="Pesquisar portas"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <div className="floor-palette">
            {filteredDoorCatalog.map((entry) => {
              const art = entry.art[doorFacing] ?? entry.art.left ?? entry.art.right;
              return (
                <button
                  key={entry.id}
                  className={selectedDoorToolId === entry.id ? "floor-swatch selected" : "floor-swatch"}
                  style={art ? { backgroundImage: `url(${furnitureAssetUrl(art.closed)})` } : undefined}
                  onClick={() => onSelectDoorPaint(entry)}
                  title={entry.label}
                />
              );
            })}
          </div>
          {filteredDoorCatalog.length === 0 && (
            <p className="edit-hint">
              {normalizedQuery
                ? `Nada encontrado pra "${searchQuery.trim()}".`
                : 'Nenhum modelo de porta ainda -- suba a arte na aba "Criar Porta".'}
            </p>
          )}

          <h3>
            Porta encaixada ({draftDoorItems.length})
            <span className={`floor-save-status floor-save-status-${doorSaveStatus}`}>
              {doorSaveStatus === "saving" && "Salvando…"}
              {doorSaveStatus === "saved" && "Salvo ✓"}
              {doorSaveStatus === "error" && "Erro ao salvar"}
            </span>
          </h3>
          {draftDoorItems.length === 0 && <p className="edit-hint">Nenhuma porta encaixada ainda.</p>}
          {draftDoorItems.length > 0 && (
            <button className="clear-btn" onClick={onClearAllDoor}>
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
            posse" na sala (só aparece enquanto ninguém for dono). Nas 3 --
            "Mesa privada", "Sala privada" e "Sala aberta" -- áudio/vídeo de
            quem tá dentro fica isolado do resto da sala (só ouve/é ouvido por
            quem também tá na mesma área); só "Mesa privada" tem dono, as
            outras duas são só pra organizar/colorir o mapa diferente. Salva
            sozinho.
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
      ) : activeCategory === "assento" && isPlatformAdmin ? (
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

// ícone da aba "Parede" (parede de SISTEMA, ver EDIT_CATEGORY_TABS/
// game/wall.ts) -- tijolos emparelhados (fileiras alternadas, padrão
// clássico de alvenaria), pra diferenciar visualmente da "Divisória"
// (2 painéis lisos, ícone acima).
function WallIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="2.5" y="3" width="19" height="18" rx="1.4" />
      {/* fileiras "amarradas" (running bond) -- 2 divisórias horizontais
          + verticais desencontradas por fileira, padrão clássico de
          tijolo. */}
      <path d="M2.5 9h19M2.5 15h19M8.5 3v6M14.5 3v6M5.5 9v6M11.5 9v6M17.5 9v6M8.5 15v6M14.5 15v6" />
    </svg>
  );
}

// ícone da aba "Porta" (ver EDIT_CATEGORY_TABS/game/door.ts) -- vão de
// porta (moldura) com uma folha deslizada pro lado, pra remeter à porta
// de correr (a única variante que existe hoje, ver DOOR_KINDS), bem
// diferente visualmente de "Parede" (tijolos, ícone acima).
function DoorIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="19" height="19" rx="1.4" />
      <path d="M2.5 21V9M21.5 21V9" />
      <rect x="10.5" y="9" width="7" height="12" fill="currentColor" opacity="0.55" stroke="none" />
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

// ícone da aba "Tamanho" (ver EDIT_CATEGORY_TABS) -- um quadrado com
// setas apontando pra fora nos 2 cantos opostos (expandir/encolher),
// pra diferenciar visualmente de "Área" (quadrado tracejado com alvo).
function ResizeIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="6" y="6" width="12" height="12" rx="1.6" />
      <path d="M14 3.5h6.5V10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3.5 14.5 10" strokeLinecap="round" />
      <path d="M10 20.5H3.5V14" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 20.5 9.5 14" strokeLinecap="round" />
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
// AvatarPreviewLayer), igual ao editor de personagem do Habbo. Pedido
// do Douglas: "aumenta o avatar, ele pode dobrar de tamanho na
// exibicao" -- 176x228.8 -> 352x457.6, o DOBRO (mesma proporção
// 200:260 de sempre). Cabe na coluna do boneco (.profile-edit-avatar-col
// -- flex-shrink:0, só encolhe o que sobra pras abas+grade do lado).
// Depois ficou grande demais de novo (pedido do Douglas: "esse e o
// editar ele ta na proporcao errada la, diminui" / "diminui 10% dele")
// -- 352x457.6 -> 316.8x411.84, 10% menor, mesma proporção 200:260.
const AVATAR_PREVIEW_W = 316.8;
const AVATAR_PREVIEW_H = 411.84; // mantém a proporção 200:260 do frame


// pedido do Douglas: "pra todos os itens eu tenho que subir os 4 lados
// [...] o cara tem que poder ver o boneco dele em 4 lados também em
// personalizar, apenas as posições paradas" -- deixa o boneco fixo do
// editor girar entre as 4 direções (setas do lado, ver
// avatar-preview-rotate-wrap), sempre no frame PARADO de cada uma
// (índice 0 de cada trinca -- mesmo esquema de WALK_FRAMES em
// MainScene.ts, "andando" fica só pro boneco de verdade na sala).
// Frame -> coluna/linha da folha 8x2 (FRAME_W/FRAME_H/spacing:2, ver
// frameOffsetXPx/frameOffsetYPx em ItemEditor.tsx, mesma conta).
const PREVIEW_DIRECTION_FRAME: Record<Direction, number> = { down: 0, left: 3, right: 6, up: 9 };
// ordem do "girar" (seta ›): frente -> lado direito -> costas -> lado
// esquerdo -> frente nesse ciclo (a seta ‹ anda o ciclo ao contrário).
const PREVIEW_DIRECTION_ORDER: Direction[] = ["down", "right", "up", "left"];

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

// Card genérico de confirmação de área -- usado tanto pro balão
// "destituir mesa de fulano?" (ver comentário grande de
// areaDestituirPrompt em GameRoom) quanto pro "Assumir essa mesa?" (ver
// comentário grande de areaClaimPrompt), mais o efeito de
// reposicionamento via requestAnimationFrame logo acima deles --
// puramente visual/CSS, SEM ideia nenhuma de mundo/câmera/Phaser (recebe
// só a mensagem já pronta e os callbacks de clique); quem cuida de
// "onde" é o innerRef + o efeito de posicionamento em GameRoom. Estilo
// replicado das referências que o
// Douglas mandou (card "squircle" azul-marinho escuro, painel interno
// mais escuro com o texto, botão pílula azul sólido) só que agora com
// `backdrop-filter`/`border-radius`/`box-shadow` de CSS de verdade --
// exatamente o pedido: "nao tem como ele ficar como as coisas de fora?
// afinal ele e um balao com botao" (Phaser/WebGL nunca ia conseguir essa
// suavidade, ver histórico do arquivo -- inclusive um bug real de
// triangulação de gradiente que criava um vinco/dobra visível no card
// desenhado pelo Phaser). Ancorado pela BASE via CSS
// (translate(-50%,-100%) no innerRef, ver GameRoom) -- cresce pra CIMA
// a partir do ponto ancorado, então não precisa saber a própria altura
// de antemão.
// Dois DIVs aninhados, não um só -- o de FORA (innerRef) é quem recebe o
// transform de POSIÇÃO escrito via JS a cada frame (ver efeito de
// GameRoom); o de DENTRO (.area-confirm-balloon) é quem tem a animação
// CSS de pulso (@keyframes, transform: scale). Precisam ser elementos
// DIFERENTES porque uma `animation` do CSS assume o controle total da
// propriedade `transform` do elemento (sobrepõe até um `style.transform`
// escrito via JS nesse MESMO elemento) -- juntar os dois no mesmo DIV
// faria o pulso apagar a posição a cada frame, o balão pularia pra
// (0,0).
/**
 * Tela de carregamento antes de cair na sala -- pedido do Douglas
 * (29/set): "meu acesso na pagina caindo em uma mesa aleatoria ta
 * aparecendo o balao de assumir, isos seria por um delay de
 * carregamento? / se a gente criar uma pagina de carregamento antes de
 * cair direto na sala, resolveria... inclusive assim a pessoa faz o
 * download da sala toda antes de entrar pra nao ir vendo carregando as
 * coisas aos poucos / coloque a nossa logo nessa aba de carregamento /
 * Logo X, sem o tower / ai ela desliza pra esquerda mostrando o tower,
 * como se ela tivesse escondendo ele, mesma ideia de balao branco em
 * volta igual la encima" ("la encima" = .room-logo-home-btn, ver
 * comentário grande dele em app/globals.css).
 *
 * NÃO conserta sozinho o balão "Assumir essa mesa?" aparecendo no
 * spawn (esse é bug de POSIÇÃO -- o spawn cair em cima de uma mesa
 * livre -- corrigido à parte em updateAreaDim, MainScene.ts) -- essa
 * tela só evita ver o piso/mobília/parede/porta aparecendo aos poucos
 * (ver roomAssetsReady em GameRoom.tsx, que só vira true depois que as
 * 6 buscas de estado salvo da sala já tiverem TODAS terminado).
 *
 * `slid` controla as DUAS fases da animação: false nos primeiros
 * ROOM_LOADING_LOGO_ALONE_MS (só o X, parado, ver .room-loading-mark),
 * depois vira true (X desliza, "Tower" aparece). Independente disso, a
 * tela só começa a SUMIR quando as duas coisas forem true ao mesmo
 * tempo: `ready` (prop -- as 6 buscas da sala terminaram) E
 * ROOM_LOADING_MIN_DISPLAY_MS já ter passado (pedido do Douglas, 29/set
 * (18): "deixe como padrao 10 segundo" -- vinheta de marca, não só uma
 * barreira contra pop-in, então tem duração mínima mesmo quando a sala
 * carrega rápido). Daí entra `exiting`, e essa tela mesma cuida do
 * fade-out (onTransitionEnd) antes de avisar o pai (`onExited`) pra
 * desmontar de vez -- nunca antes da transição de opacidade acabar,
 * senão sumiria seco.
 */
// 2s só com o X parado no meio, depois desliza revelando "Tower" --
// pedido do Douglas (29/set (18)): "coloque o X do tower mais tempo no
// meio... deixe como padrao 10segundo / 3 so com a logo, depois o
// texto sai" -- e (29/set (19), achou longo demais depois de ver ao
// vivo): "diminui o tempo de carregamento / 2s a logo, 5s o texto".
const ROOM_LOADING_LOGO_ALONE_MS = 2000;
// duração PADRÃO da tela inteira -- diferente do fallback de 10s lá no
// useEffect do Phaser (esse é só rede de segurança contra a sala nunca
// terminar de carregar, ver comentário grande dele, que continua 10s
// de propósito -- só a vinheta ficou mais curta). MÍNIMO de tempo que
// a tela fica visível mesmo quando a sala carrega rápido (vinheta de
// marca, não só barreira contra pop-in).
const ROOM_LOADING_MIN_DISPLAY_MS = 5000;

function RoomLoadingScreen({ ready, onExited }: { ready: boolean; onExited: () => void }) {
  // anima em 2 passos -- ver comentário grande acima: nasce com
  // slid=false (só o X, parado) por ROOM_LOADING_LOGO_ALONE_MS, depois
  // troca pra true (desliza revelando "Tower").
  const [slid, setSlid] = useState(false);
  const [exiting, setExiting] = useState(false);
  // só true depois de ROOM_LOADING_MIN_DISPLAY_MS -- a tela só começa a
  // sumir quando ISSO E `ready` (prop, sala terminou de carregar) forem
  // true AO MESMO TEMPO, não importa a ordem que cada um chega primeiro
  // (ver o useEffect logo abaixo, que depende dos dois).
  const [minDisplayElapsed, setMinDisplayElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlid(true), ROOM_LOADING_LOGO_ALONE_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setMinDisplayElapsed(true), ROOM_LOADING_MIN_DISPLAY_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (ready && minDisplayElapsed) setExiting(true);
  }, [ready, minDisplayElapsed]);
  return (
    <div
      className={exiting ? "room-loading-screen exiting" : "room-loading-screen"}
      onTransitionEnd={(e) => {
        // só o fade do PRÓPRIO overlay (opacity) marca "sumiu de vez" --
        // esse mesmo elemento recebe onTransitionEnd de QUALQUER
        // transição filha que borbulhe (ex: o slide do X, se ainda
        // estiver rolando), então confere e.target === e.currentTarget.
        if (exiting && e.target === e.currentTarget && e.propertyName === "opacity") onExited();
      }}
    >
      <div className={slid ? "room-loading-lockup slid" : "room-loading-lockup"}>
        <div className="room-loading-badge">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-x-badge.png" alt="" className="room-loading-mark" />
        </div>
        <span className="room-loading-tower">Tower</span>
      </div>
    </div>
  );
}

function AreaConfirmBalloon({
  innerRef,
  message,
  onYes,
  onNo,
}: {
  innerRef: RefObject<HTMLDivElement>;
  message: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div ref={innerRef} className="area-confirm-anchor">
      <div className="area-confirm-balloon">
        <div className="area-confirm-inner">{message}</div>
        <div className="area-confirm-buttons">
          <button type="button" className="area-confirm-btn area-confirm-btn-yes" onClick={onYes}>
            ✓ Sim
          </button>
          <button type="button" className="area-confirm-btn area-confirm-btn-no" onClick={onNo}>
            ✕ Não
          </button>
        </div>
      </div>
    </div>
  );
}

// Card "quem é o dono dessa mesa", ao passar o mouse numa mesa JÁ
// assumida (ver comentário grande de areaOwnerHoverCard/
// scene.onAreaOwnerHoverCardChange mais acima) -- pedido do Douglas com
// print de referência ("nesse estilo"): foto de perfil pequena numa
// moldura circular (sobrepondo a borda de cima do card, não o rosto
// pixelado do boneco -- pedido dele: "mas no lugar do rosto do avatar,
// a foto do perfil"), nome+bolinha de status, cargo embaixo (mesmo
// campo/mesmo texto de fallback do ProfileCard, ver profile-role),
// linha separadora, fileira de botões SÓ DE ÍCONE (sem texto, diferente
// dos botões do ProfileCard): Perfil (abre o ProfileCard de verdade,
// mesmo destino de clicar na mesa/no boneco), Chamar (sendPoke "call",
// mesma ação do botão "Chamar até você" do ProfileCard), "Posso ir
// aí?" (sendPoke "available", mesma ação do botão "Disponível?" do
// ProfileCard -- pede pra ir até a mesa da pessoa), Abrir conversa
// (sendMessageTo, mesma ação do botão "Enviar mensagem" -- abre/cria a
// conversa direta já na gaveta de chat). Nenhuma ação nova de verdade:
// as quatro já existiam pro ProfileCard, esse card só oferece um atalho
// pra elas sem precisar abrir o card grande primeiro.
function AreaOwnerHoverCard({
  innerRef,
  remoteProfile,
  onMouseEnter,
  onMouseLeave,
  onProfile,
  onCallOver,
  onAskAvailable,
  onSendMessage,
}: {
  innerRef: RefObject<HTMLDivElement>;
  remoteProfile: RemoteProfile | undefined;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onProfile: () => void;
  onCallOver: () => void;
  onAskAvailable: () => void;
  onSendMessage: () => void;
}) {
  const fields = remoteProfile ?? pickRemoteProfile(undefined);
  const status = statusMeta(fields.status);
  const displayName = fields.name || "Visitante";
  return (
    <div ref={innerRef} className="area-owner-hover-anchor">
      {/* onMouseEnter/onMouseLeave aqui (não no anchor) -- ver
          cancelHideAreaOwnerHoverCard/scheduleHideAreaOwnerHoverCard em
          GameRoom: o mouse "atravessa" da hitbox da mesa (Phaser) pro
          card de DOM por cima dela, isso conta como sair da hitbox
          (pointerout), então precisa desse hand-off pro card pra não
          fechar sozinho antes do clique num botão. */}
      <div className="area-owner-hover-card" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        <div
          className="area-owner-hover-avatar"
          style={{ backgroundImage: fields.photoUrl ? `url(${fields.photoUrl})` : undefined }}
        >
          {!fields.photoUrl && (
            <span className="area-owner-hover-avatar-fallback">{displayName.slice(0, 1).toUpperCase()}</span>
          )}
        </div>
        <div className="area-owner-hover-name-row">
          <span className="area-owner-hover-name">{displayName}</span>
          <span className="area-owner-hover-dot" style={{ background: status.dot }} title={status.label} />
        </div>
        <div className="area-owner-hover-role">{fields.role || " "}</div>
        <div className="area-owner-hover-divider" />
        <div className="area-owner-hover-actions">
          <button type="button" className="area-owner-hover-action-btn" data-tooltip="Perfil" onClick={onProfile}>
            <PersonIcon />
          </button>
          <button
            type="button"
            className="area-owner-hover-action-btn"
            data-tooltip="Chamar até você"
            onClick={onCallOver}
          >
            <ArmchairIcon />
          </button>
          <button
            type="button"
            className="area-owner-hover-action-btn"
            data-tooltip="Posso ir aí?"
            onClick={onAskAvailable}
          >
            <TableIcon />
          </button>
          <button
            type="button"
            className="area-owner-hover-action-btn"
            data-tooltip="Abrir conversa"
            onClick={onSendMessage}
          >
            <ChatIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8.2" r="3.7" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.7 20c0-3.7 3.2-6.3 7.3-6.3s7.3 2.6 7.3 6.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
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
  defaultReferences,
  selectedBeardId,
  onSelectBeard,
  selectedAccessoryId,
  onSelectAccessory,
  selectedAccessoryColorId,
  onSelectAccessoryColor,
  selectedOutfitId,
  onSelectOutfit,
  selectedOutfitColorId,
  onSelectOutfitColor,
  editorCategory,
  onSelectCategory,
  measuredHeight,
  onMeasuredHeight,
  onAskAvailable,
  onCallOver,
  onSendMessage,
  onSendNote,
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
  // pedido do Douglas: "quando eu adiciono a cor nao consigo voltar a
  // cor original" -- aceita `null` agora (a bolinha cinza com risco no
  // meio, ver skin-swatch-reset no JSX abaixo) pra voltar a arte
  // "padrão" do item, sem nenhuma cor escolhida.
  onSelectHairColor: (id: string | null) => void;
  selectedGender: AvatarGender;
  onSelectGender: (gender: AvatarGender) => void;
  selectedSkinId: string;
  onSelectSkin: (id: string) => void;
  // "Avatar Padrão" (ver avatar_default_reference/AvatarCreatorPanel em
  // ItemEditor.tsx) -- pedido do Douglas: "sim, quero que apareça pro
  // jogador agora" (antes era só guia interno de alinhamento, nunca
  // aparecia aqui). Cabeça/corpo por sexo, já buscados em GameRoom (ver
  // fetchDefaultReferences) -- usado só como FALLBACK do boneco abaixo,
  // quando SKIN_CATALOG não tem nenhum tom pro sexo escolhido (tom "de
  // fábrica" foi removido, ver customization.ts -- só sobra o que o
  // Douglas cadastrar em "Tons cadastrados").
  defaultReferences: Record<AvatarGender, { headUrl: string; bodyUrl: string } | null>;
  selectedBeardId: string;
  onSelectBeard: (id: string) => void;
  selectedAccessoryId: string;
  onSelectAccessory: (id: string) => void;
  selectedAccessoryColorId: string | null;
  onSelectAccessoryColor: (id: string | null) => void;
  selectedOutfitId: string;
  onSelectOutfit: (id: string) => void;
  selectedOutfitColorId: string | null;
  onSelectOutfitColor: (id: string | null) => void;
  editorCategory: CustomizationCategoryId;
  onSelectCategory: (id: CustomizationCategoryId) => void;
  measuredHeight: number | null;
  onMeasuredHeight: (h: number) => void;
  onAskAvailable: () => void;
  onCallOver: () => void;
  onSendMessage: () => void;
  /** "Deixar um recado" -- ver sendNote em GameRoom.tsx. Recebe o TEXTO
   * já digitado no composer inline do card (ver recado-composer no JSX
   * abaixo), diferente de onAskAvailable/onCallOver/onSendMessage (esses
   * não precisam de argumento nenhum, são sempre o mesmo aviso fixo). */
  onSendNote: (text: string) => void;
}) {
  const thumbScale = HAIR_THUMB_W / 200;
  const photoInputRef = useRef<HTMLInputElement>(null);
  const baseCardRef = useRef<HTMLDivElement>(null);
  // pra qual lado o boneco fixo do topo tá virado agora (setas ‹ ›, ver
  // avatar-preview-rotate-wrap mais abaixo) -- só existe/importa na tela
  // de edição, mas mora aqui em cima (fora do `if (editing)`) porque
  // hook não pode ser condicional. Sempre volta pra "down" ao abrir a
  // edição de novo (ver reset no onStartEdit já existente lá em
  // GameRoom, esse aqui é só o estado local da prévia -- não precisa
  // persistir).
  const [previewDirection, setPreviewDirection] = useState<Direction>("down");

  // composer inline de "Deixar um recado" (ver onSendNote/sendNote em
  // GameRoom.tsx) -- fica FECHADO por padrão (só o botão), abre um campo
  // de texto pequeno dentro do próprio card ao clicar. Estado local do
  // card mesmo (não precisa subir pra GameRoom), mas o <ProfileCard> não
  // tem `key` no JSX (GameRoom só troca o objeto `info`, não desmonta o
  // componente ao trocar de pessoa) -- por isso reseta À MÃO sempre que
  // o playerId mudar, senão um recado meio-digitado pra uma pessoa
  // vazaria pro card da PRÓXIMA se clicar em outro boneco sem fechar.
  const [recadoOpen, setRecadoOpen] = useState(false);
  const [recadoText, setRecadoText] = useState("");
  useEffect(() => {
    setRecadoOpen(false);
    setRecadoText("");
  }, [info.playerId]);

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
    // pode não achar NENHUM (SKIN_CATALOG começa vazio agora, só ganha
    // tom quando o Douglas cadastra em "Tons cadastrados", ver
    // customization.ts) -- nesse caso cai no Avatar Padrão do sexo atual
    // como base (ver defaultReferenceForGender/avatar-preview-layer
    // "traje limpo"+"cabeça" mais abaixo), em vez de undefined.file
    // quebrando a prévia.
    const selectedSkinOption =
      SKIN_CATALOG.find((opt) => opt.id === selectedSkinId) ??
      SKIN_CATALOG.find((opt) => (opt.gender ?? "masculino") === selectedGender) ??
      SKIN_CATALOG[0];
    const activeDefaultReference = selectedSkinOption ? null : defaultReferences[selectedGender];
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
    // traje: arquivo efetivo já é resolvido pelo tom de pele ATUAL (ver
    // outfitFileForSkin/resolveOutfitSkinId), então a prévia troca
    // sozinha ao trocar o tom, sem precisar reselecionar o traje. Cor
    // escolhida (se houver, ver selectedOutfitColorId acima) manda mais
    // -- mesmo esquema de cabelo/acessório -- só que a cor de traje não
    // é por tom (é 1 arquivo só, ver comentário de OutfitOption.colors
    // em game/customization.ts), então usa DIRETO sem outfitFileForSkin.
    const selectedOutfitOption = OUTFIT_CATALOG.find((opt) => opt.id === selectedOutfitId);
    const selectedOutfitColorOption = selectedOutfitColorId
      ? selectedOutfitOption?.colors?.find((c) => c.id === selectedOutfitColorId)
      : undefined;
    const effectiveOutfitFile =
      selectedOutfitColorOption?.file ??
      (selectedOutfitOption ? outfitFileForSkin(selectedOutfitOption, selectedSkinId) : undefined);
    // posição do frame PARADO da direção escolhida (ver
    // PREVIEW_DIRECTION_FRAME acima) dentro da folha 8x2 -- mesma conta
    // de frameOffsetXPx/frameOffsetYPx em ItemEditor.tsx, só que em
    // background-position (negativo) em vez de transform: translate.
    // Reaproveitada em TODAS as camadas do boneco (base/traje/barba/
    // cabelo/acessório) pra girarem juntas.
    const previewFrameIndex = PREVIEW_DIRECTION_FRAME[previewDirection];
    const previewScale = AVATAR_PREVIEW_W / FRAME_W;
    const previewBgPos = `${-(previewFrameIndex % 8) * (FRAME_W + 2) * previewScale}px ${-Math.floor(previewFrameIndex / 8) * (FRAME_H + 2) * previewScale}px`;
    function rotatePreview(delta: 1 | -1) {
      setPreviewDirection((prev) => {
        const idx = PREVIEW_DIRECTION_ORDER.indexOf(prev);
        const nextIdx = (idx + delta + PREVIEW_DIRECTION_ORDER.length) % PREVIEW_DIRECTION_ORDER.length;
        return PREVIEW_DIRECTION_ORDER[nextIdx];
      });
    }
    // pedido do Douglas: "editar meu personagem deve estar centralizado
    // no avatar" -- o título não pode mais só `text-align:center` no
    // card INTEIRO (900px), porque a coluna estreita de tom de pele
    // (.profile-edit-side) desequilibra onde o boneco cai visualmente;
    // centraliza especificamente em cima da coluna do boneco
    // (.profile-edit-avatar-col) via marginLeft (pula a coluna
    // estreita) + width (largura da própria coluna do boneco) no <h3>,
    // com text-align:center por dentro (ver .profile-edit-title). Os
    // valores abaixo duplicam o CSS de propósito (.profile-edit-side,
    // .avatar-preview-wrap, .avatar-preview-rotate-wrap/-btn) só pra
    // esse cálculo -- se esses paddings/gaps mudarem de novo no CSS,
    // atualizar aqui também.
    const PROFILE_EDIT_SIDE_WIDTH = 132 + 1; // .profile-edit-side width + border-right
    const AVATAR_WRAP_SIDE_PADDING = 4; // .avatar-preview-wrap padding lateral
    const AVATAR_ROTATE_GAP = 2; // .avatar-preview-rotate-wrap gap
    const AVATAR_ROTATE_BTN = 39; // .avatar-preview-rotate-btn width
    const AVATAR_COL_WIDTH =
      AVATAR_ROTATE_BTN * 2 + AVATAR_ROTATE_GAP * 2 + AVATAR_WRAP_SIDE_PADDING * 2 + AVATAR_PREVIEW_W;
    return (
      <div className="profile-backdrop" onClick={onClose}>
        <div
          className="profile-card editing"
          // pedido do Douglas: "a altura fixa na altura do card do
          // perfil" -- volta a seguir CEGAMENTE a altura medida do card
          // de perfil normal (measuredHeight, ver comentário grande mais
          // abaixo em "Editar meu personagem toma o card INTEIRO"),
          // igual sempre foi. O layout em 3 colunas lado a lado (boneco +
          // abas+grade, ver .profile-edit-main) já não precisa de mais
          // altura que isso -- foi só a largura que cresceu (ver width
          // em .profile-card.editing).
          style={{ height: measuredHeight ?? 560 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3
            className="profile-edit-title"
            style={{ marginLeft: PROFILE_EDIT_SIDE_WIDTH, width: AVATAR_COL_WIDTH }}
          >
            Editar meu personagem
          </h3>

          {/* pedido do Douglas: "fim das cores em tom de pele, uma
              traço vertical, linha cinza igual nos outros limites / pra
              direita posicionar o avatar / embaixo do tom vai vir as
              cores do item selecionado, hoje o traje vai pra baixo mexe
              no card, nao quero isso, card travado / aumenta ele na
              altura pra caber os itens embaixo com espaco bom, na
              posicao igual do habbo fica legal, aoinves de embaixo do
              lado direito os itens". Reorganiza o corpo do editor em
              DUAS colunas lado a lado (mesma ideia do editor de verdade
              do Habbo que ele mandou de referência: grade de item +
              boneco + cores em colunas, não tudo empilhado): coluna
              ESTREITA (tom de pele + cores do item, scroll próprio,
              borda cinza à direita -- ver .profile-edit-side) e coluna
              PRINCIPAL (boneco + abas + grade de itens, ver
              .profile-edit-main) à direita dela. A coluna estreita tem
              overflow-y:auto e altura travada pelo flex de
              .profile-edit-body -- crescer com "Cores de X" agora rola
              POR DENTRO da própria coluna, não empurra mais o card
              inteiro (era o "trocar de traje mexe no card" reclamado). */}
          <div className="profile-edit-body">
            <div className="profile-edit-side">
              {/* pedido do Douglas: "masculino e feminino vira doi botoes
                  com icone de homem mulher pra caber responsivo encima
                  das cores" / "tire o titulo sexo" -- os dois botões de
                  texto ("Masculino"/"Feminino", linha própria de largura
                  total do card) viram DOIS ÍCONES lado a lado, compactos
                  o bastante pra caber na coluna estreita (132px), sem
                  legenda "Sexo" em cima (o ícone já fala por si). Classe
                  PRÓPRIA (profile-edit-gender-icon*, não .gender-switch/
                  .gender-btn) -- essas duas são reaproveitadas em vários
                  outros toggles do Editor de Itens (cabeça/traje,
                  parado/passoA/passoB, sentado sim/não, ver ItemEditor.tsx)
                  e mexer no visual delas ali quebraria os outros. */}
              <div className="profile-edit-gender-icons">
                <button
                  type="button"
                  className={selectedGender === "masculino" ? "profile-edit-gender-icon-btn selected" : "profile-edit-gender-icon-btn"}
                  onClick={() => onSelectGender("masculino")}
                  title="Masculino"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <circle cx="10" cy="14" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
                    <path d="M14.6 9.4 20 4M20 4h-5M20 4v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={selectedGender === "feminino" ? "profile-edit-gender-icon-btn selected" : "profile-edit-gender-icon-btn"}
                  onClick={() => onSelectGender("feminino")}
                  title="Feminino"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <circle cx="12" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
                    <path d="M12 15v7M8.5 19h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="skin-picker">
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

              {/* cores da variante do item selecionado (cabelo/acessório,
                  ver ColorOption em game/customization.ts) -- logo abaixo
                  do tom de pele, na MESMA coluna, MESMO estilo de círculo
                  de cor cheia (pedido do Douglas: "o card das cores do
                  item fique embaixo dos tons de pele" / "só vai aparecer
                  a cor do gbr igual dos tons de pele"). Só renderiza
                  quando o item atual (da aba aberta) tem variante de cor
                  cadastrada -- sem placeholder "Em breve" aqui. */}
          {editorCategory === "cabelo" && selectedHairOption?.colors && selectedHairOption.colors.length > 0 && (
            <div className="skin-picker">
              <span className="skin-picker-label">Cores de &quot;{selectedHairOption.label}&quot;</span>
              <div className="skin-swatches">
                {/* pedido do Douglas: "quando eu adiciono a cor nao
                    consigo voltar a cor original / faca uma bolinha
                    cinza com um risco no meio em primeiro lugar nas
                    cores, clicando nela volta na cor padrao" -- sempre
                    em PRIMEIRO lugar na lista, chama onSelectHairColor
                    com null (volta pro arquivo "padrão" do penteado,
                    sem cor escolhida, ver effectiveHairFile acima). */}
                <button
                  type="button"
                  className={selectedHairColorId === null ? "skin-swatch skin-swatch-reset selected" : "skin-swatch skin-swatch-reset"}
                  onClick={() => onSelectHairColor(null)}
                  title="Cor padrão"
                />
                {selectedHairOption.colors.map((c) => (
                  <button
                    key={c.id}
                    className={selectedHairColorId === c.id ? "skin-swatch selected" : "skin-swatch"}
                    style={{ background: c.hex ?? "#8a7ca8" }}
                    onClick={() => onSelectHairColor(c.id)}
                    title={c.label}
                  />
                ))}
              </div>
            </div>
          )}
          {editorCategory === "acessorio" &&
            selectedAccessoryOption?.colors &&
            selectedAccessoryOption.colors.length > 0 && (
              <div className="skin-picker">
                <span className="skin-picker-label">Cores de &quot;{selectedAccessoryOption.label}&quot;</span>
                <div className="skin-swatches">
                  {/* mesma bolinha de reset acima, ver comentário lá. */}
                  <button
                    type="button"
                    className={
                      selectedAccessoryColorId === null ? "skin-swatch skin-swatch-reset selected" : "skin-swatch skin-swatch-reset"
                    }
                    onClick={() => onSelectAccessoryColor(null)}
                    title="Cor padrão"
                  />
                  {selectedAccessoryOption.colors.map((c) => (
                    <button
                      key={c.id}
                      className={selectedAccessoryColorId === c.id ? "skin-swatch selected" : "skin-swatch"}
                      style={{ background: c.hex ?? "#8a7ca8" }}
                      onClick={() => onSelectAccessoryColor(c.id)}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>
            )}
          {editorCategory === "traje" && selectedOutfitOption?.colors && selectedOutfitOption.colors.length > 0 && (
            <div className="skin-picker">
              <span className="skin-picker-label">Cores de &quot;{selectedOutfitOption.label}&quot;</span>
              <div className="skin-swatches">
                {/* mesma bolinha de reset acima, ver comentário lá. */}
                <button
                  type="button"
                  className={selectedOutfitColorId === null ? "skin-swatch skin-swatch-reset selected" : "skin-swatch skin-swatch-reset"}
                  onClick={() => onSelectOutfitColor(null)}
                  title="Cor padrão"
                />
                {selectedOutfitOption.colors.map((c) => (
                  <button
                    key={c.id}
                    className={selectedOutfitColorId === c.id ? "skin-swatch selected" : "skin-swatch"}
                    style={{ background: c.hex ?? "#8a7ca8" }}
                    onClick={() => onSelectOutfitColor(c.id)}
                    title={c.label}
                  />
                ))}
              </div>
            </div>
          )}
            </div>

            <div className="profile-edit-main">
              {/* pedido do Douglas: "vc nao entendeu... eu quero na
                  posicao do segundo print, estende o card na horizontal"
                  -- abas + grade de itens NÃO ficam mais empilhadas
                  EMBAIXO do boneco (era a leitura errada da vez
                  anterior); ficam do LADO dele, mesma linha, cada um na
                  sua coluna (.profile-edit-avatar-col /
                  .profile-edit-items-col) -- por isso o card precisou
                  esticar na horizontal (ver width em .profile-card.editing). */}
              <div className="profile-edit-avatar-col">
          {/* boneco fixo no topo -- mostra AO VIVO cada escolha (base +
              traje + cabelo/barba/acessório selecionados empilhados,
              mesmo recorte de frame 0 dos thumbnails), ver
              LAYER_DRAW_ORDER em MainScene.ts. */}
          <div className="avatar-preview-wrap">
            {/* pedido do Douglas: "colocar do lado dele setas, pra ele
                girar o avatar" -- gira entre os 4 lados (sempre parado,
                ver PREVIEW_DIRECTION_FRAME/rotatePreview acima), já que
                agora todo item cadastrado tem arte nas 4 direções.
                Coluna própria (setas+boneco em cima, legenda do lado
                embaixo). */}
            {/* pedido do Douglas: "sobe o avatar em 20%" -- desloca o
                bloco inteiro (setas+boneco+legenda) da posição
                centralizada de sempre, calculado em cima da constante
                (não um px fixo no CSS) pra acompanhar se o tamanho do
                boneco mudar de novo no futuro. Depois de encolher 10%
                (ver AVATAR_PREVIEW_W/H acima) ainda ficou perto demais
                do topo/título -- pedido do Douglas: "esse e o editar
                ele ta na proporcao errada la, diminui" / "ou baixa
                ele" -- reduzido de -20% (bem pra cima) pra -5% (só uma
                leve subida, o resto do espaço agora sobra embaixo). */}
            <div className="avatar-preview-column" style={{ marginTop: -(AVATAR_PREVIEW_H * 0.05) }}>
            <div className="avatar-preview-rotate-wrap">
              <button
                type="button"
                className="avatar-preview-rotate-btn"
                onClick={() => rotatePreview(-1)}
                title="Girar"
              >
                ‹
              </button>
              <div className="avatar-preview" style={{ width: AVATAR_PREVIEW_W, height: AVATAR_PREVIEW_H }}>
                {/* ordem das camadas segue LAYER_DRAW_ORDER (MainScene.ts):
                    traje ATRÁS da base -- "base" (tom de pele) é só a
                    cabeça/busto, "traje" é quem dá o corpo inteiro (pedido
                    do Douglas: "a gente criou pro jogo cabeça e traje, o
                    corpo padrão não vai pro jogo" / "coloca a cabeça acima
                    do traje"); cabelo ATRÁS da barba (barba não pode ficar
                    escondida atrás do cabelo); óculos na frente de tudo --
                    "nenhuma(o)"/"Nenhum" é um arquivo transparente, então
                    sempre renderiza (sem condicional), só não aparece
                    nada. */}
                {effectiveOutfitFile && (
                  <span
                    className="avatar-preview-layer"
                    style={{
                      backgroundImage: `url(${furnitureAssetUrl(effectiveOutfitFile)})`,
                      backgroundPosition: previewBgPos,
                      backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                    }}
                  />
                )}
                {selectedSkinOption ? (
                  <span
                    className="avatar-preview-layer"
                    style={{
                      backgroundImage: `url(${furnitureAssetUrl(selectedSkinOption.file)})`,
                      backgroundPosition: previewBgPos,
                      backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                    }}
                  />
                ) : (
                  activeDefaultReference && (
                    // sem NENHUM tom cadastrado pro sexo atual (ver
                    // selectedSkinOption acima) -- cai no Avatar Padrão
                    // (corpo/traje limpo primeiro, cabeça por cima, mesma
                    // ordem do boneco de verdade) em vez de deixar a
                    // prévia sem base nenhuma.
                    <>
                      <span
                        className="avatar-preview-layer"
                        style={{
                          backgroundImage: `url(${furnitureAssetUrl(activeDefaultReference.bodyUrl)})`,
                          backgroundPosition: previewBgPos,
                          backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                        }}
                      />
                      <span
                        className="avatar-preview-layer"
                        style={{
                          backgroundImage: `url(${furnitureAssetUrl(activeDefaultReference.headUrl)})`,
                          backgroundPosition: previewBgPos,
                          backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                        }}
                      />
                    </>
                  )
                )}
                {effectiveHairFile && (
                  <span
                    className="avatar-preview-layer"
                    style={{
                      backgroundImage: `url(${furnitureAssetUrl(effectiveHairFile)})`,
                      backgroundPosition: previewBgPos,
                      backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                    }}
                  />
                )}
                {effectiveBeardFile && (
                  <span
                    className="avatar-preview-layer"
                    style={{
                      backgroundImage: `url(${furnitureAssetUrl(effectiveBeardFile)})`,
                      backgroundPosition: previewBgPos,
                      backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                    }}
                  />
                )}
                {effectiveAccessoryFile && (
                  <span
                    className="avatar-preview-layer"
                    style={{
                      backgroundImage: `url(${furnitureAssetUrl(effectiveAccessoryFile)})`,
                      backgroundPosition: previewBgPos,
                      backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                    }}
                  />
                )}
              </div>
              <button
                type="button"
                className="avatar-preview-rotate-btn"
                onClick={() => rotatePreview(1)}
                title="Girar"
              >
                ›
              </button>
            </div>
            </div>
          </div>
              </div>

              <div className="profile-edit-items-col">
          {/* pedido do Douglas: "alinhe os itens verticalmente com os
              icones do sexo, e copie as bordas dos baloes do sexo" ->
              depois corrigido: "verticalmente nao horizontalmente /
              volte eles pro card dos itens" -- as abas voltam pra
              DENTRO da coluna de itens (não mais linha de largura
              total do card, era horizontal demais); o alinhamento com
              os ícones de sexo agora é só de ALTURA (padding-top
              zerado aqui embaixo, ver .edit-category-tabs), pra essa
              primeira linha da coluna de itens começar bem na mesma
              altura que os ícones no topo da coluna estreita
              (.profile-edit-side), sem mexer na largura/posição
              horizontal de nada. */}
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
                  {/* filtra pelo sexo escolhido acima -- item sem `gender`
                      (ex: "Nenhum", de fábrica) aparece pros dois; bug
                      reportado pelo Douglas: "cabelo e itens masculinos
                      não vão pro feminino se não seta, e estão indo". */}
                  {HAIR_CATALOG.filter((opt) => !opt.gender || opt.gender === selectedGender).map((opt) => (
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
                          backgroundImage: `url(${furnitureAssetUrl(opt.file)})`,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  ))}
                </div>
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
                          backgroundImage: thumbFile ? `url(${furnitureAssetUrl(thumbFile)})` : undefined,
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
                  {/* mesmo filtro por sexo do cabelo acima. */}
                  {ACCESSORY_CATALOG.filter((opt) => !opt.gender || opt.gender === selectedGender).map((opt) => (
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
                          backgroundImage: `url(${furnitureAssetUrl(opt.file)})`,
                          backgroundPosition: "0 0",
                          backgroundSize: `${HAIR_SHEET_W * thumbScale}px ${HAIR_SHEET_H * thumbScale}px`,
                        }}
                      />
                      <span className="hair-label">{opt.label}</span>
                    </button>
                  ))}
                </div>
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
                          backgroundImage: thumbFile ? `url(${furnitureAssetUrl(thumbFile)})` : undefined,
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
              </div>
            </div>
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
            {recadoOpen ? (
              // composer do "Deixar um recado" (ver onSendNote em
              // GameRoom.tsx) -- SUBSTITUI a fileira de botões enquanto
              // aberto, em vez de empilhar embaixo, pra não bagunçar o
              // card com os dois ao mesmo tempo.
              <div className="profile-recado-composer">
                <textarea
                  className="profile-recado-input"
                  value={recadoText}
                  onChange={(e) => setRecadoText(e.target.value.slice(0, 200))}
                  placeholder="Escreve um recado..."
                  rows={2}
                  maxLength={200}
                  autoFocus
                />
                <div className="profile-actions-row">
                  <button
                    className="profile-action-btn"
                    onClick={() => {
                      setRecadoOpen(false);
                      setRecadoText("");
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    className="profile-action-btn primary"
                    disabled={!recadoText.trim()}
                    onClick={() => {
                      onSendNote(recadoText);
                      setRecadoOpen(false);
                      setRecadoText("");
                    }}
                  >
                    Enviar
                  </button>
                </div>
              </div>
            ) : (
              <div className="profile-actions-row">
                <button className="profile-action-btn" onClick={onAskAvailable}>
                  Disponível?
                </button>
                <button className="profile-action-btn" onClick={onCallOver}>
                  Chamar até você
                </button>
                <button className="profile-action-btn" onClick={() => setRecadoOpen(true)}>
                  Recado
                </button>
              </div>
            )}
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

export function PencilIcon() {
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

export function MicIcon({ off }: { off: boolean }) {
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

export function CamIcon({ off }: { off: boolean }) {
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

export function ScreenIcon({ active }: { active: boolean }) {
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

// Componente ISOLADO pra lista de vídeos remotos (pedido de performance
// do Douglas: "rodei de novo e tá lento ainda, o caminhar todo") -- dono
// do PRÓPRIO estado de nome/distância (metaSetterRef acima é como o
// GameRoom "empurra" as atualizações pra cá sem guardar esse estado ele
// mesmo). checkProximity (em GameRoom) roda a cada "move" recebido --
// até 20x/s por jogador remoto -- e enquanto alguém anda a distância
// muda o tempo todo; antes esse setState morava no componente RAIZ
// (GameRoom, com chat/editor/criador de avatar por baixo -- um arquivo
// gigante), então cada uma dessas mensagens forçava um re-render da
// árvore INTEIRA. Aqui o re-render fica restrito a essa listinha de
// vídeos (memo() só re-renderiza se as props realmente mudarem --
// remoteStreams/remoteVolumes só mudam em eventos raros de verdade,
// entrar/sair de chamada ou mexer no volume).
const RemoteVideosLayer = memo(function RemoteVideosLayer({
  remoteStreams,
  remoteVolumes,
  spaceVolume,
  selectedSpeakerId,
  metaSetterRef,
}: {
  remoteStreams: Record<string, MediaStream>;
  remoteVolumes: Record<string, number>;
  spaceVolume: number;
  selectedSpeakerId: string;
  metaSetterRef: MutableRefObject<((meta: Record<string, { name: string; distance: number }>) => void) | null>;
}) {
  const [remoteMeta, setRemoteMeta] = useState<Record<string, { name: string; distance: number }>>({});

  useEffect(() => {
    metaSetterRef.current = setRemoteMeta;
    return () => {
      metaSetterRef.current = null;
    };
  }, [metaSetterRef]);

  return (
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
  );
});

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
export function ChatCallVideoTile({ stream, muted, volume }: { stream: MediaStream; muted?: boolean; volume?: number }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  // pedido do Douglas, 30/set (5): "volume de chamadas" -- até aqui
  // esse vídeo não tinha volume nenhum configurável, tocava sempre no
  // padrão (1.0). "muted" (meu próprio preview) continua tendo
  // prioridade -- não faz sentido aplicar volume no meu próprio áudio
  // que já nem toca.
  useEffect(() => {
    if (ref.current && typeof volume === "number") ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  return <video ref={ref} autoPlay muted={muted} playsInline className="chat-call-video" />;
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

// Ícone do botão "Contatos" -- pedido do Douglas: "quero agora, mais
// um icone de contatos" (28/set). Carteirinha/crachá com uma "foto"
// redonda + duas linhas de texto, pra não confundir com UsersIcon
// (esse aqui é "duas pessoas", já usado no botão "Membros" da sala).
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

export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon() {
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

export function FileIcon() {
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
