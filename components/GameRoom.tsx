"use client";

import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import PartySocket from "partysocket";
import MainScene from "@/game/MainScene";
import { createGameConfig } from "@/game/config";

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

    async function init() {
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
      } catch (e) {
        console.warn("Sem acesso a câmera/microfone — seguindo só com posição/chat.", e);
      }

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

  return (
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
