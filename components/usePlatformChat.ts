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

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import PartySocket from "partysocket";
import { resolveUserId } from "@/lib/identity";
// 1/out -- notificação de mensagem nova (som/toast do navegador) era só
// do GameRoom.tsx (ver fireNotification no handler de "chat:message" de
// lá) -- o Lobby nunca teve. Migrando pra cá os dois ganham igual, sem
// precisar guardar em ref/state: getStoredNotificationPrefs() já lê
// direto do localStorage (ver lib/settingsPrefs.ts), não depende de
// render nenhum, então dá pra chamar fresco a cada mensagem que chega
// dentro do efeito de conexão (vida longa) sem closure velha.
import { fireNotification, getStoredNotificationPrefs } from "@/lib/settingsPrefs";
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
  // 2/out -- tipos da Agenda (ver comentário grande dela mais abaixo),
  // mesmo padrão dos de chat acima: só tipos, nunca valor em tempo de
  // execução importado desse módulo gigante.
  CallEvent,
  AgendaFormState,
  DirectoryUser,
} from "@/components/GameRoom";

// MESMO nome reservado que LOBBY_SOCKET_ROOM_ID em server/index.js --
// nunca vira jogador fantasma numa sala de verdade (ver
// handleLobbySocketConnection lá, que não toca em getRoom/roomStore/
// áreas/portas, só fala o protocolo de chat/chamada que não depende de
// posição nenhuma).
const PLATFORM_SOCKET_ROOM = "__lobby__";
const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
// 2/out -- bug real do Douglas: "tentei anexar um arquivo na conversa e
// deu erro" / "audio tbm" (ERR_SSL_PROTOCOL_ERROR no console, upload
// tentando HTTPS num servidor que só fala HTTP). A lógica antiga aqui
// ("REALTIME_HOST.startsWith('127.0.0.1') ? http : https") só acertava
// localhost -- testando pelo celular/outro aparelho na mesma rede
// (NEXT_PUBLIC_REALTIME_HOST = IP da rede local, tipo 192.168.1.156,
// não começa com "127.0.0.1") caía no "https" por padrão, só que o
// server/index.js local é HTTP simples, sem certificado -- daí o
// ERR_SSL_PROTOCOL_ERROR. Lobby.tsx e GameRoom.tsx já tinham essa
// mesma constante corrigida (espelha window.location.protocol da
// própria página -- se a página carregou em HTTP, o realtime tá no
// mesmo servidor/rede, também HTTP; só muda em produção de verdade,
// onde a própria página já é HTTPS), só esse hook (criado depois,
// 1/out) ficou com a versão velha -- agora as 3 cópias usam a MESMA
// lógica.
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
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

// formatadores/combinadores de data da Agenda (ver uso em
// startNewCall/submitCreateCall mais abaixo) -- 2/out, bug real do
// Douglas no deploy do Vercel ("ReferenceError: window is not defined"
// pré-renderizando "/"): essas 3 funções MORAM em GameRoom.tsx
// (exportadas de lá pro AgendaDrawer.tsx usar, que já roda atrás de um
// dynamic(ssr:false) -- ver comentário grande dele em app/page.tsx),
// mas tinham sido IMPORTADAS aqui como valor (`import {...} from
// "@/components/GameRoom"`) -- isso quebra a mesma regra que
// pickSupportedAudioMimeType/uploadChatFile acima já seguem ("esse
// hook não pode importar nada em tempo de execução do módulo gigante
// do GameRoom, só os TIPOS") -- GameRoom.tsx importa Phaser no topo, e
// esse hook roda SEM dynamic() nenhum (é um hook, chamado direto em
// PlatformChatHost/app/page.tsx), então o módulo inteiro (Phaser
// incluso) ia pro bundle do SERVIDOR da Home e quebrava o build.
// DUPLICADAS aqui (funções pequenas, nenhuma lógica nova) em vez de
// importadas -- mesmo espírito das de cima.
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTimeStr(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function combineLocalDateTime(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return NaN;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
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
  // própria pessoa já tem. Isso NÃO é fixo desde o mount (o hook
  // monta ANTES de qualquer uma das duas telas saber disso -- ver
  // PlatformChatHost em app/page.tsx).
  //
  // 2/out, ISOLAMENTO de verdade (Douglas, depois do loop que
  // derrubou as conversas: "toda hora aparece um novo, porque voce
  // nao isola esse chat cara ja falei, o chat tem que ser uma coisa
  // só") -- a busca de nome+logo (fetch /api/room/company-profile)
  // SAIU DAQUI de vez, foi pro hook useRoomCompanyProfile.ts (UMA
  // implementação, chamada por Lobby.tsx E GameRoom.tsx, mas cada
  // chamada com seu PRÓPRIO estado isolado -- nunca mora dentro deste
  // componente/hook). Esse motor único só guarda SLUG/NOME/LOGO como
  // STRINGS PRIMITIVAS separadas (nunca um objeto {slug,name,logoUrl}
  // montado na hora) -- é isso que torna o loop de antes IMPOSSÍVEL
  // de verdade, não só "temos cuidado pra não fazer de novo": React
  // compara primitivas por VALOR sozinho, então chamar setRoomContext
  // de novo com os mesmos slug/nome/logo nunca produz uma mudança de
  // estado, nunca re-renderiza, nunca pode entrar em loop -- não
  // importa quantos lugares chamem isso nem com que frequência.
  const [roomContextSlug, setRoomContextSlug_] = useState<string | null>(null);
  const [roomContextName, setRoomContextName_] = useState<string | null>(null);
  const [roomContextLogoUrl, setRoomContextLogoUrl_] = useState<string | null>(null);
  // identidade estável (useCallback) -- quem chama isso faz
  // `useEffect(() => chat.setRoomContext(...), [chat, ...])`, e o
  // retorno do hook inteiro não é memoizado (ver "return {" lá
  // embaixo); mesmo sem isso o uso de primitivas acima já impede o
  // loop, mas a identidade estável evita até o efeito disparar à toa.
  const setRoomContext = useCallback((slug: string | null, name: string | null, logoUrl: string | null) => {
    setRoomContextSlug_(slug);
    setRoomContextName_(name);
    setRoomContextLogoUrl_(logoUrl);
  }, []);
  // objeto de conveniência pra quem lê (ver roomContext?.slug mais
  // abaixo) -- useMemo com deps PRIMITIVAS: só monta um objeto novo
  // quando slug/nome/logo de fato mudam de valor, nunca a cada
  // render. Seguro mesmo sendo um objeto, porque mora SÓ aqui dentro
  // (ninguém de fora monta esse objeto e manda de volta pra cá).
  const roomContext = useMemo(
    () => (roomContextSlug ? { slug: roomContextSlug, name: roomContextName, logoUrl: roomContextLogoUrl } : null),
    [roomContextSlug, roomContextName, roomContextLogoUrl]
  );

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
  // "responder mensagem" (2/out, pedido do Douglas: "Dar dois clique na
  // mensagem ativar a resposta a mensagem") -- rascunho local de "to
  // que tô respondendo agora" (mesmo espírito de groupNameDraft acima:
  // efêmero, só do composer ATIVO, nunca sincronizado/persistido até
  // a mensagem sair de verdade -- ver onSendComposer abaixo). Guarda
  // só o que o balão de resposta precisa mostrar (nome/preview), não
  // a mensagem inteira.
  const [replyingTo, setReplyingTo] = useState<{
    messageId: string;
    senderName: string;
    kind: ChatMsgKind;
    text: string;
    attachmentName: string | null;
    // "na conversa precisa aparecer a resposta selecionada ao
    // arquivo, igual no whats" (2/out) -- mesma miniatura de verdade
    // do replyTo congelado no servidor (ver comentário grande em
    // addMessage/chatStore.js), só que pro RASCUNHO ainda não enviado
    // (barra "Respondendo a..." acima do composer).
    attachmentUrl: string | null;
  } | null>(null);

  function startReplyToMessage(msg: { id: string; senderId: string; senderName: string; kind: ChatMsgKind; text: string; attachment: ChatAttachment | null }) {
    setReplyingTo({
      messageId: msg.id,
      senderName: msg.senderName || "Alguém",
      kind: msg.kind,
      text: msg.text,
      attachmentName: msg.attachment?.name ?? null,
      attachmentUrl: msg.attachment?.url ?? null,
    });
  }

  function cancelReply() {
    setReplyingTo(null);
  }
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

  // "Silenciar"/"Apagar conversa" (2/out, pedido do Douglas) -- ver
  // comentário grande de handleChatMute/handleChatHide em
  // server/index.js. Os dois só respondem pra mim mesmo (chat:conversation/
  // chat:conversation_removed, já tratados nos cases logo acima --
  // nenhum handler NOVO precisou entrar no switch desse hook).
  function muteConversation(conversationId: string, muted: boolean) {
    send({ type: "chat:mute", conversationId, muted });
  }

  function deleteConversation(conversationId: string) {
    send({ type: "chat:hide", conversationId });
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
    // trocar de conversa cancela a resposta em andamento -- responder
    // só faz sentido dentro da MESMA conversa de quem foi respondido
    // (replyToMessageId só casa com mensagem da mesma conversa, ver
    // addMessage em server/chatStore.js).
    setReplyingTo(null);
    if (id !== null && !messagesByConv[id]) {
      send({ type: "chat:open", conversationId: id });
    }
  }

  const [sendingAttachment, setSendingAttachment] = useState(false);

  function onSendComposer() {
    const text = composerText.trim();
    if (!text || activeConversationId === null) return;
    if (
      !send({
        type: "chat:send",
        conversationId: activeConversationId,
        text,
        mentionedUserIds: pendingMentionIds,
        replyToMessageId: replyingTo?.messageId ?? null,
      })
    ) {
      return;
    }
    setComposerText("");
    setPendingMentionIds([]);
    setReplyingTo(null);
  }

  async function sendChatAttachment(file: Blob, filename: string, kind: ChatAttachmentKind) {
    if (activeConversationId === null) return;
    setSendingAttachment(true);
    try {
      const attachment = await uploadChatFile(file, filename);
      send({
        type: "chat:send",
        conversationId: activeConversationId,
        attachment,
        kind,
        replyToMessageId: replyingTo?.messageId ?? null,
      });
      setReplyingTo(null);
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
  // PARA, preview, só manda quando confirma). 1/out (unificação
  // Lobby/GameRoom) -- isso ERA duas implementações separadas (uma
  // aqui, mais simples, usada só pelo Lobby; outra em GameRoom.tsx,
  // que reaproveitava a track de áudio da sala pra evitar pedir um
  // SEGUNDO getUserMedia do mesmo microfone -- dois getUserMedia de
  // áudio ao mesmo tempo do mesmo aparelho fazem alguns navegadores
  // aplicarem cancelamento de eco entre as duas capturas e silenciam
  // uma delas). Douglas, 1/out: "nao tem que ter chat de fora chat de
  // dentro, tem que ter CHAT" -- gravar áudio é parte do chat, então
  // vira UMA implementação só, aqui: usa ambientStreamRef (ver
  // PlatformChatParams) quando tiver uma track de áudio viva (dentro
  // da sala), ou pede getUserMedia próprio quando não tiver (Lobby,
  // que não tem sala nenhuma rodando).
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordedPreview, setRecordedPreview] = useState<{ url: string; durationSec: number } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordedBlobRef = useRef<Blob | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef(0);
  const discardRecordingRef = useRef(false);
  // 2/out: generalizado de "recordingErrorHandler" pra "toastHandler" --
  // mesma ideia (o hook não tem UI nenhuma pra avisos visuais, só guarda
  // um callback opcional que o chamador registra, ver setToastHandler no
  // retorno e o useEffect em GameRoom.tsx que registra showErrorToast),
  // só que agora reusado pra QUALQUER aviso que o motor único precisa
  // mostrar -- começou só com "microfone falhou" (catch de
  // startVoiceRecording), ganhou "convite/lembrete de compromisso" e
  // "falha ao anexar arquivo na agenda" junto da migração da Agenda pro
  // mesmo motor (ver comentário grande dela mais abaixo). Mesmo
  // princípio de sempre: UM mecanismo de toast, não um por feature. O
  // Lobby não registra nada ainda, continua só logando no console /
  // sem notificação visual (mesma lacuna que já existia só pro
  // microfone, agora também vale pra agenda -- não é regressão nova).
  const toastHandlerRef = useRef<((message: string) => void) | null>(null);
  function setToastHandler(fn: ((message: string) => void) | null) {
    toastHandlerRef.current = fn;
  }

  async function startVoiceRecording() {
    try {
      // clona a track de áudio ambiente (câmera/mic já capturados pela
      // sala, ver ambientStreamRef) em vez de abrir uma segunda captura
      // -- ver comentário grande acima. Clona (não mexe na original,
      // que continua servindo a sala/chamada) e força enabled=true --
      // gravar não deveria depender do mic da sala estar ligado/
      // desligado.
      const ambientAudioTrack = ambientStreamRef?.current?.getAudioTracks()[0];
      let stream: MediaStream;
      if (ambientAudioTrack && ambientAudioTrack.readyState === "live") {
        const cloned = ambientAudioTrack.clone();
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
      toastHandlerRef.current?.("Não deu pra acessar o microfone -- verifique a permissão do navegador.");
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

  // 1/out -- trocar de microfone/câmera (ver switchMicDevice/
  // switchCamDevice em GameRoom.tsx) precisa reencaminhar a track NOVA
  // pros peers de uma chamada de conversa em andamento também, igual já
  // fazia pros peers de proximidade da Sala -- sem isso, trocar o
  // aparelho com uma chamada de conversa ativa deixaria o OUTRO lado
  // ainda ouvindo/vendo o aparelho antigo. callPeersRef é interno daqui
  // (a sala não tem acesso), por isso essa função fica exposta pro
  // chamador usar no lugar de mexer no Map direto.
  function replaceCallTrack(newTrack: MediaStreamTrack) {
    callPeersRef.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === newTrack.kind);
      sender?.replaceTrack(newTrack);
    });
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

  // ---------------------------------------------------------------
  // 2/out -- pedido direto do Douglas, mesmo espírito da migração do
  // chat pra "motor único" (ver comentário grande no topo do arquivo):
  // "quero ela [a agenda] toda isolada tambem, e sistema unico, assim
  // como o chat, funcionando acima de tudo, acima de lobby acima de
  // jogo". Até aqui a Agenda vivia em dois donos de estado diferentes
  // -- GameRoom.tsx com socket de verdade (tempo real, lembrete,
  // convite) e Lobby.tsx com REST (sem tempo real nenhum, "Agenda
  // continua REST" era o comentário antigo) -- a MESMA "unificação só
  // de aparência" que o chat tinha antes do commit e5c060c. Esse bloco
  // é a MESMA conexão PLATFORM_SOCKET_ROOM de sempre (ver topo do
  // arquivo), falando agenda:* (handleAgenda* em server/index.js,
  // chamados agora também de handleLobbySocketConnection -- ver
  // comentário grande deles) em vez de reabrir uma segunda conexão só
  // pra isso. Tipos/estado migrados de GameRoom.tsx 1:1, nenhuma
  // lógica nova.
  // ---------------------------------------------------------------
  const [calls, setCalls] = useState<CallEvent[]>([]);
  // quem, dos candidatos a convidado, já tá ocupado no horário sendo
  // escolhido AGORA no formulário -- ver getConflictingUserIds em
  // server/agendaStore.js.
  const [busyUserIds, setBusyUserIds] = useState<string[]>([]);
  // aberta/fechada -- estado único (não um por tela) de propósito: é
  // isso que faz a gaveta "funcionar acima de tudo, acima de lobby
  // acima de jogo" (pedido do Douglas) em vez de precisar abrir de
  // novo ao trocar de tela.
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaView, setAgendaView] = useState<"list" | "new" | "detail" | "colleague">("list");
  const [agendaDetailId, setAgendaDetailId] = useState<string | null>(null);
  // espelha agendaDetailId pro handler de socket (fechado dentro do
  // useEffect de conexão, que só roda uma vez) ler o valor ATUAL sem
  // stale closure -- mesmo padrão de agendaColleagueIdRef logo abaixo,
  // usado pelo push de "agenda:call_deleted" (ver handleAgendaDelete em
  // server/index.js).
  const agendaDetailIdRef = useRef<string | null>(null);
  agendaDetailIdRef.current = agendaDetailId;
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
  // Agenda estão expandidos agora. Hoje começa aberto.
  const [expandedAgendaDays, setExpandedAgendaDays] = useState<Set<string>>(() => new Set([localDateStr(new Date())]));
  // todo mundo já cadastrado no ambiente (GET /users/directory, MESMA
  // lista que chatStore.listAllUsers() devolve) -- usado no picker de
  // participantes do "Marcar compromisso" e em "pesquise a agenda de
  // um colega". REST (não socket) de propósito: é o mesmo diretório
  // platform-wide que o Lobby já buscava assim pro Contatos (ver
  // handleGetUsersDirectory em server/index.js) -- não depende de sala
  // nem precisa viajar em tempo real.
  const [allUsers, setAllUsers] = useState<DirectoryUser[]>([]);
  useEffect(() => {
    fetch(`${REALTIME_HTTP_BASE}/users/directory`)
      .then((res) => res.json())
      .then((data) => setAllUsers((data.users as DirectoryUser[]) ?? []))
      .catch(() => {});
  }, []);
  const agendaCreatingRef = useRef(false);
  // id do compromisso sendo EDITADO agora (null = formulário "new" é
  // de criação de verdade) -- 2/out, junto de editar/apagar virarem
  // parte do protocolo único (agenda:update/agenda:delete, ver
  // handleAgendaUpdate/handleAgendaDelete em server/index.js). Editar
  // reaproveita a MESMA tela "new" (startEditCall pré-popula
  // agendaForm a partir da call existente) -- só NÃO mexe em quem foi
  // convidado (mesma trava de sempre: participantes só se define na
  // criação, nem o servidor aceita participantIds no update).
  const [editingCallId, setEditingCallId] = useState<string | null>(null);
  // "pesquise a agenda de um colega" -- campo de busca + a agenda do
  // colega escolhido (calls privadas em que eu não participo chegam
  // tarjadas, ver agenda:view_colleague em server/index.js).
  const [agendaSearchQuery, setAgendaSearchQuery] = useState("");
  const [agendaColleagueId, setAgendaColleagueId] = useState<string | null>(null);
  const [agendaColleagueName, setAgendaColleagueName] = useState("");
  const [colleagueCalls, setColleagueCalls] = useState<CallEvent[]>([]);
  // espelha agendaColleagueId pro handler de socket (fechado dentro do
  // useEffect de conexão, que só roda uma vez) conseguir ler o valor
  // ATUAL sem stale closure -- mesmo padrão de sempre (ver
  // conversationsRef/activeConversationIdRef acima).
  const agendaColleagueIdRef = useRef<string | null>(null);
  agendaColleagueIdRef.current = agendaColleagueId;

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
          // pedido do Douglas, 30/set (5): "permitir notificacoes de
          // conversas privadas? conversas de empresa?" -- só notifica
          // mensagem de OUTRA pessoa e só se o toggle certo (privateChats/
          // companyChats, conforme a lane da conversa) tá ligado -- MESMA
          // regra que já existia só em GameRoom.tsx.
          if (!isMine) {
            const sourceConv = conversationsRef.current.find((c) => c.id === data.conversationId);
            const lane = sourceConv?.lane;
            const prefs = getStoredNotificationPrefs();
            // "Silenciar" (2/out, pedido do Douglas) -- trava POR CIMA
            // do toggle geral privateChats/companyChats (prefs acima):
            // mensagem continua contando unreadCount normal (ver
            // bumpUnread logo abaixo), só não dispara toast/notificação.
            const allowed =
              !sourceConv?.muted &&
              (lane === "private" ? prefs.privateChats : lane === "company" ? prefs.companyChats : false);
            if (allowed) {
              const preview =
                msg.kind === "text"
                  ? msg.text
                  : msg.kind === "image"
                    ? "📷 Foto"
                    : msg.kind === "audio"
                      ? "🎤 Áudio"
                      : msg.kind === "room_card"
                        ? "🔑 Convite de sala"
                        : "📎 Arquivo";
              fireNotification(msg.senderName || "Nova mensagem", preview);
            }
          }
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
        // 2/out -- Agenda migrada pro motor único (ver comentário grande
        // no bloco de estado dela acima) -- MESMO corpo que vivia em
        // handlePartyMessage de GameRoom.tsx, só trocando setToasts
        // (UI que esse hook não tem) por toastHandlerRef (ver
        // comentário grande dele lá em cima, mesmo mecanismo que já
        // existia pra "microfone falhou").
        case "agenda:calls": {
          setCalls((data.calls as CallEvent[]).slice().sort((a, b) => a.startTs - b.startTs));
          break;
        }
        case "agenda:call": {
          const call = data.call as CallEvent;
          setCalls((prev) => {
            const rest = prev.filter((c) => c.id !== call.id);
            return [...rest, call].sort((a, b) => a.startTs - b.startTs);
          });
          // se essa call é a que EU acabei de marcar (ver
          // submitCreateCall/agendaCreatingRef), pula direto pro
          // detalhe dela -- os outros convidados só recebem pra
          // aparecer na LISTA deles, sem pular sozinho (mesmo padrão
          // de autoOpenNextConversationRef no chat).
          if (agendaCreatingRef.current && call.createdBy === myUserId) {
            agendaCreatingRef.current = false;
            setAgendaError(null);
            setAgendaDetailId(call.id);
            setAgendaView("detail");
          }
          break;
        }
        // 2/out -- push de "agenda:delete" (ver handleAgendaDelete em
        // server/index.js): tira da lista local e, se era justo a call
        // que essa aba tava vendo no detalhe, volta pra lista (senão
        // ficaria olhando o detalhe de um compromisso que não existe
        // mais).
        case "agenda:call_deleted": {
          const deletedId = data.callId as string;
          setCalls((prev) => prev.filter((c) => c.id !== deletedId));
          if (agendaDetailIdRef.current === deletedId) {
            setAgendaDetailId(null);
            setAgendaView("list");
          }
          break;
        }
        case "agenda:availability": {
          setBusyUserIds(data.busyUserIds as string[]);
          break;
        }
        case "agenda:invite": {
          const call = data.call as CallEvent;
          const text = `${call.createdByName || "Alguém"} marcou "${call.title}" com você`;
          toastHandlerRef.current?.(text);
          if (getStoredNotificationPrefs().agenda) fireNotification("Novo compromisso", text);
          break;
        }
        case "agenda:reminder": {
          const call = data.call as CallEvent;
          const text = `"${call.title}" começa em breve`;
          toastHandlerRef.current?.(text);
          if (getStoredNotificationPrefs().agenda) fireNotification("Compromisso começando", text);
          break;
        }
        case "agenda:error": {
          agendaCreatingRef.current = false;
          if (data.reason === "conflict") {
            setBusyUserIds((data.busyUserIds as string[]) ?? []);
            setAgendaError("Algum convidado ficou indisponível nesse horário -- escolha outro e tente de novo.");
          }
          break;
        }
        case "agenda:colleague_calls": {
          // resposta de "pesquise a agenda de um colega" -- só aplica
          // se ainda for o colega que a pessoa tá olhando agora (evita
          // uma resposta atrasada de uma busca anterior sobrescrever a
          // atual).
          if (data.userId === agendaColleagueIdRef.current) {
            setColleagueCalls((data.calls as CallEvent[]).slice().sort((a, b) => a.startTs - b.startTs));
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

  // --- Agenda: ações (ver tipos/estado/socket acima) -- MESMO corpo
  // que vivia em GameRoom.tsx, só trocando wsSend/socketRef.current?.send
  // pelo `send` genérico desse hook (mesma conexão única) e
  // showErrorToast por toastHandlerRef (ver comentário grande dele). ---
  function updateAgendaForm(partial: Partial<AgendaFormState>) {
    setAgendaForm((prev) => ({ ...prev, ...partial }));
  }

  // 2/out, bug do Douglas: "a agenda quando da erro, nao me solta mais,
  // travou em alguem [...] fica dando isso mesmo que eu tire a selecao"
  // -- bloqueava TODO toggle (marcar E desmarcar) de quem tava em
  // busyUserIds. Isso fazia sentido pra impedir MARCAR alguém já
  // indisponível, mas o convidado só vira "indisponível" DEPOIS de já
  // estar selecionado (é o próprio "Marcar compromisso" que descobre o
  // conflito, ver agenda:error/setBusyUserIds em handlePartyMessage) --
  // então a MESMA trava também impedia tirar a seleção dele, prendendo
  // o formulário pra sempre nesse erro (disabled={busy} no checkbox, ver
  // AgendaDrawer, reforçava a mesma trava do lado da UI). Agora só
  // bloqueia ADICIONAR um indisponível; tirar sempre funciona.
  function toggleAgendaParticipant(userId: string) {
    const alreadySelected = agendaForm.participantIds.includes(userId);
    if (busyUserIds.includes(userId) && !alreadySelected) return; // indisponível, não deixa ADICIONAR
    setAgendaForm((prev) => ({
      ...prev,
      participantIds: alreadySelected
        ? prev.participantIds.filter((x) => x !== userId)
        : [...prev.participantIds, userId],
    }));
    // tirou alguém da seleção -- o erro antigo ("algum convidado ficou
    // indisponível") pode não valer mais pra essa seleção nova; some
    // com ele agora (só se não sobrar NINGUÉM indisponível ainda
    // selecionado -- pode ter mais de um), não espera o próximo
    // "Marcar compromisso" pra confirmar (reaparece sozinho se tentar
    // de novo e ainda tiver problema).
    if (alreadySelected) {
      const stillBusy = agendaForm.participantIds.some((id) => id !== userId && busyUserIds.includes(id));
      if (!stillBusy) setAgendaError(null);
    }
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
    setEditingCallId(null);
    setAgendaError(null);
    setBusyUserIds([]);
    setAgendaView("new");
  }

  // "Editar" num compromisso que EU criei (ver botão só-dono em
  // AgendaDrawer, detailCall.createdBy === myUserId) -- pré-popula o
  // MESMO formulário "new" a partir da call existente (mesma ideia do
  // openEditForm que vivia só em LobbyAgendaPanel, migrada pro motor
  // único). participantIds entra no form só pra exibição (AgendaDrawer
  // mostra como lista somente-leitura quando editingCallId existe,
  // nunca dropdown) -- editar nunca manda participantIds pro servidor
  // (ver submitCreateCall abaixo e handleAgendaUpdate em
  // server/index.js, que nem aceita esse campo).
  function startEditCall(call: CallEvent) {
    const d = new Date(call.startTs);
    setAgendaForm({
      title: call.title,
      date: localDateStr(d),
      time: localTimeStr(d),
      durationMinutes: call.durationMinutes,
      participantIds: call.participants.filter((p) => p.id !== myUserId).map((p) => p.id),
      needs: call.needs,
      visibility: call.visibility,
      description: call.description || "",
      attachments: [],
      blocksAgenda: call.blocksAgenda !== false,
    });
    setEditingCallId(call.id);
    setAgendaError(null);
    setBusyUserIds([]);
    setAgendaView("new");
  }

  function submitCreateCall() {
    const startTs = combineLocalDateTime(agendaForm.date, agendaForm.time);
    // participantIds vazio é válido (compromisso só da própria pessoa).
    if (!Number.isFinite(startTs)) {
      setAgendaError("Preenche a data e o horário pra marcar o compromisso.");
      return;
    }
    setAgendaError(null);
    agendaCreatingRef.current = true;
    const ok = editingCallId
      ? send({
          type: "agenda:update",
          callId: editingCallId,
          title: agendaForm.title.trim() || "Call",
          startTs,
          durationMinutes: agendaForm.durationMinutes,
          description: agendaForm.description.trim(),
        })
      : send({
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
    // detalhe da call criada/editada, erro mostra o motivo aqui mesmo).
  }

  // "Apagar" num compromisso que EU criei -- confirmação ("tem certeza?")
  // é responsabilidade de quem chama (AgendaDrawer), igual o
  // window.confirm que o LobbyAgendaPanel antigo já fazia.
  function deleteCall(callId: string) {
    send({ type: "agenda:delete", callId });
  }

  // upload de anexo do "Marcar compromisso" -- mesmo endpoint HTTP do
  // chat (uploadChatFile), só que o resultado fica guardado no
  // FORMULÁRIO (agendaForm.attachments) em vez de mandar na hora.
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
      toastHandlerRef.current?.("Não deu pra anexar o arquivo -- tenta de novo.");
    } finally {
      setSendingAgendaAttachment(false);
    }
  }

  function removeAgendaFormAttachment(index: number) {
    setAgendaForm((prev) => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index) }));
  }

  // anexar arquivo numa call JÁ CRIADA -- manda direto pro servidor
  // (agenda:add_attachment), porque a call já existe.
  async function handleAgendaDetailFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !agendaDetailId) return;
    setSendingDetailAttachment(true);
    try {
      const attachment = await uploadChatFile(file, file.name);
      send({ type: "agenda:add_attachment", callId: agendaDetailId, attachment });
    } catch (err) {
      console.warn("Falha ao anexar arquivo na call", err);
      toastHandlerRef.current?.("Não deu pra anexar o arquivo -- tenta de novo.");
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
    send({ type: "agenda:respond", callId, status });
  }

  // "pesquise a agenda de um colega" -- pede a agenda dele pro servidor
  // (calls privadas em que eu não participo chegam tarjadas) e troca a
  // Agenda pra essa visão.
  function viewColleagueAgenda(userId: string, name: string) {
    setAgendaColleagueId(userId);
    agendaColleagueIdRef.current = userId;
    setAgendaColleagueName(name || "Sem nome");
    setColleagueCalls([]);
    setAgendaView("colleague");
    send({ type: "agenda:view_colleague", userId });
  }

  function backToMyAgenda() {
    setAgendaColleagueId(null);
    agendaColleagueIdRef.current = null;
    setAgendaColleagueName("");
    setColleagueCalls([]);
    setAgendaSearchQuery("");
    setAgendaView("list");
  }

  // checagem de disponibilidade AO VIVO enquanto o formulário "Marcar
  // call" tá aberto -- a cada mudança de data/hora/duração/participante,
  // pergunta pro servidor quem dos JÁ SELECIONADOS fica ocupado nesse
  // horário (ver getConflictingUserIds em server/agendaStore.js), pra
  // já desabilitar/marcar "indisponível" antes de confirmar.
  //
  // 2/out: migrado de GameRoom.tsx junto do resto da Agenda, mas com UM
  // ajuste -- a versão de lá só checava quem tava ONLINE NA SALA agora
  // (remotePlayersRef), não os participantes de verdade selecionados no
  // formulário (que sempre vieram do roster inteiro, allUsers, mesmo
  // offline -- ver comentário de DirectoryUser em GameRoom.tsx). Isso
  // nunca fez sentido fora de uma sala (não existe "quem tá por perto"
  // no Lobby) nem dentro, de verdade (convidar alguém offline era
  // sempre possível, só não teria o aviso prévio) -- trocado pra checar
  // agendaForm.participantIds direto, que é tanto mais correto quanto
  // 100% independente de sala.
  useEffect(() => {
    if (agendaView !== "new") return;
    const startTs = combineLocalDateTime(agendaForm.date, agendaForm.time);
    if (!Number.isFinite(startTs) || agendaForm.participantIds.length === 0) {
      setBusyUserIds([]);
      return;
    }
    const timer = setTimeout(() => {
      send({
        type: "agenda:availability",
        candidateUserIds: agendaForm.participantIds,
        startTs,
        durationMinutes: agendaForm.durationMinutes,
      });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agendaView, agendaForm.date, agendaForm.time, agendaForm.durationMinutes, agendaForm.participantIds]);

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
    roomContext,
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
    replyingTo,
    startReplyToMessage,
    cancelReply,
    setPendingMentionIds,
    moveConversationLane,
    muteConversation,
    deleteConversation,
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
    setToastHandler,
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
    replaceCallTrack,
    // agenda (ver comentário grande dela acima)
    calls,
    busyUserIds,
    agendaOpen,
    setAgendaOpen,
    agendaView,
    setAgendaView,
    agendaDetailId,
    openCallDetail,
    agendaForm,
    updateAgendaForm,
    toggleAgendaParticipant,
    agendaError,
    startNewCall,
    editingCallId,
    startEditCall,
    deleteCall,
    submitCreateCall,
    respondToCall,
    agendaSearchQuery,
    setAgendaSearchQuery,
    agendaColleagueId,
    agendaColleagueName,
    colleagueCalls,
    viewColleagueAgenda,
    backToMyAgenda,
    handleAgendaFileChange,
    removeAgendaFormAttachment,
    sendingAgendaAttachment,
    handleAgendaDetailFileChange,
    sendingDetailAttachment,
    expandedAgendaDays,
    toggleAgendaDay,
    allUsers,
  };
}
