"use client";

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";
import { Avatar } from "@/components/Avatar";
import {
  ChatCallVideoTile,
  MicIcon,
  CamIcon,
  PencilIcon,
  BackIcon,
  CloseIcon,
  FileIcon,
  PlusIcon,
  TrashIcon,
  PIN_DURATION_OPTIONS,
  QUICK_REACTION_EMOJIS,
  attachmentUrl,
  visitRoomLink,
  formatFileSize,
  formatChatTime,
  formatRecordingTime,
  conversationDisplayName,
  previewText,
  type ChatMsg,
  type ChatMessage,
  type ChatMsgKind,
  type ChatPin,
  type ChatTypingEntry,
  type ChatAttachmentItem,
  type Conversation,
  type RemotePlayer,
  type ChatCallParticipant,
} from "./GameRoom";

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

// seta de responder (2/out, pedido do Douglas: "coloca uma selecao em
// cada mensagem tipo o slack" -- botão de resposta visível na barra
// flutuante de ações, ver .chat-message-hover-toolbar/onReply).
function ReplyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M10 8 4.5 12.5 10 17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 12.5H14a5.5 5.5 0 0 1 5.5 5.5v1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// "opcao de Expandir a imagem da chamada" (2/out, pedido do Douglas)
// -- setas apontando pra fora (expandir) ou pra dentro (reduzir,
// expanded=true), mesmo ícone invertendo o path conforme o estado
// (ver callExpanded/chat-call-expand-btn).
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// seta do botão "Convidar amigo / Visitar amigo" (ver chat-invite-toggle-btn) --
// só gira via CSS (.chat-invite-toggle-btn.open), o SVG é sempre o mesmo.
function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 9l7 7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Gaveta de chat "de verdade" -- Sala (nearby, sem histórico, ver
// comentário nos tipos lá em cima) + conversas diretas/grupo com
// histórico persistido no servidor + foto/arquivo/áudio. Tamanho FIXO
// (ver .chat-drawer em globals.css) independente da tela (lista/nova
// conversa/conversa aberta) -- mesma lógica já usada no card de
// perfil, pra não ficar pulando de tamanho.
export function ChatDrawer({
  view,
  onChangeView,
  conversations,
  activeConversationId,
  onOpenConversation,
  messages,
  unreadSinceTs,
  roomChatLog,
  roomUnreadCount = 0,
  hasRoom,
  myUserId,
  onlinePlayers,
  roomCompanyName,
  roomCompanyLogoUrl,
  accountAccessToken,
  callVolume,
  newConvMode,
  onChangeNewConvMode,
  newConvSelection,
  onToggleNewConvSelection,
  newConvName,
  onChangeNewConvName,
  onSubmitNewConversation,
  newConvFilter,
  onChangeNewConvFilter,
  newConvQuery,
  onChangeNewConvQuery,
  newConvSearchResults,
  newConvFriends,
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
  onSendRoomCard,
  onMoveConversationLane,
  onMuteConversation,
  onDeleteConversation,
  replyingTo,
  onStartReply,
  onCancelReply,
  callParticipantsByConversation,
  myCallConversationId,
  callRemoteStreams,
  onJoinCall,
  onLeaveCall,
  localStreamRef,
  camOn,
  // "a chamada em conversa nao deixa desligar a camera" (2/out, pedido
  // do Douglas) -- antes só dava pra mexer no mic/câmera pela av-bar
  // PRINCIPAL da sala (fora da gaveta de chat, ver toggleMic/toggleCam
  // em GameRoom.tsx/Lobby.tsx), que fica fora de vista enquanto a
  // conversa tá aberta/fixada. Mesmas funções/estado de sempre, só
  // expostos de novo aqui -- não é um controle NOVO, é o MESMO (ver
  // chat-call-bar-controls mais abaixo), reaproveitado, não duplicado.
  micOn,
  onToggleMic,
  onToggleCam,
  onClose,
  pinMode,
  onToggleSidePin,
  sidebarClassName,
  onOpenProfile,
  pins,
  typingUsers,
  lastRead,
  onToggleReaction,
  onPinMessage,
  onUnpinMessage,
  onTypingNotify,
  filesPanelOpen,
  filesPanelItems,
  filesPanelFilter,
  onChangeFilesPanelFilter,
  filesPanelQuery,
  onChangeFilesPanelQuery,
  onOpenFilesPanel,
  onCloseFilesPanel,
  onMentionAttachmentInChat,
  pendingMentionIds,
  onAddPendingMentionId,
}: {
  view: "list" | "thread" | "new";
  onChangeView: (v: "list" | "thread" | "new") => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onOpenConversation: (id: string | null) => void;
  messages: ChatMsg[];
  // 29/set (14): ver comentário grande em unreadSinceTsByConv/
  // chatDrawerProps em GameRoom.tsx -- corte "mensagens não vistas" da
  // conversa aberta agora, null pra Sala (isRoom) ou enquanto ainda
  // não chegou do servidor.
  unreadSinceTs: number | null;
  roomChatLog: ChatMessage[];
  // 2/out, pedido do Douglas: "o balaozinho nao veio na conversa da
  // sala" -- ver comentário grande de roomUnreadCount em GameRoom.tsx
  // (chatDrawerProps). Opcional porque o Lobby reaproveita esse MESMO
  // componente sem Sala nenhuma (hasRoom=false, ver abaixo) -- lá nem
  // faz sentido existir, então nem precisa passar.
  roomUnreadCount?: number;
  // 1/out (unificação Lobby/GameRoom, pedido do Douglas: "quero a
  // mesma estrutura nao que seja separado") -- a Sala ("quem ta por
  // perto") só existe DENTRO da sala de verdade (GameRoom.tsx); o
  // Lobby reaproveita esse MESMO componente pro chat de fora, mas não
  // tem Sala nenhuma -- false esconde o item "Sala" da lista (ver JSX
  // logo abaixo) sem precisar de NENHUMA outra mudança de lógica
  // (isRoom continua inatingível pro Lobby, que nunca chama
  // onOpenConversation(null)).
  hasRoom: boolean;
  myUserId: string;
  onlinePlayers: RemotePlayer[];
  roomCompanyName: string | null;
  roomCompanyLogoUrl: string | null;
  accountAccessToken?: string | null;
  callVolume: number;
  // "Conversa" (1:1, padrão) vs "Criar grupo" (pedido do Douglas, 1/out:
  // "quero o criar grupo de forma melhor mais visivel") -- escolhido
  // explicitamente no topo da aba "Nova conversa", ver JSX abaixo.
  newConvMode: "direct" | "group";
  onChangeNewConvMode: (mode: "direct" | "group") => void;
  newConvSelection: string[];
  onToggleNewConvSelection: (userId: string) => void;
  newConvName: string;
  onChangeNewConvName: (v: string) => void;
  onSubmitNewConversation: () => void;
  newConvFilter: "company" | "friends";
  onChangeNewConvFilter: (f: "company" | "friends") => void;
  newConvQuery: string;
  onChangeNewConvQuery: (v: string) => void;
  newConvSearchResults: { userId: string; name: string; photoUrl: string }[] | null;
  newConvFriends: { userId: string; name: string; photoUrl: string }[] | null;
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
  // "Convidar amigo" / "Visitar amigo" -- ver comentário grande em
  // sendRoomCard/GameRoom.tsx.
  onSendRoomCard: (action: "invite" | "visit") => void;
  // "3 pontinhos" -- mover uma conversa 1x1 pra outra lane (Empresa <->
  // Privada, ver comentário grande em moveConversationLane/GameRoom.tsx
  // e setConversationLane em server/chatStore.js).
  onMoveConversationLane: (conversationId: string, lane: "company" | "private") => void;
  // "Silenciar"/"Apagar conversa" (2/out, pedido do Douglas: "nao tem
  // opcao de Silenciar, e de Apagar conversa") -- mesmo menu de "3
  // pontinhos" de cima, só que pra direct E grupo (mover de lane
  // continua só pra direct, ver JSX do menu). Apagar só tira da MINHA
  // lista (ver setConversationHidden em server/chatStore.js) -- nunca
  // apaga de verdade, volta sozinho se chegar mensagem nova ou eu
  // reabrir a conversa.
  onMuteConversation: (conversationId: string, muted: boolean) => void;
  onDeleteConversation: (conversationId: string) => void;
  // "responder mensagem" (2/out, pedido do Douglas: "Dar dois clique
  // na mensagem ativar a resposta a mensagem") -- replyingTo é o
  // rascunho ATUAL (null = não tá respondendo nada), onStartReply
  // dispara no duplo-clique do balão (ver ChatMessageRow), mostrado
  // como uma barrinha "Respondendo a Fulano: ..." acima do composer
  // (ver JSX logo antes do composer). Só existe em conversa de
  // verdade (nunca a Sala, mesma trava de isRoom no resto do arquivo).
  replyingTo: {
    messageId: string;
    senderName: string;
    kind: ChatMsgKind;
    text: string;
    attachmentName: string | null;
    attachmentUrl: string | null;
  } | null;
  onStartReply: (msg: ChatMessage | ChatMsg) => void;
  onCancelReply: () => void;
  callParticipantsByConversation: Record<string, ChatCallParticipant[]>;
  myCallConversationId: string | null;
  callRemoteStreams: Record<string, MediaStream>;
  onJoinCall: (conversationId: string) => void;
  onLeaveCall: () => void;
  localStreamRef: RefObject<MediaStream | null>;
  camOn: boolean;
  micOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onClose: () => void;
  pinMode: "float" | "side";
  onToggleSidePin: () => void;
  // 1/out (unificação Lobby/GameRoom) -- a gaveta fixada precisa de
  // top/bottom DIFERENTES em CSS entre sala e Lobby (o Lobby não tem o
  // layout flex com align-items:stretch que a sala tem, ver comentário
  // grande de .lobby-chat-drawer-shell-sidebar em globals.css) mesmo os
  // NÚMEROS sendo idênticos -- esse prop é só o nome da classe extra
  // que troca por causa disso; undefined (GameRoom) continua usando
  // "chat-drawer-shell-sidebar" de sempre.
  sidebarClassName?: string;
  // 29/set (11): ver comentário grande de onOpenProfile em
  // chatDrawerProps (components/GameRoom.tsx).
  onOpenProfile: (playerId: string) => void;
  // mensagem fixada / "digitando..." / "visto por" (pedido do Douglas,
  // 1/out) -- já vêm da fonte certa (Sala ou conversa, ver comentário
  // grande em chatDrawerProps/GameRoom.tsx), ChatDrawer só desenha.
  pins: ChatPin[];
  typingUsers: ChatTypingEntry[];
  // userId -> ts da última mensagem lida por essa pessoa, só preenchido
  // em conversa de verdade (a Sala não tem "visto por", ver comentário
  // grande em lastReadByConv/GameRoom.tsx).
  lastRead: Record<string, number>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onPinMessage: (messageId: string, durationMs: number | null) => void;
  onUnpinMessage: (messageId: string) => void;
  // chamado a cada tecla do composer enquanto tiver conteúdo (ver
  // comentário grande em sendTypingNotification/GameRoom.tsx -- já vem
  // throttled de lá, ChatDrawer pode chamar em TODA tecla sem pensar).
  onTypingNotify: () => void;
  // painel lateral "arquivos da conversa" (pedido do Douglas, 1/out) --
  // só existe pra conversa de VERDADE aberta (ver comentário grande em
  // openFilesPanel/GameRoom.tsx).
  filesPanelOpen: boolean;
  filesPanelItems: ChatAttachmentItem[] | null;
  filesPanelFilter: "all" | "image" | "file" | "audio";
  onChangeFilesPanelFilter: (f: "all" | "image" | "file" | "audio") => void;
  filesPanelQuery: string;
  onChangeFilesPanelQuery: (v: string) => void;
  onOpenFilesPanel: () => void;
  onCloseFilesPanel: () => void;
  onMentionAttachmentInChat: (item: ChatAttachmentItem) => void;
  // @menção (pedido do Douglas, 1/out) -- ver comentário grande em
  // pendingMentionIds/GameRoom.tsx.
  pendingMentionIds: string[];
  onAddPendingMentionId: (userId: string) => void;
}) {
  const activeConv = conversations.find((c) => c.id === activeConversationId) ?? null;
  const isRoom = activeConversationId === null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeCallParticipants =
    !isRoom && activeConversationId ? callParticipantsByConversation[activeConversationId] ?? [] : [];
  const inActiveCall = !isRoom && myCallConversationId === activeConversationId;
  const localCallStream = localStreamRef.current;
  const [drawerExpanded, setDrawerExpanded] = useState(false);
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

  // 2/out, pedido do Douglas: "nas conversas de ambiente, e sala eu
  // quero a opcao de expandir que ja abra grande, e a pessoa diminua"
  // -- igual o pinBtn acima, um botão SÓ aqui no componente único do
  // chat (ver comentário grande no topo do arquivo), então cobre as
  // DUAS coisas que ele pediu de uma vez (Sala e conversa normal são a
  // MESMA gaveta). Clicar já pula direto pro tamanho grande (não cresce
  // aos poucos); clicar nele de novo (agora "Reduzir") volta ao
  // tamanho normal -- local/efêmero, mesmo espírito de callExpanded
  // (não precisa lembrar entre sessões). Mesmo ExpandIcon que a
  // chamada de vídeo já usa (ver comentário dele lá em cima), só outro
  // botão/estado -- ícone igual, significado igual (setas pra fora =
  // expandir), não é duplicar lógica, é reusar o mesmo símbolo visual.
  const expandBtn = (
    <button
      className={drawerExpanded ? "chat-icon-btn active" : "chat-icon-btn"}
      title={drawerExpanded ? "Reduzir" : "Expandir"}
      onClick={() => setDrawerExpanded((v) => !v)}
    >
      <ExpandIcon expanded={drawerExpanded} />
    </button>
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, roomChatLog.length, view]);

  // painel lateral "arquivos da conversa" (pedido do Douglas, 1/out):
  // "um botao do lado do chat centralizado na borda, igual a seta de
  // editar card empresa, porem com icone de ficheiro, expande do
  // lado" -- position:fixed (escapa do overflow:hidden de
  // .room-and-editor) com "left" calculado a partir da borda DIREITA
  // de verdade da gaveta (ver drawerRef abaixo), em vez de replicar a
  // conta do CSS aqui (ver comentário em filesTrigger/GameRoom.tsx) --
  // mais robusto que um número fixo porque a gaveta muda de largura e
  // de posição sozinha dependendo do pinMode (flutuante vs "fixar na
  // lateral", ver .chat-drawer-sidebar em globals.css) e de ter ou não
  // a coluna de empresas do lado (companyRail) -- mede o elemento de
  // verdade em vez de adivinhar.
  const drawerRef = useRef<HTMLDivElement>(null);
  const [filesRightEdge, setFilesRightEdge] = useState(396);
  // a medição de verdade (useLayoutEffect) fica mais abaixo, depois de
  // showCompanyRail ser declarado (ela depende dele, ver comentário
  // grande lá) -- só o listener de resize da janela já pode ficar aqui,
  // sem depender de mais nada.
  useEffect(() => {
    function onResize() {
      const el = drawerRef.current;
      if (el) setFilesRightEdge(el.getBoundingClientRect().right);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // dedupe por userId -- se alguém tiver 2 abas abertas, ainda aparece
  // uma vez só na lista de "quem tá na sala" (ver onlinePlayers) -- e
  // nunca inclui você mesmo: o servidor ignora silenciosamente um
  // chat:create_direct com targetUserId igual ao seu (ver
  // server/index.js), então sem esse filtro "Iniciar conversa" clicado
  // na sua própria segunda aba não fazia nada, sem erro nenhum (achado
  // 28/set testando com 2 abas da mesma conta).
  const pickable = Array.from(new Map(onlinePlayers.map((p) => [p.userId, p])).values()).filter(
    (p) => p.userId !== myUserId
  );

  // duas abas (pedido do Douglas, 29/set: "vao ter duas abas nas
  // conversas / EmpresaTal / Conversas Privadas") -- "Empresa" é o
  // chat de sempre (Sala + toda conversa direta/grupo criada sem
  // restrição, ver lane "company" em server/chatStore.js), "Privadas"
  // só mostra conversa lane "private" (só existe entre amigos mútuos,
  // ver FriendsPanel.tsx/startConversationFromContacts). "Sala" fica
  // só na aba Empresa -- ela é justamente o chat com quem tá por
  // perto, sem exigir amizade nenhuma.
  const [laneFilter, setLaneFilter] = useState<"company" | "private">("company");
  const laneConversations = conversations.filter((c) => c.lane === laneFilter);
  // 2/out, pedido do Douglas: "recebi uma mensage, e nao tem pontuacao
  // mostrando quantas msg nao lida se é em empresa ou privada, e em
  // qual conversa / quero aqueel balaozinho, com numero encima das
  // tag" -- unreadCount por conversa já existe (ver
  // totalUnreadMessages em usePlatformChat.ts, usado no selo do ÍCONE
  // de chat fechado); faltava separar por aba aqui DENTRO da gaveta
  // aberta. Mesmo "balãozinho" de sempre (.lobby-icon-badge), só que
  // em cima de cada aba em vez de em cima do ícone.
  const companyUnread = useMemo(
    () => conversations.reduce((sum, c) => (c.lane === "company" ? sum + (c.unreadCount ?? 0) : sum), 0) + roomUnreadCount,
    [conversations, roomUnreadCount]
  );
  const privateUnread = useMemo(
    () => conversations.reduce((sum, c) => (c.lane === "private" ? sum + (c.unreadCount ?? 0) : sum), 0),
    [conversations]
  );

  // 29/set (15), pedido do Douglas -- correção do que eu tinha
  // entendido errado antes (selo pequeno em cada linha da lista, ver
  // .chat-conv-company-logo): "eu quero uma aba aberta ao lado do
  // chat" -- uma COLUNA de verdade com a logo de cada empresa que a
  // pessoa tem conversa (lane "company", ver companyName/companyLogoUrl
  // em Conversation lá em cima), do lado do painel, pra trocar entre
  // elas clicando. Só empresas DIFERENTES entre si (dedupe por nome+
  // logo).
  //
  // 29/set (17), correção de novo (Douglas, depois de eu explicar
  // errado que "com 1 empresa só a coluna nem aparece"): "tem que
  // aparecer mesmo so com uma / e nao pode tirar o filtro, somente
  // separado por empresa, nada junto" -- a coluna aparece com 1 empresa
  // só também (não precisa ter O QUE escolher pra fazer sentido existir
  // -- ela também É o rótulo de qual empresa é essa conversa), e a
  // lista NUNCA mostra mais de uma empresa junta: sempre tem uma
  // selecionada (nunca null/"todas"), começando pela primeira que
  // aparecer, e clicar numa logo troca a seleção pra ela (nunca
  // desliga, ver o useEffect logo abaixo e o onClick sem toggle).
  const companyOptions = useMemo(() => {
    const seen = new Map<string, { key: string; name: string; logoUrl: string }>();
    // 30/set, pedido do Douglas: "quero essa aba sempre aberta com o
    // chat, quero que eles vejam a possibilidade, sempre ali" -- a
    // empresa DESSA SALA entra sempre primeiro (mesmo sem nenhuma
    // conversa ainda), ver roomCompanyName/roomCompanyLogoUrl acima.
    if (roomCompanyName) {
      const key = `${roomCompanyName}::${roomCompanyLogoUrl || ""}`;
      seen.set(key, { key, name: roomCompanyName, logoUrl: roomCompanyLogoUrl || "" });
    }
    for (const c of conversations) {
      if (c.lane !== "company" || !c.companyName) continue;
      const key = `${c.companyName}::${c.companyLogoUrl || ""}`;
      if (!seen.has(key)) seen.set(key, { key, name: c.companyName, logoUrl: c.companyLogoUrl || "" });
    }
    return Array.from(seen.values());
  }, [conversations, roomCompanyName, roomCompanyLogoUrl]);
  // "3 pontinhos" -- id da conversa com o menu de mover-de-aba aberto
  // agora (null = nenhum), ver comentário grande em
  // onMoveConversationLane logo abaixo.
  const [convMenuOpenId, setConvMenuOpenId] = useState<string | null>(null);
  // "Convidar amigo" / "Visitar amigo" -- menu que expande do lado do
  // nome na conversa direta (pedido do Douglas, 30/set: "ao lado do
  // nome, um botao com seta clicou expande"), ver JSX no header
  // "thread" mais abaixo.
  const [inviteMenuOpen, setInviteMenuOpen] = useState(false);
  // popover de "emoji rápido" / "tempo de fixação" (pedido do Douglas,
  // 1/out) -- um id só pra lista inteira (igual convMenuOpenId acima),
  // nunca os dois abertos ao mesmo tempo (ver onToggleReactingOpen/
  // onTogglePinningOpen passados pro ChatMessageRow mais abaixo).
  const [reactingMessageId, setReactingMessageId] = useState<string | null>(null);
  const [pinningMessageId, setPinningMessageId] = useState<string | null>(null);
  // "abriu ele na galeria, abre o historico de mensagens grudadas
  // nele" (2/out, pedido do Douglas) -- clicar num item do painel
  // "Arquivos da conversa" abre esse visualizador (imagem grande/ícone
  // + toda mensagem que RESPONDEU a mensagem desse anexo, ver
  // repliesTo logo abaixo do JSX do modal). null = fechado.
  const [galleryItem, setGalleryItem] = useState<ChatAttachmentItem | null>(null);
  // "opcao de Expandir a imagem da chamada tbm, expande todas junto"
  // (2/out, pedido do Douglas) -- um toggle SÓ, afeta a grade inteira
  // de vídeos de uma vez (não é um expandir por pessoa) -- efêmero,
  // só enquanto essa gaveta tá montada, não precisa ir pro servidor
  // nem sincronizar com ninguém (preferência de VISUALIZAÇÃO minha,
  // não da chamada).
  const [callExpanded, setCallExpanded] = useState(false);

  // @menção (pedido do Douglas, 1/out) -- dropdown de candidatos, aberto
  // enquanto a pessoa digita "@algumacoisa" no composer; startIndex é a
  // posição do "@" no texto (pra saber o que substituir quando escolhe
  // um candidato, ver insertMention mais abaixo). null = dropdown
  // fechado.
  const [mentionState, setMentionState] = useState<{ query: string; startIndex: number } | null>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const [selectedCompanyKey, setSelectedCompanyKey] = useState<string | null>(null);
  // mantém sempre uma empresa válida selecionada (nunca null enquanto
  // existir pelo menos uma) -- cobre tanto o primeiro carregamento
  // (companyOptions ainda vazio na 1ª renderização, chega depois que
  // "chat:list" responde) quanto a seleção atual "sumir" (ex: a única
  // conversa daquela empresa foi apagada em outra aba).
  useEffect(() => {
    if (companyOptions.length === 0) {
      if (selectedCompanyKey !== null) setSelectedCompanyKey(null);
      return;
    }
    if (!selectedCompanyKey || !companyOptions.some((opt) => opt.key === selectedCompanyKey)) {
      setSelectedCompanyKey(companyOptions[0].key);
    }
  }, [companyOptions, selectedCompanyKey]);
  const showCompanyRail = view === "list" && laneFilter === "company" && companyOptions.length > 0;
  // painel lateral "arquivos da conversa" -- posição do botão/painel
  // medida de verdade no elemento (ver drawerRef lá em cima), em vez de
  // replicar a conta do CSS aqui em JS -- mais robusto porque a gaveta
  // muda de largura/posição sozinha conforme pinMode (flutuante vs
  // "fixar na lateral") e companyRail (coluna de empresas do lado).
  //
  // 1/out: BUG achado por causa do Douglas reportar "bugou o chat fixo,
  // e o chat solto ta pequenininho" -- a versão de antes rodava esse
  // useLayoutEffect SEM array de dependências, depois de QUALQUER
  // render (inclusive os disparados pelo próprio setFilesRightEdge, e
  // os da limpeza de "digitando..." a cada 1s lá em GameRoom.tsx) --
  // getBoundingClientRect pode oscilar por fração de pixel (zoom/escala
  // do navegador), então isso nunca estabilizava: mede -> setState ->
  // re-render -> mede de novo -> setState -- um loop que derrubava a
  // performance e deixava o layout quebrado. Agora só remede quando algo
  // que de verdade muda a largura/posição da gaveta muda (pinMode ou
  // showCompanyRail) + o listener de resize da janela (ver useEffect lá
  // em cima, esse não precisa de dependência -- só registra o listener
  // uma vez, não remede toda hora sozinho).
  useLayoutEffect(() => {
    const el = drawerRef.current;
    if (el) setFilesRightEdge(el.getBoundingClientRect().right);
  }, [pinMode, showCompanyRail]);
  const visibleLaneConversations =
    laneFilter === "company" && selectedCompanyKey
      ? laneConversations.filter((c) => `${c.companyName}::${c.companyLogoUrl || ""}` === selectedCompanyKey)
      : laneConversations;

  const companyRail = showCompanyRail && (
    <div className="chat-company-rail">
      <span className="chat-company-rail-title">Empresas</span>
      <div className="chat-company-rail-list">
        {companyOptions.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={selectedCompanyKey === opt.key ? "chat-company-rail-item active" : "chat-company-rail-item"}
            title={opt.name || "Empresa"}
            onClick={() => setSelectedCompanyKey(opt.key)}
          >
            {opt.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={opt.logoUrl} alt="" />
            ) : (
              <CompanyIcon />
            )}
          </button>
        ))}
      </div>
    </div>
  );

  // @menção (pedido do Douglas, 1/out, comparando com o Slack) -- digitar
  // "@algumacoisa" no composer abre um dropdown pra escolher (ver
  // mentionState acima). 1/out (2): Douglas perguntou "apenas
  // integrantes do grupo obviamente certo?" -- SIM numa conversa de
  // verdade (direta/grupo): só dá pra mencionar quem PARTICIPA dela
  // (ver activeConv.participants), nunca todo mundo online na sala. A
  // Sala é a exceção -- ela não tem "membros" (é literalmente "quem tá
  // por perto" agora), então lá os candidatos continuam vindo de
  // "pickable" (mesmo esquema de sempre). MESMO formato/mesma regra do
  // Lobby.tsx (que só tem conversa de verdade, nunca Sala).
  const mentionSource: { userId: string; name: string }[] = isRoom
    ? pickable.map((p) => ({ userId: p.userId, name: p.name || "?" }))
    : (activeConv?.participants ?? [])
        .filter((p) => p.id !== myUserId)
        .map((p) => ({ userId: p.id, name: p.name || "?" }));
  const mentionCandidates = mentionState
    ? mentionSource.filter((p) => p.name.toLowerCase().includes(mentionState.query.toLowerCase())).slice(0, 6)
    : [];

  function handleComposerInputChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    onChangeComposerText(value);
    // "fulano está digitando..." -- manda enquanto tiver conteúdo (já
    // vem throttled de onTypingNotify, ver GameRoom.tsx), nunca com o
    // campo vazio (não faz sentido "digitando" sem nada digitado).
    if (value.trim()) onTypingNotify();
    const cursor = e.target.selectionStart ?? value.length;
    const upToCursor = value.slice(0, cursor);
    const atIndex = upToCursor.lastIndexOf("@");
    // sem "@" antes do cursor, OU já tem espaço depois dele (a menção
    // "fechou" sozinha, a pessoa seguiu digitando outra coisa) -- fecha
    // o dropdown.
    if (atIndex === -1 || /\s/.test(upToCursor.slice(atIndex + 1))) {
      if (mentionState !== null) setMentionState(null);
      return;
    }
    setMentionState({ query: upToCursor.slice(atIndex + 1), startIndex: atIndex });
  }

  // escolheu um candidato no dropdown -- troca "@query" (ainda sendo
  // digitado) por "@NomeCompleto " (com espaço no fim, pra já poder
  // continuar escrevendo o resto da mensagem) e registra o userId dele
  // em pendingMentionIds (ver comentário grande em GameRoom.tsx -- vai
  // junto quando a mensagem for mandada de verdade).
  function insertMention(candidate: { userId: string; name: string }) {
    if (!mentionState) return;
    const before = composerText.slice(0, mentionState.startIndex);
    const after = composerText.slice(mentionState.startIndex + 1 + mentionState.query.length);
    onChangeComposerText(`${before}@${candidate.name} ${after}`);
    onAddPendingMentionId(candidate.userId);
    setMentionState(null);
    composerInputRef.current?.focus();
  }

  const drawerBody = (
    <div
      ref={drawerRef}
      /* 1/out, pedido do Douglas: "quando abro a conversa ela fica da
         lagura menor, deixe ela do tamanho do card total, juntando com
         o da empresa" -- sem a coluna .chat-company-rail do lado
         (companyRail/showCompanyRail false: acontece sempre que entra
         em "new"/"thread", e também em "list" com 0-1 empresa), a
         gaveta voltava pra sua largura PRÓPRIA (380px flutuante/320px
         fixa) em vez de manter a largura TOTAL que o par rail+gaveta
         tem quando a coluna aparece (472px/412px, ver .chat-drawer-shell/
         -sidebar) -- um "encolhão" visível ao abrir uma conversa.
         .chat-drawer-solo (ver globals.css) força essa mesma largura
         total mesmo sozinha, igual ao pedido de sempre de cartão de
         tamanho FIXO (não quero coisas expansivas/encolhendo). */
      className={
        (pinMode === "side" ? "chat-drawer chat-drawer-sidebar" : "chat-drawer") +
        (companyRail ? "" : " chat-drawer-solo") +
        (drawerExpanded ? " chat-drawer-expanded" : "")
      }
    >
      {view === "list" && (
        <>
          <div className="chat-drawer-header">
            <h3>Chat</h3>
            <div className="chat-drawer-header-actions">
              {pinBtn}
              {expandBtn}
              <button className="chat-icon-btn" title="Nova conversa" onClick={() => onChangeView("new")}>
                <PlusIcon />
              </button>
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="chat-lane-tabs">
            <button
              type="button"
              className={`chat-lane-tab${laneFilter === "company" ? " chat-lane-tab-active" : ""}`}
              onClick={() => setLaneFilter("company")}
            >
              Empresa
              {companyUnread > 0 && <span className="lobby-icon-badge chat-lane-tab-badge">{companyUnread}</span>}
            </button>
            <button
              type="button"
              className={`chat-lane-tab${laneFilter === "private" ? " chat-lane-tab-active" : ""}`}
              onClick={() => setLaneFilter("private")}
            >
              Conversas privadas
              {privateUnread > 0 && <span className="lobby-icon-badge chat-lane-tab-badge">{privateUnread}</span>}
            </button>
          </div>
          <div className="chat-conv-list">
            {hasRoom && laneFilter === "company" && (
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
                {roomUnreadCount > 0 && <span className="chat-conv-unread-badge">{roomUnreadCount}</span>}
              </button>
            )}
            {visibleLaneConversations.map((c) => {
              // botão verde "tipo discord": acende quando tem gente NA
              // CHAMADA dessa conversa agora, mesmo que eu ainda não
              // tenha entrado -- clicar nele já abre a conversa E entra
              // direto na chamada (ver onJoinCall/joinCall).
              const activeCall = callParticipantsByConversation[c.id] ?? [];
              return (
                <button key={c.id} className="chat-conv-item" onClick={() => onOpenConversation(c.id)}>
                  {/* 30/set, pedido do Douglas: "quero a logo apenas na
                      aba empresas, porque ter ela nas conversas?" --
                      selo por linha removido (a coluna .chat-company-rail
                      já mostra/filtra por logo, repetir aqui era
                      redundante). companyName/companyLogoUrl continuam
                      no tipo Conversation -- só pararam de aparecer
                      nessa lista, a coluna de Empresas ainda usa. */}
                  <span
                    className="chat-conv-avatar"
                    style={{ background: c.kind === "direct" ? c.participants[0]?.color || "#5c9bff" : "#7c5cff" }}
                  >
                    {c.kind === "group" ? <GroupIcon /> : conversationDisplayName(c).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="chat-conv-info">
                    <span className="chat-conv-name">
                      {conversationDisplayName(c)}
                      {c.muted && (
                        <span className="chat-conv-muted-dot" title="Silenciada">
                          🔕
                        </span>
                      )}
                    </span>
                    <span className="chat-conv-preview">
                      {c.lastMessage
                        ? `${c.lastMessage.senderId === myUserId ? "Você: " : ""}${previewText(c.lastMessage)}`
                        : "Nenhuma mensagem ainda"}
                    </span>
                  </span>
                  {/* "e em qual conversa" (Douglas, 2/out) -- mesmo
                      balãozinho das abas (ver companyUnread/
                      privateUnread lá em cima), agora por CONVERSA, pra
                      saber exatamente onde tá a mensagem não lida sem
                      precisar abrir uma por uma. */}
                  {(c.unreadCount ?? 0) > 0 && <span className="chat-conv-unread-badge">{c.unreadCount}</span>}
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
                  {/* "3 pontinhos" -- nasceu só pra "mover pra
                      Empresa/Privada" (pedido do Douglas, 29/set (18),
                      só conversa 1x1), e virou o menu geral de opções
                      da conversa em 2/out (pedido do Douglas: "nao tem
                      opcao de Silenciar, e de Apagar conversa") --
                      Silenciar/Apagar fazem sentido em QUALQUER
                      conversa (direct OU grupo), só "Mover" continua
                      exclusivo de direct (grupo não tem lane, ver
                      comentário de "lane" no tipo Conversation).
                      Igual ao chat-call-badge acima: <span> com
                      stopPropagation em vez de <button>, porque a
                      linha inteira já É um <button> (chat-conv-item),
                      e botão dentro de botão é HTML inválido. */}
                  <span className="chat-conv-menu-wrap" onClick={(e) => e.stopPropagation()}>
                    <span
                      className="chat-conv-menu-btn"
                      title="Mais opções"
                      onClick={() => setConvMenuOpenId((prev) => (prev === c.id ? null : c.id))}
                    >
                      ⋮
                    </span>
                    {convMenuOpenId === c.id && (
                      <>
                        <div className="chat-conv-menu-backdrop" onClick={() => setConvMenuOpenId(null)} />
                        <div className="chat-conv-menu">
                          {c.kind === "direct" && (
                            <button
                              type="button"
                              className="chat-conv-menu-item"
                              onClick={() => {
                                onMoveConversationLane(c.id, c.lane === "company" ? "private" : "company");
                                setConvMenuOpenId(null);
                              }}
                            >
                              {c.lane === "company" ? "Mover para Conversas privadas" : "Mover para Empresa"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="chat-conv-menu-item"
                            onClick={() => {
                              onMuteConversation(c.id, !c.muted);
                              setConvMenuOpenId(null);
                            }}
                          >
                            {c.muted ? "Ativar notificações" : "Silenciar"}
                          </button>
                          <button
                            type="button"
                            className="chat-conv-menu-item chat-conv-menu-item-danger"
                            onClick={() => {
                              onDeleteConversation(c.id);
                              setConvMenuOpenId(null);
                            }}
                          >
                            Apagar conversa
                          </button>
                        </div>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
            {visibleLaneConversations.length === 0 &&
              (laneFilter === "private" ? (
                <p className="chat-empty-hint">
                  Nenhuma conversa privada ainda. Vire amigo de alguém no painel de Amigos pra conversar aqui.
                </p>
              ) : (
                <p className="chat-empty-hint">Clique em + pra começar uma conversa direta ou em grupo.</p>
              ))}
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
              {expandBtn}
              <button className="chat-icon-btn" title="Fechar" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="chat-new-conv-body">
            {/* 1/out, pedido do Douglas: "quero o criar grupo de forma
                melhor mais visivel 'criar grupo'" -- antes "criar grupo"
                só aparecia escondido depois de marcar mais de 1 pessoa,
                sem nenhum jeito de saber disso de antemão. Agora é a
                PRIMEIRA escolha da tela, bem visível (mesmo estilo de
                aba branca/escura do filtro Amigos/Empresa logo abaixo,
                só que num nível acima -- esse decide O QUE criar,
                aquele decide ONDE procurar gente). */}
            <div className="chat-lane-tabs chat-new-conv-mode-tabs">
              <button
                type="button"
                className={`chat-lane-tab${newConvMode === "direct" ? " chat-lane-tab-active" : ""}`}
                onClick={() => onChangeNewConvMode("direct")}
              >
                Conversa
              </button>
              <button
                type="button"
                className={`chat-lane-tab${newConvMode === "group" ? " chat-lane-tab-active" : ""}`}
                onClick={() => onChangeNewConvMode("group")}
              >
                <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                  <GroupIcon /> Criar grupo
                </span>
              </button>
            </div>
            {/* 30/set, pedido do Douglas ("nova conversa aparece isso,
                nao minha lista nem o filtro"): MESMO filtro Amigos/
                Empresa do Lobby (ver newConvFilter/moveConversationLane
                comentário grande lá em components/Lobby.tsx), agora
                também aqui dentro da sala -- antes só listava quem tava
                online na sala nesse instante (pickable), ficava vazio
                com a sala vazia. */}
            <div className="chat-lane-tabs">
              <button
                type="button"
                className={`chat-lane-tab${newConvFilter === "friends" ? " chat-lane-tab-active" : ""}`}
                onClick={() => onChangeNewConvFilter("friends")}
              >
                Amigos
              </button>
              <button
                type="button"
                className={`chat-lane-tab${newConvFilter === "company" ? " chat-lane-tab-active" : ""}`}
                onClick={() => onChangeNewConvFilter("company")}
              >
                Empresa
              </button>
            </div>
            <input
              type="text"
              className="contacts-panel-search"
              placeholder="Buscar pelo nome..."
              value={newConvQuery}
              onChange={(e) => onChangeNewConvQuery(e.target.value)}
            />
            {(() => {
              // candidatos normalizados numa forma só (userId/name/
              // avatar), venham de onde vierem: gente na sala agora
              // (pickable, cor de fundo própria), busca de amigo mútuo
              // (newConvFriends, filtro local pelo texto) ou busca de
              // qualquer conta (newConvSearchResults, servidor já
              // filtra). "Empresa" sem texto nenhum cai pra pickable --
              // atalho rápido de sempre pra quem tá do seu lado.
              const q = newConvQuery.trim().toLowerCase();
              type Candidate = { userId: string; name: string; color?: string; photoUrl?: string };
              let candidates: Candidate[];
              let emptyHint: string;
              if (newConvFilter === "friends") {
                const friends = newConvFriends ?? [];
                candidates = q ? friends.filter((f) => f.name.toLowerCase().includes(q)) : friends;
                emptyHint =
                  newConvFriends === null
                    ? "Buscando…"
                    : q
                    ? "Nenhum amigo com esse nome."
                    : "Você ainda não tem amigo mútuo. Vire amigo de alguém no painel de Amigos primeiro.";
              } else if (q) {
                candidates = newConvSearchResults ?? [];
                emptyHint = newConvSearchResults === null ? "Buscando…" : "Ninguém encontrado.";
              } else {
                candidates = pickable;
                emptyHint = "Não tem mais ninguém na sala agora.";
              }
              return candidates.length === 0 ? (
                <p className="chat-empty-hint">{emptyHint}</p>
              ) : (
                <div className="chat-picker-list">
                  {candidates.map((p) => (
                    <label key={p.userId} className="chat-picker-item">
                      <input
                        // "Conversa" (ver newConvMode) é rádio -- só UMA
                        // pessoa por vez, mesmo esquema do resto da
                        // tela; "Criar grupo" continua checkbox de
                        // sempre (ver comentário grande em
                        // toggleNewConvSelection/GameRoom.tsx).
                        type={newConvMode === "direct" ? "radio" : "checkbox"}
                        name={newConvMode === "direct" ? "new-conv-direct-pick" : undefined}
                        checked={newConvSelection.includes(p.userId)}
                        onChange={() => onToggleNewConvSelection(p.userId)}
                      />
                      <Avatar
                        className="chat-conv-avatar"
                        background={p.color || "#5a4b7c"}
                        photoUrl={p.photoUrl}
                        name={p.name}
                      />
                      <span>{p.name || "Sem nome"}</span>
                    </label>
                  ))}
                </div>
              );
            })()}
            {newConvMode === "group" && (
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
              disabled={
                newConvMode === "direct"
                  ? newConvSelection.length !== 1
                  : newConvSelection.length === 0 || !newConvName.trim()
              }
              onClick={onSubmitNewConversation}
            >
              {newConvMode === "group" ? "Criar grupo" : "Iniciar conversa"}
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
            {/* 29/set (11), pedido do Douglas: "quadnoa bro a conversa
                com uma pessoa direta / Quero a foto dela ali encima, e
                essa parte de cima clicavel, abrindo o perfil dela ali
                dentro" -- só numa conversa "direct" (1 pessoa só, não
                grupo nem a "Sala"): foto + nome viram um botão só, que
                chama onOpenProfile com o id do OUTRO participante
                (participants[] já vem sem mim, ver comentário do tipo
                Conversation no topo do arquivo). Grupo/Sala continuam
                sem foto nenhuma (não tem UMA pessoa só pra mostrar). */}
            {!isRoom && !renamingGroup && activeConv?.kind === "direct" && activeConv.participants[0] ? (
              <span className="chat-drawer-header-identity-wrap">
                <button
                  type="button"
                  className="chat-drawer-header-identity"
                  onClick={() => onOpenProfile(activeConv.participants[0].id)}
                  title="Ver perfil"
                >
                  <Avatar
                    className="chat-drawer-header-avatar"
                    background={activeConv.participants[0].color || "#5a4b7c"}
                    photoUrl={activeConv.participants[0].photoUrl}
                    name={activeConv.participants[0].name}
                  />
                  <h3>{conversationDisplayName(activeConv)}</h3>
                </button>
                {/* "Convidar amigo" / "Visitar amigo" -- pedido do
                    Douglas, 30/set: "ao lado do nome, um botao com
                    seta clicou expande, Convidar amigo / Visitar
                    amigo" -- manda um cardzinho na própria conversa
                    (ver sendRoomCard/GameRoom.tsx e ChatMessageRow
                    mais abaixo pra como ele renderiza). */}
                <button
                  type="button"
                  className={inviteMenuOpen ? "chat-invite-toggle-btn open" : "chat-invite-toggle-btn"}
                  title="Convidar ou visitar"
                  onClick={() => setInviteMenuOpen((v) => !v)}
                >
                  <ChevronDownIcon />
                </button>
                {inviteMenuOpen && (
                  <>
                    <div className="chat-conv-menu-backdrop" onClick={() => setInviteMenuOpen(false)} />
                    <div className="chat-invite-menu">
                      <button
                        type="button"
                        className="chat-invite-menu-item"
                        onClick={() => {
                          onSendRoomCard("invite");
                          setInviteMenuOpen(false);
                        }}
                      >
                        Convidar amigo
                      </button>
                      <button
                        type="button"
                        className="chat-invite-menu-item"
                        onClick={() => {
                          onSendRoomCard("visit");
                          setInviteMenuOpen(false);
                        }}
                      >
                        Visitar amigo
                      </button>
                    </div>
                  </>
                )}
              </span>
            ) : isRoom ? (
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
              {expandBtn}
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
              {inActiveCall && (
                // "a chamada em conversa nao deixa desligar a camera"
                // (2/out, pedido do Douglas) -- MESMO mic/câmera da
                // av-bar principal (ver comentário grande em onToggleMic/
                // onToggleCam no tipo lá em cima), só exposto aqui
                // também, direto na barra da chamada, pra não precisar
                // sair da conversa pra achar o botão. "Expandir" (ver
                // ExpandIcon/callExpanded) afeta a grade TODA de uma vez.
                <div className="chat-call-bar-controls">
                  <button
                    type="button"
                    className={micOn ? "chat-icon-btn" : "chat-icon-btn off"}
                    title={micOn ? "Desligar microfone" : "Ligar microfone"}
                    onClick={onToggleMic}
                  >
                    <MicIcon off={!micOn} />
                  </button>
                  <button
                    type="button"
                    className={camOn ? "chat-icon-btn" : "chat-icon-btn off"}
                    title={camOn ? "Desligar câmera" : "Ligar câmera"}
                    onClick={onToggleCam}
                  >
                    <CamIcon off={!camOn} />
                  </button>
                  <button
                    type="button"
                    className={callExpanded ? "chat-icon-btn active" : "chat-icon-btn"}
                    title={callExpanded ? "Reduzir vídeos" : "Expandir vídeos"}
                    onClick={() => setCallExpanded((v) => !v)}
                  >
                    <ExpandIcon expanded={callExpanded} />
                  </button>
                </div>
              )}
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
            <div className={callExpanded ? "chat-call-videos expanded" : "chat-call-videos"}>
              <ChatCallTile
                stream={localCallStream}
                showVideo={camOn && !!localCallStream}
                muted
                label="Você"
                placeholderText="Você"
              />
              {activeCallParticipants
                .filter((p) => p.userId !== myUserId)
                .map((p) => {
                  const stream = callRemoteStreams[p.connectionId];
                  return (
                    <ChatCallTile
                      key={p.connectionId}
                      stream={stream}
                      showVideo={!!stream}
                      volume={callVolume}
                      label={p.name || "?"}
                      placeholderText={(p.name || "?").slice(0, 1).toUpperCase()}
                    />
                  );
                })}
            </div>
          )}

          {/* mensagem fixada (pedido do Douglas, 1/out: "mensagem
              fixada (definir tempo de fixacao)") -- mais recente
              primeiro, texto vem do próprio log/mensagens já
              carregados (busca por id). */}
          {pins.length > 0 && (
            <div className="chat-pins-bar">
              {pins.map((p) => {
                const pinnedMsg = (isRoom ? roomChatLog : messages).find((m) => m.id === p.messageId);
                return (
                  <div key={p.messageId} className="chat-pin-row">
                    <PinIcon filled />
                    <span className="chat-pin-text">
                      {pinnedMsg && !pinnedMsg.deleted ? pinnedMsg.text || "Anexo" : "Mensagem apagada"}
                    </span>
                    <button
                      type="button"
                      className="chat-pin-unpin-btn"
                      onClick={() => onUnpinMessage(p.messageId)}
                    >
                      Tirar
                    </button>
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
                    myUserId={myUserId}
                    onDelete={m.senderId === myUserId && !m.deleted ? () => onDeleteMessage(null, m.id) : undefined}
                    reactingOpen={reactingMessageId === m.id}
                    onToggleReactingOpen={() => setReactingMessageId((cur) => (cur === m.id ? null : m.id))}
                    onToggleReaction={(emoji) => onToggleReaction(m.id, emoji)}
                    pinningOpen={pinningMessageId === m.id}
                    onTogglePinningOpen={() => setPinningMessageId((cur) => (cur === m.id ? null : m.id))}
                    isPinned={pins.some((p) => p.messageId === m.id)}
                    onPin={(durationMs) => {
                      onPinMessage(m.id, durationMs);
                      setPinningMessageId(null);
                    }}
                    onUnpin={() => onUnpinMessage(m.id)}
                  />
                ))
              : (() => {
                  const filtered = messages.filter(Boolean);
                  // 29/set (14), pedido do Douglas: "quando eu abro a
                  // conversa nao mostra onde ta a mensagem nao vista"
                  // -- linha divisória antes da PRIMEIRA mensagem de
                  // outro participante depois do corte unreadSinceTs
                  // (ver comentário grande em unreadSinceTsByConv lá
                  // em cima).
                  const dividerIndex =
                    unreadSinceTs != null
                      ? filtered.findIndex((m) => m.senderId !== myUserId && m.ts > unreadSinceTs)
                      : -1;
                  // "confirmação de leitura (visto por quem)" (pedido
                  // do Douglas, 1/out) -- só na ÚLTIMA mensagem MINHA
                  // (igual WhatsApp/Slack), nunca em TODAS as minhas.
                  const lastOwnId = [...filtered].reverse().find((m) => m.senderId === myUserId)?.id;
                  return filtered.map((m, i) => (
                    <Fragment key={m.id}>
                      {i === dividerIndex && (
                        <div className="chat-unread-divider">
                          <span>Mensagens não vistas</span>
                        </div>
                      )}
                      <ChatMessageRow
                        msg={m}
                        own={m.senderId === myUserId}
                        showSenderName={m.senderId !== myUserId && activeConv?.kind === "group"}
                        myUserId={myUserId}
                        onDelete={
                          m.senderId === myUserId && !m.deleted && activeConversationId
                            ? () => onDeleteMessage(activeConversationId, m.id)
                            : undefined
                        }
                        onAcceptVisit={m.senderId !== myUserId ? () => onSendRoomCard("invite") : undefined}
                        onReply={!isRoom && !m.deleted ? () => onStartReply(m) : undefined}
                        reactingOpen={reactingMessageId === m.id}
                        onToggleReactingOpen={() => setReactingMessageId((cur) => (cur === m.id ? null : m.id))}
                        onToggleReaction={(emoji) => onToggleReaction(m.id, emoji)}
                        pinningOpen={pinningMessageId === m.id}
                        onTogglePinningOpen={() => setPinningMessageId((cur) => (cur === m.id ? null : m.id))}
                        isPinned={pins.some((p) => p.messageId === m.id)}
                        onPin={(durationMs) => {
                          onPinMessage(m.id, durationMs);
                          setPinningMessageId(null);
                        }}
                        onUnpin={() => onUnpinMessage(m.id)}
                        seenBy={
                          m.id === lastOwnId
                            ? Object.entries(lastRead)
                                .filter(([uid, ts]) => uid !== myUserId && ts >= m.ts)
                                .map(([uid]) => activeConv?.participants.find((p) => p.id === uid)?.name || "Alguém")
                            : undefined
                        }
                      />
                    </Fragment>
                  ));
                })()}
            {isRoom && roomChatLog.length === 0 && (
              <p className="chat-empty-hint">Nenhuma mensagem ainda -- diga oi pra quem tiver por perto!</p>
            )}
            {!isRoom && messages.length === 0 && (
              <p className="chat-empty-hint">Nenhuma mensagem ainda -- diga oi!</p>
            )}
          </div>
          {/* "fulano está digitando..." (pedido do Douglas, 1/out) --
              efêmero, já vem filtrado/expirado sozinho (ver
              typingUsers/TYPING_EXPIRE_MS em GameRoom.tsx). */}
          {typingUsers.length > 0 && (
            <div className="chat-typing-indicator">
              {typingUsers.length === 1
                ? `${typingUsers[0].name || "Alguém"} está digitando...`
                : typingUsers.length === 2
                  ? `${typingUsers[0].name || "Alguém"} e ${typingUsers[1].name || "Alguém"} estão digitando...`
                  : `${typingUsers.length} pessoas estão digitando...`}
            </div>
          )}

          {/* "Dar dois clique na mensagem ativar a resposta" (2/out,
              pedido do Douglas) -- barrinha de "respondendo a" acima
              do composer, igual WhatsApp/Telegram/Slack. X cancela
              sem perder o que já foi digitado (onCancelReply só limpa
              replyingTo, nunca mexe em composerText). */}
          {!isRoom && replyingTo && (
            <div className="chat-reply-bar">
              {/* miniatura de verdade (2/out, pedido do Douglas: "na
                  conversa precisa aparecer a resposta selecionada ao
                  arquivo, igual no whats") -- só pra imagem, que é o
                  único anexo com preview visual que faz sentido num
                  quadradinho desses (áudio/arquivo continuam com
                  ícone+nome, ver chat-reply-bar-preview abaixo). */}
              {replyingTo.kind === "image" && replyingTo.attachmentUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="chat-reply-bar-thumb" src={attachmentUrl(replyingTo.attachmentUrl)} alt="" />
              )}
              <div className="chat-reply-bar-info">
                <span className="chat-reply-bar-sender">Respondendo a {replyingTo.senderName}</span>
                <span className="chat-reply-bar-preview">
                  {replyingTo.kind === "text"
                    ? replyingTo.text || "Mensagem"
                    : replyingTo.kind === "image"
                      ? `📷 ${replyingTo.attachmentName || "Foto"}`
                      : replyingTo.kind === "audio"
                        ? "🎤 Áudio"
                        : replyingTo.kind === "room_card"
                          ? "🔑 Convite de sala"
                          : `📎 ${replyingTo.attachmentName || "Arquivo"}`}
                </span>
              </div>
              <button type="button" className="chat-reply-bar-cancel" title="Cancelar resposta" onClick={onCancelReply}>
                <CloseIcon />
              </button>
            </div>
          )}
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
            <div className="chat-composer chat-composer-with-mentions">
              {/* @menção (pedido do Douglas, 1/out) -- ver comentário
                  grande em mentionState/insertMention logo acima. */}
              {mentionState && mentionCandidates.length > 0 && (
                <div className="chat-mention-dropdown">
                  {mentionCandidates.map((c) => (
                    <button key={c.userId} type="button" className="chat-mention-option" onClick={() => insertMention(c)}>
                      {c.name || "?"}
                    </button>
                  ))}
                </div>
              )}
              <button className="chat-composer-btn" title="Anexar foto/arquivo" onClick={onPickFile} disabled={sendingAttachment}>
                <AttachIcon />
              </button>
              <button className="chat-composer-btn" title="Gravar áudio" onClick={onStartRecording}>
                <MicIcon off={false} />
              </button>
              <input
                ref={composerInputRef}
                className="chat-composer-input"
                value={composerText}
                onChange={handleComposerInputChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !mentionState) onSendComposer();
                  if (e.key === "Escape") setMentionState(null);
                }}
                placeholder="Digite uma mensagem... (@ pra mencionar)"
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

  // painel lateral "arquivos da conversa" (pedido do Douglas, 1/out) --
  // só existe pra conversa de VERDADE aberta (nunca a Sala, ver
  // comentário grande em filesPanelOpen/GameRoom.tsx), e só faz sentido
  // na aba "thread" (view "list"/"new" não tem composer nem mensagem
  // nenhuma pra ancorar o botão do lado).
  const filesTrigger = !isRoom && view === "thread" && (
    <button
      type="button"
      className="chat-files-trigger"
      style={{ left: filesRightEdge }}
      onClick={() => (filesPanelOpen ? onCloseFilesPanel() : onOpenFilesPanel())}
      aria-expanded={filesPanelOpen}
      title={filesPanelOpen ? "Fechar arquivos" : "Arquivos da conversa"}
      data-tooltip={filesPanelOpen ? "Fechar arquivos" : "Arquivos da conversa"}
    >
      {filesPanelOpen ? <ChevronLeftIcon /> : <FileIcon />}
    </button>
  );
  const FILES_PANEL_TABS: { key: "all" | "image" | "file" | "audio"; label: string }[] = [
    { key: "all", label: "Tudo" },
    { key: "image", label: "Imagens" },
    { key: "file", label: "Arquivos" },
    { key: "audio", label: "Áudios" },
  ];
  const filesPanel = !isRoom && view === "thread" && filesPanelOpen && (
    <>
      <div className="chat-files-panel-click-catcher" onClick={onCloseFilesPanel} />
      <div className="chat-files-panel" style={{ left: filesRightEdge + 6 }} onClick={(e) => e.stopPropagation()}>
        <div className="chat-files-panel-header">
          <h3>Arquivos da conversa</h3>
          <button type="button" className="items-panel-close" onClick={onCloseFilesPanel} title="Fechar">
            ✕
          </button>
        </div>
        <div className="chat-files-panel-tabs">
          {FILES_PANEL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={filesPanelFilter === t.key ? "chat-files-panel-tab active" : "chat-files-panel-tab"}
              onClick={() => onChangeFilesPanelFilter(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="chat-files-panel-search">
          <SearchIcon />
          <input
            value={filesPanelQuery}
            onChange={(e) => onChangeFilesPanelQuery(e.target.value)}
            placeholder="Buscar por nome..."
          />
        </div>
        <div className="chat-files-panel-list">
          {filesPanelItems === null ? (
            <p className="chat-files-panel-hint">Carregando...</p>
          ) : (
            (() => {
              const q = filesPanelQuery.trim().toLowerCase();
              const list = filesPanelItems.filter(
                (it) =>
                  (filesPanelFilter === "all" || it.kind === filesPanelFilter) &&
                  (!q || it.attachment.name.toLowerCase().includes(q))
              );
              if (list.length === 0) return <p className="chat-files-panel-hint">Nenhum arquivo encontrado.</p>;
              return list.map((it) => (
                <div
                  key={it.messageId}
                  className="chat-files-panel-item"
                  onClick={() => setGalleryItem(it)}
                  role="button"
                  tabIndex={0}
                >
                  {it.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="chat-files-panel-thumb" src={attachmentUrl(it.attachment.url)} alt="" />
                  ) : (
                    <span className="chat-files-panel-icon">
                      {it.kind === "audio" ? <MicIcon off={false} /> : <FileIcon />}
                    </span>
                  )}
                  <span className="chat-files-panel-item-info">
                    <span className="chat-files-panel-item-name">{it.attachment.name}</span>
                    <span className="chat-files-panel-item-meta">
                      {it.senderName || "Alguém"} · {formatFileSize(it.attachment.size)}
                    </span>
                  </span>
                  <a
                    className="chat-files-panel-btn"
                    href={attachmentUrl(it.attachment.url)}
                    download={it.attachment.name}
                    target="_blank"
                    rel="noreferrer"
                    title="Baixar"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DownloadIcon />
                  </a>
                  <button
                    type="button"
                    className="chat-files-panel-btn"
                    title="Mencionar na conversa"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMentionAttachmentInChat(it);
                    }}
                  >
                    <AtIcon />
                  </button>
                </div>
              ));
            })()
          )}
        </div>
      </div>
    </>
  );

  // "abriu ele na galeria, abre o historico de mensagens grudadas
  // nele, lá no balao dele mesmo" (2/out, pedido do Douglas) --
  // visualizador do anexo clicado no painel "Arquivos da conversa"
  // (ver setGalleryItem acima) + toda mensagem que RESPONDEU a esse
  // anexo (msg.replyTo.messageId === galleryItem.messageId, mesmo
  // retrato congelado usado no "chat-reply-quote" do balão normal).
  const galleryThread = galleryItem ? messages.filter((m) => m.replyTo?.messageId === galleryItem.messageId) : [];
  const galleryModal = galleryItem && (
    <>
      <div className="chat-gallery-click-catcher" onClick={() => setGalleryItem(null)} />
      <div className="chat-gallery-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-gallery-modal-header">
          <span className="chat-gallery-modal-title">{galleryItem.attachment.name}</span>
          <button type="button" className="items-panel-close" onClick={() => setGalleryItem(null)} title="Fechar">
            <CloseIcon />
          </button>
        </div>
        <div className="chat-gallery-modal-body">
          {galleryItem.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="chat-gallery-modal-media" src={attachmentUrl(galleryItem.attachment.url)} alt="" />
          ) : galleryItem.kind === "audio" ? (
            <audio className="chat-gallery-modal-audio" controls src={attachmentUrl(galleryItem.attachment.url)} />
          ) : (
            <div className="chat-gallery-modal-file">
              <FileIcon />
              <span>{formatFileSize(galleryItem.attachment.size)}</span>
            </div>
          )}
          <div className="chat-gallery-modal-meta">
            <span>{galleryItem.senderName || "Alguém"}</span>
            <span>{formatChatTime(galleryItem.ts)}</span>
          </div>
          <div className="chat-gallery-modal-actions">
            <a
              className="chat-files-panel-btn"
              href={attachmentUrl(galleryItem.attachment.url)}
              download={galleryItem.attachment.name}
              target="_blank"
              rel="noreferrer"
              title="Baixar"
            >
              <DownloadIcon />
            </a>
            <button
              type="button"
              className="chat-files-panel-btn"
              title="Responder"
              onClick={() => {
                onStartReply({
                  id: galleryItem.messageId,
                  senderId: galleryItem.senderId,
                  senderName: galleryItem.senderName,
                  kind: galleryItem.kind,
                  text: "",
                  attachment: galleryItem.attachment,
                } as ChatMessage);
                setGalleryItem(null);
                onCloseFilesPanel();
              }}
            >
              Responder
            </button>
          </div>
        </div>
        {galleryThread.length > 0 && (
          <div className="chat-gallery-modal-thread">
            <h4>Mensagens sobre este arquivo</h4>
            {galleryThread.map((m) => (
              <div key={m.id} className="chat-gallery-thread-item">
                <span className="chat-gallery-thread-sender">{m.senderName || "Alguém"}</span>
                <span className="chat-gallery-thread-text">
                  {m.deleted ? <em>apagou uma mensagem</em> : m.text || (m.attachment ? m.attachment.name : "")}
                </span>
                <span className="chat-gallery-thread-time">{formatChatTime(m.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  if (!companyRail) {
    return (
      <>
        {drawerBody}
        {filesTrigger}
        {filesPanel}
        {galleryModal}
      </>
    );
  }

  return (
    <>
      <div
        className={
          (pinMode === "side" ? `chat-drawer-shell ${sidebarClassName ?? "chat-drawer-shell-sidebar"}` : "chat-drawer-shell") +
          (drawerExpanded ? " chat-drawer-shell-expanded" : "")
        }
      >
        {companyRail}
        {drawerBody}
      </div>
      {filesTrigger}
      {filesPanel}
      {galleryModal}
    </>
  );
}
// "podia dar um contorno verde no balao de quem ta falando" (2/out,
// pedido do Douglas) -- mede o VOLUME de verdade do áudio de cada
// participante (AnalyserNode/Web Audio API), não um "tá com o mic
// aberto" -- então só acende quando a pessoa tá FALANDO mesmo, igual
// Zoom/Meet/Discord. Funciona mesmo com a câmera desligada (o stream
// de áudio existe independente do vídeo, ver showVideo em ChatCallTile
// abaixo) -- é por isso que essa detecção usa o STREAM inteiro, nunca
// só o <video>. "holdMs" segura o estado "falando" por um instante
// depois do último pico alto, só pra não ficar piscando a cada sílaba
// (micro-silêncios entre palavras).
const SPEAKING_VOLUME_THRESHOLD = 14;
const SPEAKING_HOLD_MS = 400;

function useIsSpeaking(stream: MediaStream | null | undefined): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    const AudioCtxClass: typeof AudioContext | undefined =
      typeof window !== "undefined" ? window.AudioContext || (window as any).webkitAudioContext : undefined;
    if (!AudioCtxClass) return;
    const ctx = new AudioCtxClass();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let lastLoudTs = 0;
    let cancelled = false;
    function tick() {
      if (cancelled) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const now = performance.now();
      if (avg > SPEAKING_VOLUME_THRESHOLD) lastLoudTs = now;
      setSpeaking((prev) => {
        const next = now - lastLoudTs < SPEAKING_HOLD_MS;
        return prev === next ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      source.disconnect();
      ctx.close().catch(() => {});
    };
  }, [stream]);
  return speaking;
}

// um tile só pra EU e pra cada participante remoto (antes era dois
// blocos de JSX quase idênticos, ver histórico) -- showVideo separado
// de stream porque a MINHA câmera pode tá desligada (camOn=false)
// mesmo com o stream (mic) continuando vivo/detectável (ver
// useIsSpeaking acima), diferença que o placeholder "Você" já tratava
// antes, só que duplicada.
function ChatCallTile({
  stream,
  showVideo,
  muted,
  volume,
  label,
  placeholderText,
}: {
  stream: MediaStream | null | undefined;
  showVideo: boolean;
  muted?: boolean;
  volume?: number;
  label: string;
  placeholderText: string;
}) {
  const speaking = useIsSpeaking(stream);
  return (
    <div className={speaking ? "chat-call-video-tile speaking" : "chat-call-video-tile"}>
      {showVideo && stream ? (
        <ChatCallVideoTile stream={stream} muted={muted} volume={volume} />
      ) : (
        <span className="chat-call-video-placeholder">{placeholderText}</span>
      )}
      <span className="video-name">{label}</span>
    </div>
  );
}

function ChatMessageRow({
  msg,
  own,
  showSenderName,
  myUserId,
  onDelete,
  onAcceptVisit,
  onReply,
  reactingOpen,
  onToggleReactingOpen,
  onToggleReaction,
  pinningOpen,
  onTogglePinningOpen,
  isPinned,
  onPin,
  onUnpin,
  seenBy,
}: {
  msg: ChatMessage;
  own: boolean;
  showSenderName: boolean;
  // userId (persistente) do usuário atual -- pedido do Douglas, 1/out
  // (comparando com o Slack). Usado só pra saber se EU já reagi com tal
  // emoji (destaca o pill, ver reactionEntries abaixo) e se a mensagem
  // me @menciona (ver iWasMentioned).
  myUserId: string;
  // presente só nas MINHAS mensagens ainda não apagadas -- ver
  // chamadores em ChatDrawer (Sala usa chat:delete_room, conversa de
  // verdade usa chat:delete).
  onDelete?: () => void;
  // "Visitar amigo" (ver comentário grande em sendRoomCard/GameRoom.tsx)
  // -- só passado pra mensagens de conversa de verdade (nunca a Sala),
  // chama de volta com action "invite" usando a MINHA sala quando eu
  // (quem recebeu o pedido) clico "Convidar" no cardzinho.
  onAcceptVisit?: () => void;
  // "responder mensagem" (2/out) -- duplo-clique no balão dispara
  // isso (ver onDoubleClick no .chat-bubble mais abaixo). undefined
  // em mensagem apagada e na Sala (mesma trava de onDelete/onAcceptVisit
  // acima -- ver chamador em ChatDrawer).
  onReply?: () => void;
  // reação com emoji (pedido do Douglas, 1/out) -- popover de "emoji
  // rápido" controlado de fora (um reactingMessageId só, pra lista
  // toda, ver ChatDrawer) -- aqui só lê se é a MINHA mensagem que tá
  // com o popover aberto agora e dispara abrir/fechar/reagir.
  reactingOpen: boolean;
  onToggleReactingOpen: () => void;
  onToggleReaction: (emoji: string) => void;
  // "mensagem fixada (definir tempo de fixacao)" (pedido do Douglas,
  // 1/out) -- mesmo espírito do popover de reação acima, só que pra
  // escolher o prazo (ver PIN_DURATION_OPTIONS) ou tirar a fixação.
  pinningOpen: boolean;
  onTogglePinningOpen: () => void;
  isPinned: boolean;
  onPin: (durationMs: number | null) => void;
  onUnpin: () => void;
  // "confirmação de leitura (visto por quem)" (pedido do Douglas,
  // 1/out) -- só vem preenchido na ÚLTIMA mensagem MINHA de uma
  // conversa de VERDADE (ver comentário grande no chamador, lá em
  // ChatDrawer) -- lista de nomes de quem já leu, undefined quando não
  // se aplica (Sala, ou não é a última mensagem minha).
  seenBy?: string[];
}) {
  // reações agrupadas por emoji (pedido do Douglas, 1/out) -- só os
  // emoji com pelo menos 1 reação (o servidor já limpa array vazio em
  // toggleReactionOnMessage, mas filtra aqui de novo por segurança).
  const reactionEntries = Object.entries(msg.reactions ?? {}).filter(([, ids]) => ids.length > 0);
  // true quando EU fui @mencionado nessa mensagem -- destaca o balão
  // inteiro (mesmo espírito do "highlight" de menção do Slack), ver
  // comentário grande em renderMentionText sobre a limitação de nomes
  // com espaço.
  const iWasMentioned = !own && (msg.mentionedUserIds ?? []).includes(myUserId);
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
        {/* barra flutuante de ações (2/out, pedido do Douglas: "ta no
            cantinho ainda, e muito pequeno, e cinza" + "nao recisa
            clicar no balao, coloca uma selecao em cada mensagem tipo
            o slack") -- antes os botões ficavam DENTRO do fluxo flex
            da linha (espremidos coladinhos no canto do balão); agora
            é um cartãozinho position:absolute que flutua por cima do
            topo da linha só no hover (sem precisar de duplo-clique
            pra nada aparecer), igual o hover-toolbar do Slack. Mesmo
            truque de ancorar pela BORDA da linha (ver comentário
            grande de .chat-message-row/.chat-quick-react-popover em
            globals.css) -- cresce pra DENTRO, nunca estoura a gaveta. */}
        <div className="chat-message-hover-toolbar">
          {onReply && (
            <button type="button" className="chat-message-action-btn" title="Responder" onClick={onReply}>
              <ReplyIcon />
            </button>
          )}
          <div className="chat-message-action-wrap">
            <button
              type="button"
              className={reactingOpen ? "chat-message-action-btn active" : "chat-message-action-btn"}
              title="Reagir"
              onClick={onToggleReactingOpen}
            >
              <SmileIcon />
            </button>
            {reactingOpen && (
              <div className="chat-quick-react-popover">
                {QUICK_REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="chat-quick-react-option"
                    onClick={() => onToggleReaction(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chat-message-action-wrap">
            <button
              type="button"
              className={isPinned || pinningOpen ? "chat-message-action-btn active" : "chat-message-action-btn"}
              title={isPinned ? "Mensagem fixada" : "Fixar mensagem"}
              onClick={onTogglePinningOpen}
            >
              <PinIcon filled={isPinned} />
            </button>
            {pinningOpen && (
              <div className="chat-pin-duration-popover">
                {isPinned ? (
                  <button
                    type="button"
                    className="chat-pin-duration-option chat-pin-duration-unpin"
                    onClick={() => {
                      onUnpin();
                      onTogglePinningOpen();
                    }}
                  >
                    Tirar fixação
                  </button>
                ) : (
                  PIN_DURATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className="chat-pin-duration-option"
                      onClick={() => onPin(opt.durationMs)}
                    >
                      Fixar por {opt.label}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {own && onDelete && (
            <button
              type="button"
              className="chat-message-action-btn chat-message-delete-btn"
              title="Apagar mensagem"
              onClick={onDelete}
            >
              <TrashIcon />
            </button>
          )}
        </div>
        <div
          className={iWasMentioned ? "chat-bubble chat-bubble-mentioned" : "chat-bubble"}
          // duplo-clique continua funcionando como atalho extra, mas
          // não é mais NECESSÁRIO pra responder -- o botão "Responder"
          // na barra flutuante acima já faz isso (pedido do Douglas:
          // "nao recisa clicar no balao"). onReply vem undefined em
          // mensagem apagada/Sala (ver comentário no tipo acima).
          onDoubleClick={onReply}
        >
          {msg.replyTo && (
            // citação da mensagem original (2/out) -- RETRATO
            // congelado (ver comentário grande do campo replyTo no
            // tipo ChatMsgBase/GameRoom.tsx), nunca busca a mensagem
            // de novo. "Arquivos ficam com historico de mensagens
            // mencionadas a ele" (pedido do Douglas) usa esse MESMO
            // campo do lado de fora (ver filtro em chat-files-panel-thread
            // mais abaixo), aqui só mostra a citação dentro do balão.
            <div className="chat-reply-quote">
              {/* miniatura de verdade (2/out, pedido do Douglas: "na
                  conversa precisa aparecer a resposta selecionada ao
                  arquivo, igual no whats") -- mesma regra da barra do
                  composer acima: só imagem ganha preview visual. */}
              {!msg.replyTo.deleted && msg.replyTo.kind === "image" && msg.replyTo.attachmentUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="chat-reply-quote-thumb" src={attachmentUrl(msg.replyTo.attachmentUrl)} alt="" />
              )}
              <span className="chat-reply-quote-body">
                <span className="chat-reply-quote-sender">{msg.replyTo.senderName}</span>
                <span className="chat-reply-quote-text">
                  {msg.replyTo.deleted
                    ? "Mensagem apagada"
                    : msg.replyTo.kind === "text"
                      ? msg.replyTo.text || "Mensagem"
                      : msg.replyTo.kind === "image"
                        ? `📷 ${msg.replyTo.attachmentName || "Foto"}`
                        : msg.replyTo.kind === "audio"
                          ? "🎤 Áudio"
                          : msg.replyTo.kind === "room_card"
                            ? "🔑 Convite de sala"
                            : `📎 ${msg.replyTo.attachmentName || "Arquivo"}`}
                </span>
              </span>
            </div>
          )}
          {msg.kind === "text" && <span>{renderMentionText(msg.text)}</span>}
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
          {msg.kind === "room_card" && msg.roomCard && msg.roomCard.action === "invite" && (
            <div className="chat-room-card">
              <span className="chat-room-card-icon">
                {msg.roomCard.roomLogoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={msg.roomCard.roomLogoUrl} alt="" />
                ) : (
                  <CompanyIcon />
                )}
              </span>
              <span className="chat-room-card-text">
                {own ? (
                  <>Você convidou pra sua sala <strong>{msg.roomCard.roomName || "sua sala"}</strong></>
                ) : (
                  <>
                    {msg.senderName || "Alguém"} está te convidando pra sala <strong>{msg.roomCard.roomName || "dele(a)"}</strong>
                  </>
                )}
              </span>
              {!own && (
                <a className="chat-room-card-btn" href={visitRoomLink(msg.roomCard.roomSlug)}>
                  Entrar
                </a>
              )}
            </div>
          )}
          {msg.kind === "room_card" && msg.roomCard && msg.roomCard.action === "visit" && (
            <div className="chat-room-card">
              <span className="chat-room-card-icon">
                <CompanyIcon />
              </span>
              <span className="chat-room-card-text">
                {own ? "Você pediu pra visitar a sala dele(a)" : `${msg.senderName || "Alguém"} está querendo ir até você`}
              </span>
              {!own && onAcceptVisit && (
                <button type="button" className="chat-room-card-btn" onClick={onAcceptVisit}>
                  Convidar
                </button>
              )}
            </div>
          )}
          {msg.text && msg.kind !== "text" && msg.kind !== "room_card" && (
            <div className="chat-attachment-caption">{msg.text}</div>
          )}
        </div>
      </div>
      {/* reações (pedido do Douglas, 1/out) -- pill por emoji, com
          contagem; clicar de novo alterna MINHA reação (toggle, igual
          Slack) -- ver toggleReaction/onToggleReaction. */}
      {reactionEntries.length > 0 && (
        <div className={own ? "chat-reactions-row own" : "chat-reactions-row"}>
          {reactionEntries.map(([emoji, ids]) => (
            <button
              key={emoji}
              type="button"
              className={ids.includes(myUserId) ? "chat-reaction-pill active" : "chat-reaction-pill"}
              title={ids.length === 1 ? "1 reação" : `${ids.length} reações`}
              onClick={() => onToggleReaction(emoji)}
            >
              <span>{emoji}</span>
              <span className="chat-reaction-count">{ids.length}</span>
            </button>
          ))}
        </div>
      )}
      <span className="chat-message-time">{formatChatTime(msg.ts)}</span>
      {/* "visto por" (pedido do Douglas, 1/out: "Confirmação de leitura
          (visto por quem)") -- ver comentário grande no chamador sobre
          quando isso vem preenchido. */}
      {seenBy && seenBy.length > 0 && (
        <span className="chat-message-seenby">Visto por {seenBy.join(", ")}</span>
      )}
    </div>
  );
}

// @menção (pedido do Douglas, 1/out) -- destaca "@Palavra" dentro do
// texto da mensagem. Simplificação aceita: o composer insere "@" +
// NOME COMPLETO (que pode ter espaço, ver insertMention no
// ChatDrawer), mas aqui no ChatMessageRow a gente não tem a lista de
// candidatos pra casar o nome inteiro -- então só destaca o primeiro
// "token" depois do @ (sem espaço). Pra nomes de uma palavra só (a
// maioria) fica idêntico ao Slack; pra nomes compostos destaca só a
// primeira parte, resto do texto continua normal.
function renderMentionText(text: string) {
  const parts = text.split(/(@[^\s@]+)/g);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="chat-mention-tag">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
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

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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

// 29/set (13), pedido do Douglas: "quero a logo da empresa em que ele
// abriu o chat" -- fallback pro .chat-conv-company-logo (ver lista de
// conversas em ChatDrawer/LobbyChatPanel) quando a empresa (ainda) não
// tem company_logo_url definido (ver Card da Empresa/companyLogoUrl em
// components/Lobby.tsx) -- prédio simples, mesmo estilo linha-fina do
// resto dos ícones do chat.
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

