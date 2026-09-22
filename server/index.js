// Servidor multiplayer simples (Node.js + WebSocket puro).
//
// Substitui o PartyKit: mesma lógica (guarda a posição de cada jogador,
// avisa todo mundo quando alguém entra/sai/se move, e repassa a
// sinalização WebRTC entre pares), mas roda em qualquer host Node comum
// (ex: Render), sem depender de Durable Objects/Cloudflare.
//
// Protocolo (idêntico ao que o cliente já espera):
//   init   -> { type: "init", selfId, players: [...] }
//   join   -> { type: "join", player }
//   move   -> { type: "move", id, x, y }
//   leave  -> { type: "leave", id }
//   signal -> { type: "signal", from, data }   (relay de WebRTC)
//   chat   -> { type: "chat", id, text }

import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 1999;

const COLORS = [
  "#ff5c7a",
  "#5c9bff",
  "#5cffb0",
  "#ffd75c",
  "#c45cff",
  "#5cf0ff",
  "#ff9a5c",
];

// roomId -> Map<connectionId, { ws, player }>
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  return room;
}

function broadcast(room, data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, conn] of room) {
    if (id === excludeId) continue;
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(msg);
  }
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Servidor multiplayer do habbo-gather está no ar.\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // aceita qualquer caminho; usa o último pedaço da URL como nome da sala
  const roomId = segments[segments.length - 1] || "default";
  const room = getRoom(roomId);

  const id = randomUUID();
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const player = {
    id,
    x: 360 + Math.floor(Math.random() * 5) * 20,
    y: 480 + Math.floor(Math.random() * 3) * 20,
    name: `Visitante-${id.slice(0, 4)}`,
    color,
  };

  room.set(id, { ws, player });

  ws.send(
    JSON.stringify({
      type: "init",
      selfId: id,
      players: Array.from(room.values()).map((c) => c.player),
    })
  );

  broadcast(room, { type: "join", player }, id);

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data?.type) {
      case "move": {
        player.x = data.x;
        player.y = data.y;
        broadcast(room, { type: "move", id, x: player.x, y: player.y }, id);
        break;
      }
      case "signal": {
        const target = room.get(data.to);
        if (target && target.ws.readyState === target.ws.OPEN) {
          target.ws.send(
            JSON.stringify({ type: "signal", from: id, data: data.data })
          );
        }
        break;
      }
      case "chat": {
        const text = String(data.text ?? "").slice(0, 300);
        if (text.trim()) broadcast(room, { type: "chat", id, text });
        break;
      }
    }
  });

  ws.on("close", () => {
    room.delete(id);
    broadcast(room, { type: "leave", id });
    if (room.size === 0) rooms.delete(roomId);
  });

  ws.on("error", (err) => {
    console.error("Erro de conexão", id, err);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Servidor multiplayer rodando na porta ${PORT}`);
});
