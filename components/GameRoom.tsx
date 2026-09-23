"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import PartySocket from "partysocket";
import MainScene from "@/game/MainScene";
import { createGameConfig } from "@/game/config";
import { FURNITURE_CATALOG, FurnitureDef } from "@/game/furniture";
import { generateFurnitureCode } from "@/game/furnitureCodegen";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  CUSTOMIZATION_CATEGORIES,
  CustomizationCategoryId,
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

type RemotePlayer = { id: string; x: number; y: number; color: string } & RemoteProfile;
type ChatMessage = { id: string; text: string; ts: number };
type Toast = { id: string; text: string };

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

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";

export default function GameRoom() {
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

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [status, setStatus] = useState("Conectando...");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteMeta, setRemoteMeta] = useState<
    Record<string, { name: string; distance: number }>
  >({});
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);

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
  }));
  const [remoteProfiles, setRemoteProfiles] = useState<Record<string, RemoteProfile>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const myProfileRef = useRef(myProfile);
  myProfileRef.current = myProfile;

  // --- editor de espaço ("Editar espaço") -- modo dev: só posiciona
  // visualmente e gera o código pra colar em furniture.ts, não salva
  // nada sozinho (ver game/furnitureCodegen.ts) ---
  const [editMode, setEditMode] = useState(false);
  const [selectedCatalogIndex, setSelectedCatalogIndex] = useState<number | null>(null);
  const [draftItems, setDraftItems] = useState<FurnitureDef[]>([]);
  const [copied, setCopied] = useState(false);

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
  const [selectedHairId, setSelectedHairId] = useState(DEFAULT_HAIR_ID);
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

    function checkProximity() {
      const scene = sceneRef.current;
      if (!scene) return;
      const { x: lx, y: ly } = scene.getLocalPosition();
      const metaUpdate: Record<string, { name: string; distance: number }> = {};

      remotePlayersRef.current.forEach((p, id) => {
        const dist = Math.hypot(p.x - lx, p.y - ly);
        metaUpdate[id] = { name: p.name, distance: dist };

        const isConnected = connectedPeersRef.current.has(id);
        if (dist < PROXIMITY_CONNECT && !isConnected) {
          connectedPeersRef.current.add(id);
          connectToPeer(id);
        } else if (dist > PROXIMITY_DISCONNECT && isConnected) {
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
        }
        setRemoteProfiles((prev) => ({ ...prev, ...nextProfiles }));

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
      } else if (data.type === "leave") {
        remotePlayersRef.current.delete(data.id);
        scene?.removeRemotePlayer(data.id);
        closePeer(data.id);
      } else if (data.type === "signal") {
        handleSignal(data.from, data.data);
      } else if (data.type === "chat") {
        setChatLog((prev) => [...prev.slice(-49), { id: data.id, text: data.text, ts: Date.now() }]);
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
        scene.onLocalMove = (x, y) => {
          socketRef.current?.send(JSON.stringify({ type: "move", x, y }));
          checkProximity();
        };
        scene.onDraftChange = (items) => setDraftItems(items);
        scene.onAvatarClick = (info) => {
          setProfileCard({ playerId: info.playerId, isLocal: info.isLocal });
          setEditingCharacter(false);
        };
      });

      const socket = new PartySocket({ host: REALTIME_HOST, room: "sala-principal" });
      socketRef.current = socket;

      socket.addEventListener("open", () => setStatus("Conectado"));
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
    socketRef.current?.send(JSON.stringify({ type: "chat", text }));
    setChatInput("");
  }

  function toggleEditMode() {
    const next = !editMode;
    setEditMode(next);
    setSelectedCatalogIndex(null);
    sceneRef.current?.setEditMode(next);
  }

  function selectCatalog(index: number) {
    // clicar de novo no mesmo item da paleta DESSELECIONA (sai do "modo
    // colocar"), igual clicar um toggle
    const next = selectedCatalogIndex === index ? null : index;
    setSelectedCatalogIndex(next);
    sceneRef.current?.selectCatalogEntry(next === null ? null : FURNITURE_CATALOG[next]);
  }

  function removeDraftItem(id: string) {
    sceneRef.current?.removeDraftFurniture(id);
  }

  function clearDraftItems() {
    sceneRef.current?.clearDraftFurniture();
  }

  async function copyGeneratedCode() {
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("Não deu pra copiar pro clipboard", e);
    }
  }

  function catalogLabelFor(item: FurnitureDef): string {
    const entry = FURNITURE_CATALOG.find((c) => c.type === item.type && c.facing === item.facing);
    return entry?.label ?? `${item.type} (${item.facing})`;
  }

  const generatedCode = useMemo(() => generateFurnitureCode(draftItems), [draftItems]);

  // reflete nome/status do MEU card ao vivo no boneco dentro do jogo
  // (nome + bolinha de status, ver setNameplate/setLocalProfile na
  // MainScene) -- roda de novo toda vez que um dos dois campos muda no
  // card. O valor inicial (cena ainda não existia nesse primeiro
  // render) já é coberto no game.events.once(READY, ...) lá em cima.
  useEffect(() => {
    sceneRef.current?.setLocalProfile(myProfile.name || "Você", statusColorFor(myProfile.status));
  }, [myProfile.name, myProfile.status]);

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

  function selectHair(hairId: string) {
    setSelectedHairId(hairId);
    sceneRef.current?.setLocalHairId(hairId);
  }

  // "Editar meu personagem" agora toma o card INTEIRO (nada de ficar
  // espremido embaixo dos campos de nome/bio junto -- ver ProfileCard)
  // e sai com Cancelar/Salvar de verdade: Cancelar volta o cabelo pro
  // que tava ANTES de abrir o editor (guardado aqui), Salvar só fecha
  // (a troca em si já foi aplicada ao vivo a cada clique no picker,
  // ver selectHair).
  const hairBeforeEditRef = useRef(selectedHairId);
  function startEditingCharacter() {
    hairBeforeEditRef.current = selectedHairId;
    setEditorCategory("cabelo");
    setEditingCharacter(true);
  }
  function cancelEditingCharacter() {
    selectHair(hairBeforeEditRef.current);
    setEditingCharacter(false);
  }
  function saveEditingCharacter() {
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
      profileSendTimer.current = setTimeout(() => sendProfileUpdate(next), 400);
      return next;
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

  function sendMessageTo(targetId: string, targetName: string) {
    sendPoke(targetId, "message");
    setChatInput((prev) => (prev ? prev : `@${targetName} `));
    closeProfileCard();
  }

  return (
    <div className="room-and-editor">
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
            editorCategory={editorCategory}
            onSelectCategory={setEditorCategory}
            measuredHeight={profileCardHeight}
            onMeasuredHeight={setProfileCardHeight}
            onAskAvailable={() => sendPoke(profileCard.playerId, "available")}
            onCallOver={() => sendPoke(profileCard.playerId, "call")}
            onSendMessage={() =>
              sendMessageTo(profileCard.playerId, remoteProfiles[profileCard.playerId]?.name || "alguém")
            }
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
            <RemoteVideoTile key={id} stream={stream} meta={remoteMeta[id]} />
          ))}
        </div>

        <div className="status-badge">{status}</div>

        <div className="controls">
          <button
            className={editMode ? "edit-toggle-btn active" : "edit-toggle-btn"}
            onClick={toggleEditMode}
            title="Editar espaço"
          >
            🛠️ {editMode ? "Sair da edição" : "Editar espaço"}
          </button>
        </div>

        <div className="av-bar">
          <button
            className={micOn ? "av-btn" : "av-btn off"}
            onClick={toggleMic}
            title={micOn ? "Desligar microfone" : "Ligar microfone"}
          >
            <MicIcon off={!micOn} />
          </button>
          <button
            className={camOn ? "av-btn" : "av-btn off"}
            onClick={toggleCam}
            title={camOn ? "Desligar câmera" : "Ligar câmera"}
          >
            <CamIcon off={!camOn} />
          </button>
          <button
            className={screenOn ? "av-btn on" : "av-btn"}
            onClick={toggleScreenShare}
            title={screenOn ? "Parar de compartilhar tela" : "Compartilhar tela"}
          >
            <ScreenIcon active={screenOn} />
          </button>
        </div>

        <ChatPanel
          log={chatLog}
          value={chatInput}
          onChange={setChatInput}
          onSend={sendChat}
        />
      </div>

      {editMode && (
        <EditPanel
          selectedCatalogIndex={selectedCatalogIndex}
          onSelectCatalog={selectCatalog}
          draftItems={draftItems}
          catalogLabelFor={catalogLabelFor}
          onRemoveItem={removeDraftItem}
          onClearAll={clearDraftItems}
          generatedCode={generatedCode}
          onCopyCode={copyGeneratedCode}
          copied={copied}
        />
      )}
    </div>
  );
}

function EditPanel({
  selectedCatalogIndex,
  onSelectCatalog,
  draftItems,
  catalogLabelFor,
  onRemoveItem,
  onClearAll,
  generatedCode,
  onCopyCode,
  copied,
}: {
  selectedCatalogIndex: number | null;
  onSelectCatalog: (index: number) => void;
  draftItems: FurnitureDef[];
  catalogLabelFor: (item: FurnitureDef) => string;
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
  generatedCode: string;
  onCopyCode: () => void;
  copied: boolean;
}) {
  return (
    <div className="edit-panel">
      <h2>Editar espaço</h2>
      <p className="edit-hint">
        Escolha um item abaixo e clique num quadrado livre da sala pra colocar.
        Clique num item já colocado (borda vermelha ao passar o mouse) pra
        remover. Isso ainda não salva sozinho — copie o código no fim e cole
        em <code>ROOM_FURNITURE</code>.
      </p>

      <div className="palette">
        {FURNITURE_CATALOG.map((entry, i) => (
          <button
            key={i}
            className={selectedCatalogIndex === i ? "palette-btn selected" : "palette-btn"}
            onClick={() => onSelectCatalog(i)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <h3>Itens colocados ({draftItems.length})</h3>
      {draftItems.length === 0 ? (
        <p className="edit-hint">Nenhum item colocado ainda.</p>
      ) : (
        <ul className="draft-list">
          {draftItems.map((item) => (
            <li key={item.id}>
              <span>
                {catalogLabelFor(item)} — col {item.col}, row {item.row}
              </span>
              <button onClick={() => onRemoveItem(item.id)} title="Remover">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {draftItems.length > 0 && (
        <button className="clear-btn" onClick={onClearAll}>
          Limpar tudo
        </button>
      )}

      <h3>Código pra colar em furniture.ts</h3>
      <textarea readOnly value={generatedCode} className="code-box" spellCheck={false} />
      <button className="copy-btn" onClick={onCopyCode}>
        {copied ? "Copiado!" : "Copiar código"}
      </button>
    </div>
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
    return (
      <div className="profile-backdrop" onClick={onClose}>
        <div
          className="profile-card editing"
          style={{ height: measuredHeight ?? 560 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="profile-edit-title">Editar meu personagem</h3>

          {/* boneco fixo no topo -- mostra AO VIVO cada escolha (base +
              cabelo selecionado empilhados, mesmo recorte de frame 0
              dos thumbnails). Só cabelo tem arte de verdade por
              enquanto; as próximas camadas (camisa, calça...) entram
              aqui sozinhas assim que LAYER_TEXTURE_FILE deixar de ser
              null pra elas, ver MainScene.ts. */}
          <div className="avatar-preview-wrap">
            <div className="avatar-preview" style={{ width: AVATAR_PREVIEW_W, height: AVATAR_PREVIEW_H }}>
              <span
                className="avatar-preview-layer"
                style={{
                  backgroundImage: "url(/assets/avatar_visual1.png)",
                  backgroundPosition: "0 0",
                  backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                }}
              />
              {selectedHairOption && (
                <span
                  className="avatar-preview-layer"
                  style={{
                    backgroundImage: `url(/assets/${selectedHairOption.file})`,
                    backgroundPosition: "0 0",
                    backgroundSize: `${HAIR_SHEET_W * (AVATAR_PREVIEW_W / 200)}px ${HAIR_SHEET_H * (AVATAR_PREVIEW_W / 200)}px`,
                  }}
                />
              )}
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

                {/* cores do item selecionado -- espaço já reservado,
                    ver ColorOption em game/customization.ts; o
                    Douglas ainda vai mandar as opções de cor de cada
                    item, até lá mostra "Em breve" no lugar */}
                {selectedHairOption && (
                  <div className="color-picker">
                    <span className="color-picker-label">Cores de &quot;{selectedHairOption.label}&quot;</span>
                    {selectedHairOption.colors && selectedHairOption.colors.length > 0 ? (
                      <div className="color-swatches">
                        {selectedHairOption.colors.map((c) => (
                          <button
                            key={c.id}
                            className="color-swatch"
                            style={{ background: c.hex }}
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

function RemoteVideoTile({
  stream,
  meta,
}: {
  stream: MediaStream;
  meta?: { name: string; distance: number };
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  const distance = meta?.distance ?? 0;
  const opacity = Math.max(0.35, 1 - distance / PROXIMITY_DISCONNECT);

  return (
    <div className="video-tile" style={{ opacity }}>
      <video ref={ref} autoPlay playsInline />
      <span className="video-name">{meta?.name ?? "Jogador"}</span>
    </div>
  );
}

function ChatPanel({
  log,
  value,
  onChange,
  onSend,
}: {
  log: ChatMessage[];
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="chat-panel">
      <div className="chat-log">
        {log.map((m, i) => (
          <div key={i} className="chat-line">
            <strong>{m.id.slice(0, 4)}:</strong> {m.text}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend();
          }}
          placeholder="Digite uma mensagem..."
        />
        <button onClick={onSend}>Enviar</button>
      </div>
    </div>
  );
}
