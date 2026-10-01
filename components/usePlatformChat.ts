"use client";

// 1/out -- pedido direto do Douglas, depois de rejeitar a unificação só
// de APARÊNCIA entre o chat de dentro (GameRoom.tsx) e o chat de fora
// (Lobby.tsx): "nao tem que ter chat de fora chat de dentro, tem que
// ter CHAT ... pega o chat de dentro e transforma ele em CHAT que
// acompanha toda a plataforma". Até aqui cada tela guardava o PRÓPRIO
// estado de conversas/mensagens (Lobby ainda por cima misturava REST +
// um socket reduzido, ver commit 90ff615/e744e3a) -- esse hook é o
// motor ÚNICO: uma conexão de verdade com o servidor (mesma sala
// reservada "__lobby__" que já existia pra chamada/digitando, ver
// LOBBY_SOCKET_ROOM_ID em server/index.js, que agora fala o protocolo
// de chat INTEIRO, ver commit e5c060c), um estado só de
// conversas/mensagens/fixadas/digitando/chamada.
//
// MONTADO UMA VEZ em app/page.tsx (Home(), que nunca desmonta trocando
// Lobby<->GameRoom), não dentro de Lobby nem de GameRoom -- é assim que
// a conversa aberta/lista/chamada em andamento sobrevivem de verdade a
// entrar/sair da sala, em vez de "parecer" a mesma coisa só porque o
// componente visual é o mesmo (ChatDrawer já era compartilhado desde
// commit 38e511d, mas por baixo eram dois donos de estado diferentes --
// isso é o que esse hook corrige).
//
// GameRoom.tsx continua dono do que é GENUINAMENTE da sala (Sala/
// "quem tá por perto", chatLog sem histórico salvo, roomPins/roomTyping,
// avatar/presença) -- isso não muda aqui. Esse hook cobre só conversa
// direta/grupo (histórico persistido, ver server/chatStore.js):
// listar, abrir, criar, trocar de aba, renomear grupo, mandar (texto/
// anexo/áudio/room-card), apagar, reagir, fixar/desfixar, "visto por",
// painel de arquivos, "digitando..." e chamada de voz/vídeo.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import PartySocket from "partysocket";
import { resolveUserId } from "@/lib/identity";
import type {
  Conversation,
  ChatMsg,
  ChatMsgKind,
  ChatPin,
  ChatTypingEntry,
  ChatCallParticipant,
  ChatAttachment,
  ChatAttachmentItem,
  ChatAttachmentKind,
  RoomCard,
} from "@/components/GameRoom";

// MESMO nome reservado que LOBBY_SOCKET_ROOM_ID em server/index.js --
// nunca vira jogador fantasma numa sala de verdade (ver
// handleLobbySocketConnection lá, que não toca em getRoom/roomStore/
// áreas/portas, só fala o protocolo de chat/chamada que não depende de
// posição nenhuma).
const PLATFORM_SOCKET_ROOM = "__lobby__";
const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE =
  (process.env.NEXT_PUBLIC_REALTIME_HTTP_BASE || (REALTIME_HOST.startsWith("127.0.0.1") ? "http" : "https")) +
  `://${REALTIME_HOST}`;

const TYPING_THROTTLE_MS = 2500;
const TYPING_EXPIRE_MS = 4000;

// mesmo esquema de pickSupportedAudioMimeType/uploadChatFile em
// GameRoom.tsx -- duplicado aqui de propósito (funções pequenas,
// nenhuma lógica nova) pra esse hook não precisar importar nada em
// tempo de execução do módulo gigante do GameRoom (só os TIPOS, que são
// apagados na compilação, ver comentário grande de sempre em Lobby.tsx
// sobre isso).
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

async function uploadChatFile(file: Blob, filename: string): Promise<ChatAttachment> {
  const res = await fetch(`${REALTIME_HTTP_BASE}/upload?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": (file as File).type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`upload falhou (${res.status})`);
  return (await res.json()) as ChatAttachment;
}

export type PlatformChatParams = {
  accountUserId: string | null;
  accountProfile: { name?: string | null; photoUrl?: string | null } | null;
  accountAccessToken: string | null | undefined;
  // "chamada reaproveita stream ambiente" -- SÓ a sala de verdade tem
  // isso (câmera/mic já capturados pra ficar visível pra quem tá perto,
  // ver localStreamRef em GameRoom.tsx): entrar numa chamada de
  // conversa lá dentro NUNCA pede um getUserMedia novo, só reusa o que
  // já tá rodando (ver createCallPeerConnection de sempre). Fora da
  // sala (Lobby) não existe stream nenhuma rodando -- undefined aqui
  // faz esse hook pedir getUserMedia por conta própria na hora de
  // entrar numa chamada (mesmo comportamento que o Lobby já tinha no
  // commit 90ff615, agora dentro do motor único em vez de duplicado).
  ambientStreamRef?: RefObject<MediaStream | null>;
  micOn?: boolean;
  camOn?: boolean;
  selectedMicId?: string | null;
  selectedCamId?: string | null;
};

export function usePlatformChat(params: PlatformChatParams) {
  const {
    accountUserId,
    accountProfile,
    accountAccessToken,
    ambientStreamRef,
    micOn = true,
    camOn = true,
    selectedMicId = null,
    selectedCamId = null,
  } = params;

  // "convidar amigo pra minha sala"/"pedir pra visitar" (RoomCard) e
  // carimbar "Empresa" numa conversa (ver getRoomCompanyInfo em
  // server/roomAuth.js) precisam saber QUAL é "minha sala" agora --
  // dentro da sala é a sala aberta, fora (Lobby) é a sala que a
  // própria pessoa já tem (myRealRoom). Isso NÃO é fixo desde o mount
  // (o hook monta ANTES de qualquer uma das duas telas saber disso --
  // ver PlatformChatHost em app/page.tsx), então é estado de verdade
  // que quem usa o hook atualiza via setRoomContext sempre que souber
  // (ou deixar de saber, null) sua própria sala.
  const [roomContext, setRoomContext] = useState<{
    slug: string;
    name: string | null;
    logoUrl: string | null;
  } | null>(null);

  const myUserId = useMemo(() => resolveUserId(accountUserId), [accountUserId]);
  const myName = accountProfile?.name?.trim() || "Visitante";

  // --- conexão única ---
  const socketRef = useRef<PartySocket | null>(null);
  const selfIdRef = useRef<string>("");
  const [connected, setConnected] = useState(false);

  function send(data: Record<string, unknown>): boolean {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(data));
    return true;
  }

  // --- estado de conversas/mensagens (ver tipos em GameRoom.tsx --
  // MESMO formato que a sala já usava, nenhuma conversão). ---
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const [chatView, setChatView] = useState<"list" | "thread" | "new">("list");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  activeConversationIdRef.current = activeConversationId;
  const readingConversationIdRef = useRef<string | null>(null);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMsg[]>>({});
  const [unreadSinceTsByConv, setUnreadSinceTsByConv] = useState<Record<string, number>>({});
  const [pinsByConv, setPinsByConv] = useState<Record<string, ChatPin[]>>({});
  const [typingByConv, setTypingByConv] = useState<Record<string, ChatTypingEntry[]>>({});
  const [lastReadByConv, setLastReadByConv] = useState<Record<string, Record<string, number>>>({});
  const [composerText, setComposerText] = useState("");
  const [pendingMentionIds, setPendingMentionIds] = useState<string[]>([]);
  const autoOpenNextConversationRef = useRef(false);

  // --- "Nova conversa" / "Criar grupo" ---
  const [newConvMode, setNewConvMode] = useState<"direct" | "group">("direct");
  const [newConvSelection, setNewConvSelection] = useState<string[]>([]);
  const [newConvName, setNewConvName] = useState("");
  const [newConvFilter, setNewConvFilter] = useState<"company" | "friends">("company");
  const [newConvQuery, setNewConvQuery] = useState("");
  const [newConvSearchResults, setNewConvSearchResults] = useState<
    { userId: string; name: string; photoUrl: string }[] | null
  >(null);
  const [newConvFriends, setNewConvFriends] = useState<
    { userId: string; name: string; photoUrl: string }[] | null
  >(null);

  useEffect(() => {
    if (chatView === "new") {
      setNewConvMode("direct");
      setNewConvSelection([]);
      setNewConvName("");
    } else {
      setNewConvQuery("");
      setNewConvFilter("company");
      setNewConvSearchResults(null);
      setNewConvFriends(null);
    }
  }, [chatView]);

  useEffect(() => {
    if (chatView !== "new" || newConvFilter !== "company" || !accountAccessToken || !newConvQuery.trim()) {
      setNewConvSearchResults(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/friends/search?q=${encodeURIComponent(newConvQuery.trim())}`, {
        headers: { Authorization: `Bearer ${accountAccessToken}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled) setNewConvSearchResults(Array.isArray(data?.users) ? data.users : []);
        })
        .catch(() => {
          if (!cancelled) setNewConvSearchResults([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chatView, newConvFilter, newConvQuery, accountAccessToken]);

  useEffect(() => {
    if (chatView !== "new" || newConvFilter !== "friends" || !accountAccessToken) return;
    let cancelled = false;
    fetch("/api/friends/list", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setNewConvFriends(Array.isArray(data?.friends) ? data.friends : []);
      })
      .catch(() => {
        if (!cancelled) setNewConvFriends([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chatView, newConvFilter, accountAccessToken]);

  function changeNewConvMode(mode: "direct" | "group") {
    setNewConvMode(mode);
    setNewConvSelection([]);
    setNewConvName("");
  }

  function toggleNewConvSelection(userId: string) {
    setNewConvSelection((prev) =>
      newConvMode === "direct"
        ? prev.includes(userId)
          ? []
          : [userId]
        : prev.includes(userId)
          ? prev.filter((x) => x !== userId)
          : [...prev, userId]
    );
  }

  function startDirectWith(targetUserId: string, lane: "company" | "private" = "company") {
    autoOpenNextConversationRef.current = true;
    send({ type: "chat:create_direct", targetUserId, lane, roomSlug: roomContext?.slug ?? undefined });
    setNewConvSelection([]);
    setNewConvName("");
  }

  function submitNewConversation() {
    if (newConvSelection.length === 0) return;
    if (newConvSelection.length === 1 && !newConvName.trim()) {
      startDirectWith(newConvSelection[0], newConvFilter === "friends" ? "private" : "company");
      return;
    }
    autoOpenNextConversationRef.current = true;
    send({
      type: "chat:create_group",
      name: newConvName.trim(),
      participantIds: newConvSelection,
      roomSlug: roomContext?.slug ?? undefined,
    });
    setNewConvSelection([]);
    setNewConvName("");
  }

  function moveConversationLane(conversationId: string, lane: "company" | "private") {
    send({ type: "chat:set_lane", conversationId, lane, roomSlug: roomContext?.slug ?? undefined });
  }

  const [renamingGroup, setRenamingGroup] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");

  function submitRenameGroup() {
    const name = groupNameDraft.trim();
    if (!activeConversationId || !name) return;
    send({ type: "chat:rename_group", conversationId: activeConversationId, name });
    setRenamingGroup(false);
  }

  function openConversation(id: string | null) {
    setActiveConversationId(id);
    setChatView(id === null ? "list" : "thread");
    setFilesPanelOpen(false);
    if (id !== null && !messagesByConv[id]) {
      send({ type: "chat:open", conversationId: id });
    }
  }

  const [sendingAttachment, setSendingAttachment] = useState(false);

  function onSendComposer() {
    const text = composerText.trim();
    if (!text || activeConversationId === null) return;
    if (!send({ type: "chat:send", conversationId: activeConversationId, text, mentionedUserIds: pendingMentionIds })) {
      return;
    }
    setComposerText("");
    setPendingMentionIds([]);
  }

  async function sendChatAttachment(file: Blob, filename: string, kind: ChatAttachmentKind) {
    if (activeConversationId === null) return;
    setSendingAttachment(true);
    try {
      const attachment = await uploadChatFile(file, filename);
      send({ type: "chat:send", conversationId: activeConversationId, attachment, kind });
    } finally {
      setSendingAttachment(false);
    }
  }

  function sendRoomCard(action: "invite" | "visit") {
    if (activeConversationId === null) return;
    const roomCard: RoomCard =
      action === "invite" && roomContext
        ? {
            action,
            roomSlug: roomContext.slug,
            roomName: roomContext.name || "Minha sala",
            roomLogoUrl: roomContext.logoUrl || "",
          }
        : { action, roomSlug: "", roomName: "", roomLogoUrl: "" };
    send({ type: "chat:send", conversationId: activeConversationId, roomCard });
  }

  function deleteMessage(conversationId: string | null, messageId: string) {
    if (conversationId === null) return;
    send({ type: "chat:delete", conversationId, messageId });
  }

  function toggleReaction(conversationId: string | null, messageId: string, emoji: string) {
    if (conversationId === null) return;
    send({ type: "chat:react", conversationId, messageId, emoji });
  }

  function pinMessage(conversationId: string | null, messageId: string, durationMs: number | null) {
    if (conversationId === null) return;
    send({ type: "chat:pin", conversationId, messageId, durationMs: durationMs ?? undefined });
  }

  function unpinMessage(conversationId: string | null, messageId: string) {
    if (conversationId === null) return;
    send({ type: "chat:unpin", conversationId, messageId });
  }

  const lastTypingSentAtRef = useRef<Record<string, number>>({});
  function sendTypingNotification(conversationId: string | null) {
    if (!conversationId) return;
    const now = Date.now();
    if (now - (lastTypingSentAtRef.current[conversationId] ?? 0) < TYPING_THROTTLE_MS) return;
    lastTypingSentAtRef.current[conversationId] = now;
    send({ type: "chat:typing", conversationId });
  }

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - TYPING_EXPIRE_MS;
      setTypingByConv((prev) => {
        let changed = false;
        const next: Record<string, ChatTypingEntry[]> = {};
        for (const [convId, list] of Object.entries(prev)) {
          const filtered = list.filter((t) => t.ts >= cutoff);
          if (filtered.length !== list.length) changed = true;
          next[convId] = filtered;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // --- painel lateral "arquivos da conversa" ---
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);
  const [filesPanelItems, setFilesPanelItems] = useState<ChatAttachmentItem[] | null>(null);
  const [filesPanelFilter, setFilesPanelFilter] = useState<"all" | "image" | "file" | "audio">("all");
  const [filesPanelQuery, setFilesPanelQuery] = useState("");

  function openFilesPanel() {
    if (activeConversationId === null) return;
    setFilesPanelOpen(true);
    setFilesPanelItems(null);
    setFilesPanelFilter("all");
    setFilesPanelQuery("");
    send({ type: "chat:attachments", conversationId: activeConversationId });
  }

  function closeFilesPanel() {
    setFilesPanelOpen(false);
  }

  function mentionAttachmentInChat(item: ChatAttachmentItem) {
    const mentionText = `@${item.senderName || "Alguém"} `;
    setComposerText((prev) => (prev ? `${prev} ${mentionText}` : mentionText));
    setPendingMentionIds((prev) => (prev.includes(item.senderId) ? prev : [...prev, item.senderId]));
    setFilesPanelOpen(false);
  }

  // --- gravação de áudio (estilo WhatsApp -- grava, mostra o tempo,
  // PARA, preview, só manda quando confirma -- ver comentário grande
  // de sempre em GameRoom.tsx). Sem stream ambiente pra clonar aqui
  // (isso é SÓ da sala, ver startVoiceRecording lá) -- pede
  // getUserMedia próprio sempre. ---
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordedPreview, setRecordedPreview] = useState<{ url: string; durationSec: number } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBlobRef = useRef<Blob | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef(0);
  const discardRecordingRef = useRef(false);

  async function startVoiceRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    }
  }

  function stopVoiceRecording() {
    mediaRecorderRef.current?.stop();
  }

  function cancelVoiceRecording() {
    discardRecordingRef.current = true;
    mediaRecorderRef.current?.stop();
  }

  function discardRecordedAudio() {
    if (recordedPreview) URL.revokeObjectURL(recordedPreview.url);
    recordedBlobRef.current = null;
    setRecordedPreview(null);
  }

  async function sendRecordedAudio() {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    if (recordedPreview) URL.revokeObjectURL(recordedPreview.url);
    recordedBlobRef.current = null;
    setRecordedPreview(null);
    await sendChatAttachment(blob, `gravacao-${Date.now()}.webm`, "audio");
  }

  // ---------------------------------------------------------------
  // chamada de voz/vídeo de conversa -- MESMO mesh de GameRoom.tsx/
  // Lobby.tsx (socket dedicado, endereçado por connectionId, "signal"/
  // call:join/call:leave/call:state/chat:typing em server/index.js).
  // ambientStreamRef (ver PlatformChatParams) decide se pede
  // getUserMedia próprio ou reaproveita o que o chamador já tiver
  // rodando -- ver comentário grande no tipo acima.
  // ---------------------------------------------------------------
  const callLocalStreamRef = useRef<MediaStream | null>(null);
  const callPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const myCallConversationIdRef = useRef<string | null>(null);
  const [callParticipantsByConversation, setCallParticipantsByConversation] = useState<
    Record<string, ChatCallParticipant[]>
  >({});
  const [myCallConversationId, setMyCallConversationId] = useState<string | null>(null);
  myCallConversationIdRef.current = myCallConversationId;
  const [callRemoteStreams, setCallRemoteStreams] = useState<Record<string, MediaStream>>({});

  function getLocalStreamForCalls(): MediaStream | null {
    const ambient = ambientStreamRef?.current;
    if (ambient && ambient.active) return ambient;
    return callLocalStreamRef.current;
  }

  function sendCallSignal(to: string, data: unknown) {
    send({ type: "signal", to, data: { channel: "call", ...(data as object) } });
  }

  function createCallPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const localStream = getLocalStreamForCalls();
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

  function stopOwnCallLocalStream() {
    // só para track que ESSE hook capturou sozinho (getUserMedia de
    // chamada sem sala, ver joinCall abaixo) -- NUNCA mexe em
    // ambientStreamRef, isso é de quem chamou (a sala), continua
    // precisando dele rodando mesmo depois de sair da chamada.
    callLocalStreamRef.current?.getTracks().forEach((t) => t.stop());
    callLocalStreamRef.current = null;
  }

  async function joinCall(conversationId: string) {
    if (myCallConversationId === conversationId) return;
    if (myCallConversationId) {
      send({ type: "call:leave", conversationId: myCallConversationId });
      closeAllCallPeers();
    }
    if (!getLocalStreamForCalls()) {
      let stream: MediaStream;
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: selectedCamId ? { deviceId: { exact: selectedCamId } } : true,
            audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } catch (e) {
        console.warn("Sem acesso a câmera/microfone -- não foi possível entrar na chamada.", e);
        return;
      }
      stream.getAudioTracks().forEach((t) => (t.enabled = micOn));
      stream.getVideoTracks().forEach((t) => (t.enabled = camOn));
      callLocalStreamRef.current = stream;
    }
    setMyCallConversationId(conversationId);
    send({ type: "call:join", conversationId });
  }

  function leaveCall() {
    if (!myCallConversationId) return;
    send({ type: "call:leave", conversationId: myCallConversationId });
    setMyCallConversationId(null);
    closeAllCallPeers();
    stopOwnCallLocalStream();
  }

  // aplica mudar mic/cam (av-bar) numa chamada JÁ em andamento, só na
  // track que esse hook capturou por conta própria -- se a chamada tá
  // reaproveitando stream ambiente (dentro da sala), quem liga/desliga
  // essa track é o dono dela (ver toggleMic/toggleCam de GameRoom.tsx),
  // não esse hook.
  useEffect(() => {
    if (!ambientStreamRef?.current?.active) {
      callLocalStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = micOn));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn]);
  useEffect(() => {
    if (!ambientStreamRef?.current?.active) {
      callLocalStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = camOn));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn]);

  // --- conexão: abre uma vez por (userId, token), vive até o
  // componente que montou esse hook (Home(), ver comentário grande no
  // topo) desmontar -- o que só acontece fechando a aba de verdade. ---
  useEffect(() => {
    const socket = new PartySocket({ host: REALTIME_HOST, room: PLATFORM_SOCKET_ROOM });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      socket.send(
        JSON.stringify({
          type: "identify",
          userId: myUserId,
          accessToken: accountAccessToken,
          name: myName,
          photoUrl: accountProfile?.photoUrl || "",
        })
      );
      if (myCallConversationIdRef.current) {
        socket.send(JSON.stringify({ type: "call:join", conversationId: myCallConversationIdRef.current }));
      }
    });

    socket.addEventListener("close", () => setConnected(false));

    socket.addEventListener("message", (evt) => {
      let data: any;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }
      switch (data.type) {
        case "init": {
          selfIdRef.current = data.selfId;
          break;
        }
        case "chat:conversations": {
          const list = (data.conversations as Conversation[]).slice().sort((a, b) => b.updatedAt - a.updatedAt);
          setConversations(list);
          break;
        }
        case "chat:conversation": {
          const conv = data.conversation as Conversation;
          setConversations((prev) => {
            const rest = prev.filter((c) => c.id !== conv.id);
            return [conv, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
          });
          if (autoOpenNextConversationRef.current) {
            autoOpenNextConversationRef.current = false;
            setActiveConversationId(conv.id);
            setChatView("thread");
            socket.send(JSON.stringify({ type: "chat:open", conversationId: conv.id }));
          }
          break;
        }
        case "chat:conversation_removed": {
          const removedId = data.conversationId as string;
          setConversations((prev) => prev.filter((c) => c.id !== removedId));
          setMessagesByConv((prev) => {
            if (!(removedId in prev)) return prev;
            const next = { ...prev };
            delete next[removedId];
            return next;
          });
          if (activeConversationIdRef.current === removedId) {
            setActiveConversationId(null);
            setChatView("list");
          }
          break;
        }
        case "chat:history": {
          setMessagesByConv((prev) => ({ ...prev, [data.conversationId]: data.messages }));
          if (typeof data.unreadSinceTs === "number") {
            setUnreadSinceTsByConv((prev) => ({ ...prev, [data.conversationId]: data.unreadSinceTs }));
          }
          setPinsByConv((prev) => ({ ...prev, [data.conversationId]: (data.pins as ChatPin[]) ?? [] }));
          setLastReadByConv((prev) => ({
            ...prev,
            [data.conversationId]: (data.lastRead as Record<string, number>) ?? {},
          }));
          setConversations((prev) => prev.map((c) => (c.id === data.conversationId ? { ...c, unreadCount: 0 } : c)));
          break;
        }
        case "chat:message_deleted": {
          const { conversationId, messageId } = data as { conversationId: string; messageId: string };
          setMessagesByConv((prev) => {
            const list = prev[conversationId];
            if (!list) return prev;
            return {
              ...prev,
              [conversationId]: list.map((m) => (m.id === messageId ? { ...m, deleted: true, text: "", attachment: null } : m)),
            };
          });
          break;
        }
        case "chat:message": {
          const msg = data.message as ChatMsg;
          setMessagesByConv((prev) => ({
            ...prev,
            [data.conversationId]: [...(prev[data.conversationId] ?? []), msg],
          }));
          const isMine = msg.senderId === myUserId;
          if (!isMine && readingConversationIdRef.current === data.conversationId) {
            socket.send(JSON.stringify({ type: "chat:open", conversationId: data.conversationId }));
          }
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === data.conversationId);
            if (idx === -1) return prev;
            const bumpUnread = !isMine && readingConversationIdRef.current !== data.conversationId;
            const updated: Conversation = {
              ...prev[idx],
              updatedAt: msg.ts,
              unreadCount: bumpUnread ? (prev[idx].unreadCount ?? 0) + 1 : prev[idx].unreadCount ?? 0,
              lastMessage: { senderId: msg.senderId, senderName: msg.senderName, kind: msg.kind, text: msg.text, ts: msg.ts },
            };
            const rest = prev.filter((c) => c.id !== data.conversationId);
            return [updated, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
          });
          break;
        }
        case "chat:reaction": {
          const { conversationId, messageId, reactions } = data as {
            conversationId: string;
            messageId: string;
            reactions: Record<string, string[]>;
          };
          setMessagesByConv((prev) => {
            const list = prev[conversationId];
            if (!list) return prev;
            return { ...prev, [conversationId]: list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) };
          });
          break;
        }
        case "chat:pins": {
          const { conversationId, pins } = data as { conversationId: string; pins: ChatPin[] };
          setPinsByConv((prev) => ({ ...prev, [conversationId]: pins }));
          break;
        }
        case "chat:typing": {
          const { conversationId, userId, name } = data as { conversationId: string; userId: string; name: string };
          if (userId === myUserId || !conversationId) break;
          const entry: ChatTypingEntry = { userId, name, ts: Date.now() };
          setTypingByConv((prev) => ({
            ...prev,
            [conversationId]: [...(prev[conversationId] ?? []).filter((t) => t.userId !== userId), entry],
          }));
          break;
        }
        case "chat:read": {
          const { conversationId, userId, ts } = data as { conversationId: string; userId: string; ts: number };
          setLastReadByConv((prev) => ({
            ...prev,
            [conversationId]: { ...(prev[conversationId] ?? {}), [userId]: ts },
          }));
          break;
        }
        case "chat:attachments": {
          const { conversationId, items } = data as { conversationId: string; items: ChatAttachmentItem[] };
          if (activeConversationIdRef.current === conversationId) setFilesPanelItems(items);
          break;
        }
        case "signal": {
          if (data.data && data.data.channel === "call") handleCallSignal(data.from, data.data);
          break;
        }
        case "call:state": {
          const conversationId = data.conversationId as string;
          const participants = data.participants as ChatCallParticipant[];
          setCallParticipantsByConversation((prev) => ({ ...prev, [conversationId]: participants }));
          if (myCallConversationIdRef.current === conversationId) {
            const stillIn = participants.some((p) => p.userId === myUserId);
            if (!stillIn) {
              myCallConversationIdRef.current = null;
              setMyCallConversationId(null);
              closeAllCallPeers();
              stopOwnCallLocalStream();
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
          break;
        }
        case "error": {
          console.warn("Erro do servidor de chat (plataforma)", data.message);
          break;
        }
        default:
          break;
      }
    });

    socket.addEventListener("error", (err) => {
      console.warn("Erro na conexão da plataforma (chat/chamada)", err);
    });

    return () => {
      socket.close();
      socketRef.current = null;
      closeAllCallPeers();
      stopOwnCallLocalStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId, accountAccessToken]);

  // espelha "tô literalmente vendo essa conversa agora" pro handler de
  // "chat:message" (fechado dentro do efeito acima) -- mesmo padrão de
  // readingConversationIdRef em GameRoom.tsx. Quem monta esse hook
  // decide quando "ver" de verdade conta (chatOpen && view==="thread"),
  // ver updateReadingState abaixo.
  function updateReadingState(isDrawerOpenOnThisConversation: boolean) {
    readingConversationIdRef.current = isDrawerOpenOnThisConversation ? activeConversationId : null;
  }
  const totalUnreadMessages = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    [conversations]
  );

  return {
    connected,
    myUserId,
    setRoomContext,
    // conversas/mensagens
    conversations,
    chatView,
    setChatView,
    activeConversationId,
    openConversation,
    messagesByConv,
    unreadSinceTsByConv,
    pinsByConv,
    typingByConv,
    lastReadByConv,
    totalUnreadMessages,
    updateReadingState,
    // composer de conversa (Sala usa o PRÓPRIO composer, fora daqui)
    composerText,
    setComposerText,
    onSendComposer,
    sendChatAttachment,
    sendRoomCard,
    deleteMessage,
    toggleReaction,
    pinMessage,
    unpinMessage,
    sendTypingNotification,
    pendingMentionIds,
    setPendingMentionIds,
    moveConversationLane,
    // nova conversa / criar grupo
    newConvMode,
    changeNewConvMode,
    newConvSelection,
    toggleNewConvSelection,
    newConvName,
    setNewConvName,
    submitNewConversation,
    newConvFilter,
    setNewConvFilter,
    newConvQuery,
    setNewConvQuery,
    newConvSearchResults,
    newConvFriends,
    startDirectWith,
    // grupo
    renamingGroup,
    setRenamingGroup,
    groupNameDraft,
    setGroupNameDraft,
    submitRenameGroup,
    // anexo/áudio
    sendingAttachment,
    recordingAudio,
    recordingElapsedSec,
    recordedPreview,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    discardRecordedAudio,
    sendRecordedAudio,
    // painel de arquivos
    filesPanelOpen,
    filesPanelItems,
    filesPanelFilter,
    setFilesPanelFilter,
    filesPanelQuery,
    setFilesPanelQuery,
    openFilesPanel,
    closeFilesPanel,
    mentionAttachmentInChat,
    // chamada
    callParticipantsByConversation,
    myCallConversationId,
    callRemoteStreams,
    joinCall,
    leaveCall,
    callLocalStreamRef,
  };
}
