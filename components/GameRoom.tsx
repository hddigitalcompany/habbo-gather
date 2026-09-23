"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import PartySocket from "partysocket";
import MainScene from "@/game/MainScene";
import { createGameConfig } from "@/game/config";
import { FURNITURE_CATALOG, FurnitureDef } from "@/game/furniture";
import { generateFurnitureCode } from "@/game/furnitureCodegen";

type RemotePlayer = { id: string; x: number; y: number; name: string; color: string };
type ChatMessage = { id: string; text: string; ts: number };

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
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remotePlayersRef = useRef<Map<string, RemotePlayer>>(new Map());
  const connectedPeersRef = useRef<Set<string>>(new Set());
  const selfIdRef = useRef<string>("");

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [status, setStatus] = useState("Conectando...");
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteMeta, setRemoteMeta] = useState<
    Record<string, { name: string; distance: number }>
  >({});
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);

  // --- editor de espaço ("Editar espaço") -- modo dev: só posiciona
  // visualmente e gera o código pra colar em furniture.ts, não salva
  // nada sozinho (ver game/furnitureCodegen.ts) ---
  const [editMode, setEditMode] = useState(false);
  const [selectedCatalogIndex, setSelectedCatalogIndex] = useState<number | null>(null);
  const [draftItems, setDraftItems] = useState<FurnitureDef[]>([]);
  const [copied, setCopied] = useState(false);

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
        for (const p of data.players as RemotePlayer[]) {
          if (p.id === data.selfId) continue;
          remotePlayersRef.current.set(p.id, p);
          scene?.upsertRemotePlayer(p.id, p.x, p.y, p.color, p.name);
        }
      } else if (data.type === "join") {
        const p: RemotePlayer = data.player;
        remotePlayersRef.current.set(p.id, p);
        scene?.upsertRemotePlayer(p.id, p.x, p.y, p.color, p.name);
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
          p?.name ?? "?"
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
        scene.onLocalMove = (x, y) => {
          socketRef.current?.send(JSON.stringify({ type: "move", x, y }));
          checkProximity();
        };
        scene.onDraftChange = (items) => setDraftItems(items);
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

  return (
    <div className="room-and-editor">
      <div className="room-wrapper">
        <div ref={containerRef} className="phaser-container" />

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
          <button onClick={toggleMic} title="Microfone">
            {micOn ? "🎤" : "🔇"}
          </button>
          <button onClick={toggleCam} title="Câmera">
            {camOn ? "📷" : "🚫"}
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
