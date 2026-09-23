// Servidor multiplayer simples (Node.js + WebSocket puro).
//
// Substitui o PartyKit: mesma lógica (guarda a posição de cada jogador,
// avisa todo mundo quando alguém entra/sai/se move, e repassa a
// sinalização WebRTC entre pares), mas roda em qualquer host Node comum
// (ex: Render), sem depender de Durable Objects/Cloudflare.
//
// Protocolo (idêntico ao que o cliente já espera):
//   init    -> { type: "init", selfId, players: [...] }
//   join    -> { type: "join", player }
//   move    -> { type: "move", id, x, y }
//   leave   -> { type: "leave", id }
//   signal  -> { type: "signal", from, data }   (relay de WebRTC)
//   chat    -> { type: "chat", id, text }
//   profile -> { type: "profile", id, name, status, instagram, bio, photoUrl }
//              (card de perfil -- ver ProfileCard em GameRoom.tsx; "role"
//              NÃO entra aqui, é só o servidor que atribui, ver PROFILE_FIELDS)
//   poke    -> { type: "poke", from, fromName, kind, text? }
//              (botões de interação do card de OUTRO jogador -- "Disponível?"
//              / "Chamar até você" / "Enviar mensagem" -- relay privado, só
//              pro alvo, vira um toast do lado de quem recebe)

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

// campos do card de perfil que o PRÓPRIO jogador manda (ver mensagem
// "profile" acima) -- "role" fica de fora de propósito: é o único campo
// "setado pelo administrador" que o pedido descreve, e como ainda não
// existe login/admin nenhum aqui, cada jogador só recebe um valor fixo
// (PROFILE_ROLE_PLACEHOLDER) que o cliente mostra como somente-leitura.
const PROFILE_FIELDS = ["name", "status", "instagram", "bio", "photoUrl"];
const PROFILE_ROLE_PLACEHOLDER = "";
// tamanho máx de uma mensagem (principalmente a foto, que vai como
// data-URL) -- generoso o bastante pra uma foto pequena comprimida no
// cliente (ver compressPhotoToDataUrl em GameRoom.tsx), mas evita que
// alguém trave a sala mandando um payload gigante.
const MAX_MESSAGE_BYTES = 900_000;

function pickProfileFields(player) {
  const out = {};
  for (const field of PROFILE_FIELDS) out[field] = player[field] ?? "";
  return out;
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
    status: "online",
    instagram: "",
    bio: "",
    photoUrl: "",
    role: PROFILE_ROLE_PLACEHOLDER,
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
    if (raw.length > MAX_MESSAGE_BYTES) return;

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
      case "profile": {
        // card de perfil (ver ProfileCard) -- só os campos que o próprio
        // jogador é dono; "role" nunca vem do cliente (ver PROFILE_FIELDS).
        for (const field of PROFILE_FIELDS) {
          if (typeof data[field] !== "string") continue;
          const max = field === "photoUrl" ? 400_000 : field === "bio" ? 280 : 80;
          player[field] = data[field].slice(0, max);
        }
        broadcast(room, { type: "profile", id, ...pickProfileFields(player) });
        break;
      }
      case "poke": {
        // botões do card de OUTRO jogador ("Disponível?" / "Chamar até
        // você" / "Enviar mensagem") -- relay PRIVADO, só quem recebeu o
        // clique vê o toast, não a sala toda.
        const target = room.get(data.to);
        const kind = String(data.kind ?? "").slice(0, 40);
        if (target && target.ws.readyState === target.ws.OPEN && kind) {
          target.ws.send(
            JSON.stringify({ type: "poke", from: id, fromName: player.name, kind })
          );
        }
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
