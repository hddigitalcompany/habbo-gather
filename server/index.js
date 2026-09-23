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
//   chat    -> cliente->servidor: { type: "chat", text?, attachment?, kind? }
//              servidor->sala:    { type: "chat", id, message }
//              (chat da SALA, todo mundo vê -- NÃO fica salvo em disco,
//              diferente do chat direto/grupo abaixo; "message" tem o
//              mesmo formato de "chat:message" lá embaixo, pra dar pra
//              desenhar com o mesmo componente dos dois lados)
//   profile -> { type: "profile", id, name, status, instagram, bio, photoUrl }
//              (card de perfil -- ver ProfileCard em GameRoom.tsx; "role"
//              NÃO entra aqui, é só o servidor que atribui, ver PROFILE_FIELDS)
//   poke    -> { type: "poke", from, fromName, kind, text? }
//              (botões de interação do card de OUTRO jogador -- "Disponível?"
//              / "Chamar até você" / "Enviar mensagem" -- relay privado, só
//              pro alvo, vira um toast do lado de quem recebe)
//
// Chat de VERDADE (conversa direta/grupo, histórico, foto/arquivo/áudio)
// -- ver server/chatStore.js pra persistência e o comentário logo antes
// de PROFILE_FIELDS pra por que usa "userId" (persistente) em vez do id
// de conexão (que troca a cada reconexão):
//   identify         -> cliente->servidor, primeira coisa mandada na conexão:
//                        { type: "identify", userId }
//   chat:list        -> cliente->servidor: { type: "chat:list" }
//                        servidor->cliente: { type: "chat:conversations", conversations }
//   chat:open        -> cliente->servidor: { type: "chat:open", conversationId }
//                        servidor->cliente: { type: "chat:history", conversationId, messages }
//   chat:create_direct -> cliente->servidor: { type: "chat:create_direct", targetUserId }
//   chat:create_group  -> cliente->servidor: { type: "chat:create_group", name, participantIds }
//   chat:rename_group  -> cliente->servidor: { type: "chat:rename_group", conversationId, name }
//   (create_direct/create_group/rename_group respondem, pra CADA participante
//   online, com) -> { type: "chat:conversation", conversation }
//   chat:send        -> cliente->servidor: { type: "chat:send", conversationId, text?, attachment?, kind? }
//                        servidor->participantes online: { type: "chat:message", conversationId, message }
//
// Upload de foto/arquivo/áudio do chat NÃO vai pelo WebSocket (ficaria
// pesado no JSON) -- vai por HTTP simples nesse mesmo servidor:
//   POST /upload?filename=<nome>   (corpo = bytes crus do arquivo, Content-Type = mime)
//     -> 200 { url, name, size, mime }  (url relativa, ver GET abaixo)
//   GET  /uploads/<arquivo>        -> serve o arquivo salvo
//
// Agenda (marcar call: data/horário/participantes, necessidades de
// câmera/áudio/tela, aprovação dos convidados) -- ver server/agendaStore.js:
//   agenda:list         -> cliente->servidor: { type: "agenda:list" }
//                           servidor->cliente: { type: "agenda:calls", calls }
//   agenda:availability -> cliente->servidor: { type: "agenda:availability", candidateUserIds, startTs, durationMinutes }
//                           servidor->cliente: { type: "agenda:availability", busyUserIds }
//                           (checagem AO VIVO enquanto a pessoa preenche o
//                           formulário, pra já mostrar quem fica indisponível)
//   agenda:create       -> cliente->servidor: { type: "agenda:create", title, startTs, durationMinutes, needs, participantIds }
//                           servidor->cada participante: { type: "agenda:call", call }
//                           servidor->cada convidado (exceto quem criou): { type: "agenda:invite", call }
//                           (recusa com { type: "agenda:error", reason: "conflict", busyUserIds }
//                           se alguém ficou ocupado ENTRE a checagem ao vivo e o clique em criar)
//   agenda:respond      -> cliente->servidor: { type: "agenda:respond", callId, status }  (status: "approved"|"declined")
//                           servidor->cada participante: { type: "agenda:call", call }
//                           (histórico de aprovação fica visível pra todo mundo da call)
//   agenda:reminder     -> servidor->participantes (não recusados), alguns minutos antes do horário:
//                           { type: "agenda:reminder", call }
//                           (timer em memória -- some se o servidor reiniciar antes da hora)

import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { createWriteStream, createReadStream, existsSync, mkdirSync } from "fs";
import { unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as chatStore from "./chatStore.js";
import * as agendaStore from "./agendaStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

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

// --- identidade persistente pro CHAT (ver comentário grande lá em cima) ---
// userId -> Set<ws> -- uma pessoa pode ter mais de uma aba/dispositivo
// aberta ao mesmo tempo, todas recebem as mensagens.
const connectionsByUserId = new Map();

function registerUserConnection(userId, ws) {
  let set = connectionsByUserId.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUserId.set(userId, set);
  }
  set.add(ws);
}

function unregisterUserConnection(userId, ws) {
  const set = connectionsByUserId.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connectionsByUserId.delete(userId);
}

function sendToUser(userId, data) {
  const set = connectionsByUserId.get(userId);
  if (!set) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/** Manda a versão "enriquecida" (com participantes/preview) de UMA
 * conversa específica pro dono de um userId -- usado depois de criar/
 * renomear, cada participante vê a lista atualizar sozinha. */
function sendConversationTo(userId, conversationId) {
  const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conversationId);
  if (enriched) sendToUser(userId, { type: "chat:conversation", conversation: enriched });
}

// --- lembrete de call agendada (ver server/agendaStore.js) ---
const REMINDER_LEAD_MS = 5 * 60 * 1000; // avisa 5min antes do horário marcado
const MAX_SETTIMEOUT_MS = 2_147_000_000; // margem abaixo do limite de 32 bits do setTimeout (~24.8 dias)

function scheduleReminder(call) {
  const fireAt = call.startTs - REMINDER_LEAD_MS;
  const delay = fireAt - Date.now();
  // só agenda se falta MENOS que o limite do setTimeout -- calls marcadas
  // com muita antecedência não recebem lembrete (o servidor não guarda
  // timers em disco: se reiniciar antes da hora, esse lembrete específico
  // se perde; aceitável pro tamanho desse projeto, sem fila de jobs).
  if (delay <= 0 || delay > MAX_SETTIMEOUT_MS) return;
  setTimeout(() => {
    const fresh = agendaStore.getCall(call.id);
    if (!fresh) return;
    for (const p of fresh.participants) {
      if (p.status !== "declined") sendToUser(p.id, { type: "agenda:reminder", call: fresh });
    }
  }, delay);
}

// campos do card de perfil que o PRÓPRIO jogador manda (ver mensagem
// "profile" acima) -- "role" fica de fora de propósito: é o único campo
// "setado pelo administrador" que o pedido descreve, e como ainda não
// existe login/admin nenhum aqui, cada jogador só recebe um valor fixo
// (PROFILE_ROLE_PLACEHOLDER) que o cliente mostra como somente-leitura.
const PROFILE_FIELDS = ["name", "status", "instagram", "bio", "photoUrl"];
const PROFILE_ROLE_PLACEHOLDER = "";
// tamanho máx de uma mensagem (principalmente a foto de PERFIL, que vai
// como data-URL) -- generoso o bastante pra uma foto pequena comprimida
// no cliente (ver compressPhotoToDataUrl em GameRoom.tsx), mas evita que
// alguém trave a sala mandando um payload gigante. Anexos de CHAT não
// passam por aqui -- ver upload HTTP lá em cima, só a URL entra na
// mensagem WS, que é pequena.
const MAX_MESSAGE_BYTES = 900_000;

function pickProfileFields(player) {
  const out = {};
  for (const field of PROFILE_FIELDS) out[field] = player[field] ?? "";
  return out;
}

function syncChatUser(player) {
  if (!player.userId) return;
  chatStore.upsertUser(player.userId, {
    name: player.name,
    color: player.color,
    photoUrl: player.photoUrl,
  });
}

// --- upload de arquivo do chat: HTTP simples (sem multipart, o corpo
// inteiro do POST já É o arquivo) -- ver comentário grande no topo. ---
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB, dá pra foto/áudio curto/PDF pequeno

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function handleUpload(req, res, url) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Arquivo muito grande (máx 20MB)");
    return;
  }

  const filenameParam = (url.searchParams.get("filename") || "arquivo").slice(0, 200);
  const ext = path.extname(filenameParam).slice(0, 12);
  const diskName = `${randomUUID()}${ext}`;
  const diskPath = path.join(UPLOAD_DIR, diskName);
  const writeStream = createWriteStream(diskPath);

  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      writeStream.destroy();
      unlink(diskPath).catch(() => {});
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Arquivo muito grande (máx 20MB)");
      }
      req.destroy();
    }
  });

  req.on("error", () => {
    writeStream.destroy();
  });

  req.pipe(writeStream);

  writeStream.on("finish", () => {
    if (aborted) return;
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        url: `/uploads/${diskName}`,
        name: filenameParam,
        size: received,
        mime: req.headers["content-type"] || "",
      })
    );
  });

  writeStream.on("error", (e) => {
    console.error("Falha ao salvar upload", e);
    if (!res.headersSent) {
      res.writeHead(500, corsHeaders());
      res.end("Erro ao salvar arquivo");
    }
  });
}

function handleServeUpload(req, res, pathname) {
  // path.basename corta qualquer "../" -- só deixa pegar arquivo direto
  // de dentro de UPLOAD_DIR, nunca escapar pra outra pasta.
  const safeName = path.basename(pathname);
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!filePath.startsWith(UPLOAD_DIR) || !existsSync(filePath)) {
    res.writeHead(404, corsHeaders());
    res.end("Não encontrado");
    return;
  }
  const ext = path.extname(safeName).toLowerCase();
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  res.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": mime,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
}

const httpServer = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/upload") {
    handleUpload(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    handleServeUpload(req, res, url.pathname);
    return;
  }

  res.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
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
    // userId "de verdade" (persistente, ver identify) só chega DEPOIS
    // da conexão abrir -- até lá cai de volta pro id da conexão, então
    // o chat ainda funciona (só não mantém histórico entre reconexões)
    // mesmo se o cliente nunca mandar identify.
    userId: id,
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
  registerUserConnection(player.userId, ws);

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
      case "identify": {
        // troca o userId "provisório" (= id da conexão) pelo PERSISTENTE
        // que o cliente guarda no localStorage -- ver getOrCreateUserId
        // em GameRoom.tsx. Sem isso o histórico de chat reiniciaria do
        // zero a cada F5.
        const newUserId =
          typeof data.userId === "string" && data.userId.trim() ? data.userId.trim().slice(0, 80) : id;
        if (newUserId !== player.userId) {
          unregisterUserConnection(player.userId, ws);
          player.userId = newUserId;
          registerUserConnection(player.userId, ws);
          // "join" (mandado pro resto da sala no exato instante em que a
          // conexão abriu, ver embaixo) sempre sai ANTES desse "identify"
          // chegar (é round-trip de rede, o outro é local/síncrono) --
          // nesse momento o player.userId de todo mundo ainda tá com o
          // valor provisório (= id da conexão). Sem avisar a sala da
          // troca, quem já tava na sala ficaria pra sempre com o userId
          // ERRADO desse jogador (ver remotePlayersRef em GameRoom.tsx),
          // e uma conversa direta iniciada CONTRA ele usaria um id que
          // muda a cada reconexão -- exatamente o problema que o
          // "userId" persistente existe pra evitar.
          broadcast(room, { type: "identity", id, userId: player.userId }, id);
        }
        syncChatUser(player);
        break;
      }
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
        // chat da SALA -- não fica salvo (ver comentário grande no topo),
        // mas agora aceita anexo (foto/arquivo/áudio) igual ao chat
        // direto/grupo, no mesmo formato de mensagem (ver chat:send
        // embaixo) pra dar pra desenhar com o mesmo componente.
        const text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
        const attachment =
          data.attachment && typeof data.attachment === "object"
            ? {
                url: String(data.attachment.url || "").slice(0, 500),
                name: String(data.attachment.name || "arquivo").slice(0, 200),
                size: Number(data.attachment.size) || 0,
                mime: String(data.attachment.mime || "").slice(0, 100),
              }
            : null;
        if (!text.trim() && !attachment) break;
        const kind = !attachment ? "text" : data.kind === "audio" ? "audio" : data.kind === "image" ? "image" : "file";
        const message = {
          id: randomUUID(),
          senderId: player.userId,
          senderName: player.name,
          kind,
          text,
          attachment,
          ts: Date.now(),
        };
        broadcast(room, { type: "chat", id, message });
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
        syncChatUser(player);
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

      // --- chat de verdade: direta/grupo, histórico, foto/arquivo/áudio
      // (ver comentário grande no topo do arquivo e server/chatStore.js) ---
      case "chat:list": {
        const conversations = chatStore.listConversationsForUser(player.userId);
        ws.send(JSON.stringify({ type: "chat:conversations", conversations }));
        break;
      }
      case "chat:open": {
        if (typeof data.conversationId !== "string") break;
        if (!chatStore.isParticipant(data.conversationId, player.userId)) break;
        const messages = chatStore.getMessages(data.conversationId);
        ws.send(JSON.stringify({ type: "chat:history", conversationId: data.conversationId, messages }));
        break;
      }
      case "chat:create_direct": {
        if (typeof data.targetUserId !== "string" || !data.targetUserId) break;
        if (data.targetUserId === player.userId) break;
        const conv = chatStore.getOrCreateDirectConversation(player.userId, data.targetUserId);
        sendConversationTo(player.userId, conv.id);
        sendConversationTo(data.targetUserId, conv.id);
        break;
      }
      case "chat:create_group": {
        if (!Array.isArray(data.participantIds)) break;
        const participantIds = data.participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
        if (participantIds.length === 0) break;
        const conv = chatStore.createGroupConversation({
          name: data.name,
          participantIds,
          createdBy: player.userId,
        });
        for (const uid of conv.participantIds) sendConversationTo(uid, conv.id);
        break;
      }
      case "chat:rename_group": {
        if (typeof data.conversationId !== "string" || typeof data.name !== "string") break;
        if (!chatStore.isParticipant(data.conversationId, player.userId)) break;
        const conv = chatStore.renameGroupConversation(data.conversationId, data.name);
        if (!conv) break;
        for (const uid of conv.participantIds) sendConversationTo(uid, conv.id);
        break;
      }
      case "chat:send": {
        if (typeof data.conversationId !== "string") break;
        if (!chatStore.isParticipant(data.conversationId, player.userId)) break;
        const text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
        const attachment =
          data.attachment && typeof data.attachment === "object"
            ? {
                url: data.attachment.url,
                name: data.attachment.name,
                size: data.attachment.size,
                mime: data.attachment.mime,
              }
            : null;
        if (!text.trim() && !attachment) break;
        const kind = !attachment ? "text" : data.kind === "audio" ? "audio" : data.kind === "image" ? "image" : "file";
        const msg = chatStore.addMessage(data.conversationId, {
          senderId: player.userId,
          senderName: player.name,
          kind,
          text,
          attachment,
        });
        if (!msg) break;
        const conv = chatStore.getConversation(data.conversationId);
        for (const uid of conv.participantIds) {
          sendToUser(uid, { type: "chat:message", conversationId: data.conversationId, message: msg });
        }
        break;
      }

      // --- agenda: marcar call (data/horário/participantes, necessidades
      // de câmera/áudio/tela), aprovação dos convidados, checagem de
      // conflito de horário (ver server/agendaStore.js) ---
      case "agenda:list": {
        const calls = agendaStore.listCallsForUser(player.userId);
        ws.send(JSON.stringify({ type: "agenda:calls", calls }));
        break;
      }
      case "agenda:availability": {
        if (!Array.isArray(data.candidateUserIds)) break;
        const candidateUserIds = data.candidateUserIds.filter((x) => typeof x === "string").slice(0, 100);
        const startTs = Number(data.startTs);
        const durationMinutes = Number(data.durationMinutes) || 30;
        if (!Number.isFinite(startTs)) break;
        const busyUserIds = agendaStore.getConflictingUserIds(candidateUserIds, startTs, durationMinutes);
        ws.send(JSON.stringify({ type: "agenda:availability", busyUserIds }));
        break;
      }
      case "agenda:create": {
        if (!Array.isArray(data.participantIds)) break;
        const participantIds = data.participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
        const startTs = Number(data.startTs);
        const durationMinutes = Number(data.durationMinutes) || 30;
        if (!Number.isFinite(startTs) || participantIds.length === 0) break;

        // revalida no servidor (defesa contra corrida: alguém marcou
        // ENQUANTO essa pessoa preenchia o formulário) -- se algum
        // convidado ficou ocupado nesse meio-tempo, recusa a criação
        // inteira em vez de criar silenciosamente sem essa pessoa.
        const busyUserIds = agendaStore.getConflictingUserIds(participantIds, startTs, durationMinutes);
        if (busyUserIds.length > 0) {
          ws.send(JSON.stringify({ type: "agenda:error", reason: "conflict", busyUserIds }));
          break;
        }

        const call = agendaStore.createCall({
          title: data.title,
          startTs,
          durationMinutes,
          needs: data.needs,
          participantIds,
          createdBy: player.userId,
        });
        for (const p of call.participants) {
          sendToUser(p.id, { type: "agenda:call", call });
          if (p.id !== player.userId) sendToUser(p.id, { type: "agenda:invite", call });
        }
        scheduleReminder(call);
        break;
      }
      case "agenda:respond": {
        if (typeof data.callId !== "string" || typeof data.status !== "string") break;
        const call = agendaStore.respondToCall(data.callId, player.userId, data.status);
        if (!call) break;
        for (const p of call.participants) {
          sendToUser(p.id, { type: "agenda:call", call });
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    room.delete(id);
    unregisterUserConnection(player.userId, ws);
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
