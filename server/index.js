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
//   seat    -> cliente->servidor: { type: "seat", furnitureId }  (furnitureId
//              = id do móvel sentado agora, ou null ao levantar -- ver
//              sitAt/standUp em MainScene.ts)
//              servidor->sala: { type: "seat", id, furnitureId }
//              (o server guarda o último valor em player.seatFurnitureId,
//              igual x/y -- por isso ele já sai certo dentro de "init"/
//              "join" pra quem entra depois de alguém já sentado. Usado
//              só pra "posse" de mesa privada, ver refreshAreaOwnership em
//              MainScene.ts/game/areas.ts -- a POSIÇÃO de quem senta já
//              chega normal pelo "move" de sempre, isso aqui é só a POSE/
//              o "quem é dono de qual mesa")
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
//   chat:delete      -> cliente->servidor: { type: "chat:delete", conversationId, messageId }
//                        (só quem MANDOU a mensagem pode apagar -- apaga PRA TODOS, ver
//                        deleteMessage em chatStore.js)
//                        servidor->participantes: { type: "chat:message_deleted", conversationId, messageId }
//   chat:delete_room -> cliente->servidor: { type: "chat:delete_room", messageId }
//                        (chat da SALA não tem histórico salvo, então isso só repassa pra
//                        quem tá conectado AGORA tarjar a mensagem no próprio log local --
//                        ver comentário no case)
//                        servidor->sala: { type: "chat_room_deleted", messageId }
//   call:join         -> cliente->servidor: { type: "call:join", conversationId }
//                        (chamada de voz/vídeo de uma conversa direta/grupo -- "opt-in", só
//                        entra quem clicar; só quem PARTICIPA da conversa pode entrar)
//   call:leave        -> cliente->servidor: { type: "call:leave", conversationId }
//   call:state        -> servidor->cada participante da conversa (esteja OU NÃO na
//                        chamada, é o que acende o botão verde "entrar" de quem ainda
//                        não entrou -- ver comentário em broadcastCallState):
//                        { type: "call:state", conversationId, participants: [{ connectionId, userId, name, color, photoUrl }] }
//                        (participants: [] = ninguém na chamada agora; o mesh de WebRTC
//                        entre quem tá dentro usa o "signal" de cima, endereçado por
//                        connectionId, com um "channel":"call" dentro do "data" pra não
//                        misturar com a chamada de proximidade da Sala -- ver
//                        connectionsById/activeCalls)
//   users:list        -> servidor->sala, toda vez que alguém identifica ou muda o perfil:
//                        { type: "users:list", users: [{ userId, name, color, photoUrl }] }
//                        (todo mundo já cadastrado no ambiente, ONLINE OU NÃO -- ver
//                        listAllUsers em chatStore.js -- usado no picker de participantes
//                        e na busca de agenda de colega, que antes só viam quem tava na
//                        sala naquele momento)
//
// Upload de foto/arquivo/áudio do chat NÃO vai pelo WebSocket (ficaria
// pesado no JSON) -- vai por HTTP simples nesse mesmo servidor:
//   POST /upload?filename=<nome>   (corpo = bytes crus do arquivo, Content-Type = mime)
//     -> 200 { url, name, size, mime }  (url relativa, ver GET abaixo)
//   GET  /uploads/<arquivo>        -> serve o arquivo salvo
//
// Piso da sala ("Editar espaço" -> aba "Piso", ver EditPanel em
// GameRoom.tsx e server/roomStore.js pra persistência): antes o editor
// só gerava um código pra colar à mão em game/floor.ts, agora salva
// sozinho por aqui.
//   GET  /room/floor    -> 200 { items: FloorTileDef[] }  (piso salvo agora)
//   POST /room/floor    (corpo JSON: { items: FloorTileDef[] }, sempre o
//                        piso INTEIRO, não um diff -- ver onDraftFloorChange
//                        em MainScene.ts)
//     -> 200 { ok: true, items }
//     -> 403, DESATIVADO se NODE_ENV=production -- essa ferramenta é só
//        de uso interno do Douglas (ver IS_ROOM_EDITOR_ENABLED em
//        GameRoom.tsx, que já esconde o botão/painel pro cliente final;
//        isso aqui é a segunda trava, do lado do servidor, pro caso de
//        alguém chamar o endpoint direto sem passar pela tela). Rodando
//        `node server/index.js` localmente (npm run dev) fica disponível
//        normal; no deploy de verdade (ex: Render) o host precisa estar
//        com NODE_ENV=production setado.
//
// Áreas da sala ("Editar espaço" -> aba "Área", ver game/areas.ts pro
// conceito de zona/tipo "mesa-privada"/"sala") -- MESMO esquema do piso
// acima (mesmo arquivo data/room.json, mesma trava de produção):
//   GET  /room/areas    -> 200 { items: AreaTileDef[] }  (área salva agora)
//   POST /room/areas    (corpo JSON: { items: AreaTileDef[] }, sempre a
//                        área INTEIRA, não um diff -- ver onDraftAreaChange
//                        em MainScene.ts)
//     -> 200 { ok: true, items }
//     -> 403, mesma trava de produção do /room/floor acima.
//
// Agenda (marcar call: data/horário/participantes, necessidades de
// câmera/áudio/tela, aprovação dos convidados) -- ver server/agendaStore.js:
//   agenda:list         -> cliente->servidor: { type: "agenda:list" }
//                           servidor->cliente: { type: "agenda:calls", calls }
//   agenda:availability -> cliente->servidor: { type: "agenda:availability", candidateUserIds, startTs, durationMinutes }
//                           servidor->cliente: { type: "agenda:availability", busyUserIds }
//                           (checagem AO VIVO enquanto a pessoa preenche o
//                           formulário, pra já mostrar quem fica indisponível)
//   agenda:create       -> cliente->servidor: { type: "agenda:create", title, startTs, durationMinutes,
//                           needs, participantIds, visibility?, description?, attachments?, blocksAgenda? }
//                           (participantIds pode vir [] -- "compromisso" só da própria pessoa,
//                           sem convidar ninguém, ver comentário no case abaixo)
//                           (visibility: "public" (padrão) ou "private" -- privada só ocupa o
//                           horário pra quem pesquisar a agenda de um participante dela, ver
//                           agenda:view_colleague embaixo, sem mostrar o conteúdo)
//                           (blocksAgenda: true (padrão, "travar agenda") conta como ocupado pra quem
//                           tá na call; false ("mostrar compromisso sem travar agenda") só aparece
//                           na agenda, sem contar como conflito -- ver getConflictingUserIds)
//                           servidor->cada participante: { type: "agenda:call", call }
//                           servidor->cada convidado (exceto quem criou): { type: "agenda:invite", call }
//                           (recusa com { type: "agenda:error", reason: "conflict", busyUserIds }
//                           se alguém ficou ocupado ENTRE a checagem ao vivo e o clique em criar)
//   agenda:add_attachment -> cliente->servidor: { type: "agenda:add_attachment", callId, attachment }
//                           (só um PARTICIPANTE da call pode anexar -- diferente do "attachments" de
//                           agenda:create, que entra junto na hora de criar; esse aqui pendura um
//                           arquivo numa call que já existe, visível pra todo mundo que participa)
//                           servidor->cada participante: { type: "agenda:call", call }
//   agenda:respond      -> cliente->servidor: { type: "agenda:respond", callId, status }  (status: "approved"|"declined")
//                           servidor->cada participante: { type: "agenda:call", call }
//                           (histórico de aprovação fica visível pra todo mundo da call)
//   agenda:view_colleague -> cliente->servidor: { type: "agenda:view_colleague", userId }
//                           servidor->cliente: { type: "agenda:colleague_calls", userId, calls }
//                           (calls PRIVADAS do colega em que quem pediu não participa vêm
//                           "tarjadas" -- sem título/necessidades/participantes, só o horário,
//                           ver redact() em server/agendaStore.js)
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
import * as roomStore from "./roomStore.js";

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

// connectionId -> { ws, player } -- igual "rooms", mas achatado (sem
// precisar saber o roomId pra procurar), usado pela CHAMADA de chat (ver
// "call:join" embaixo): o mesh de WebRTC de uma call é endereçado por
// connectionId (mesmo esquema do "signal" de proximidade), então preciso
// resolver connectionId -> jogador/ws sem depender de qual sala a pessoa
// tá. Só um Map a mais espelhando o "rooms" de cima; populado/limpo nos
// mesmos pontos (connection/close).
const connectionsById = new Map();

// conversationId -> Set<connectionId> -- quem tá NA CHAMADA de uma
// conversa direta/grupo agora (ver "call:join"/"call:leave" embaixo).
// Só em memória, de propósito: uma chamada em andamento não precisa
// sobreviver a um restart do servidor (ninguém ficaria conectado mesmo,
// já que o WebSocket também cai). Diferente do chat/agenda, que persistem
// em disco -- ver chatStore.js/agendaStore.js.
const activeCalls = new Map();

/** Quem tá na chamada de uma conversa agora, já com nome/cor/foto pra
 * desenhar (ver call:state embaixo) -- ignora silenciosamente qualquer
 * connectionId que já caiu (não deveria acontecer, já que "close" limpa
 * a call, mas defende contra corrida). */
function callParticipantsPayload(conversationId) {
  const set = activeCalls.get(conversationId);
  if (!set) return [];
  const out = [];
  for (const connId of set) {
    const conn = connectionsById.get(connId);
    if (!conn) continue;
    out.push({
      connectionId: connId,
      userId: conn.player.userId,
      name: conn.player.name,
      color: conn.player.color,
      photoUrl: conn.player.photoUrl,
    });
  }
  return out;
}

/** Avisa TODO MUNDO que participa da conversa (online, esteja ou não NA
 * chamada agora) que a lista de quem tá na chamada mudou -- é o que
 * acende o botão verde "entrar na call" de quem ainda não entrou (ver
 * "tipo discord" no pedido) e atualiza a lista de participantes de quem
 * já tá dentro. */
function broadcastCallState(conversationId) {
  const conv = chatStore.getConversation(conversationId);
  if (!conv) return;
  const participants = callParticipantsPayload(conversationId);
  for (const userId of conv.participantIds) {
    sendToUser(userId, { type: "call:state", conversationId, participants });
  }
}

/** Tira uma conexão de QUALQUER chamada em que ela esteja (ver "close"
 * embaixo -- fechar a aba/cair a conexão não pode deixar um fantasma pra
 * sempre "na chamada" pros outros). Avisa só as conversas de onde ela
 * realmente saiu. */
function leaveAllCalls(connectionId) {
  for (const [conversationId, set] of activeCalls) {
    if (!set.has(connectionId)) continue;
    set.delete(connectionId);
    if (set.size === 0) activeCalls.delete(conversationId);
    broadcastCallState(conversationId);
  }
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

/** GET /room/floor -- ver comentário grande no topo do arquivo. Devolve o
 * piso salvo pra popular a cena assim que ela fica pronta (ver
 * loadSavedFloor em MainScene.ts, chamado pelo React em GameRoom.tsx). */
function handleGetFloor(req, res) {
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: roomStore.getFloor() }));
}

/** GET /room/areas -- mesma ideia do handleGetFloor acima, ver
 * loadSavedAreas em MainScene.ts. */
function handleGetAreas(req, res) {
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: roomStore.getAreas() }));
}

const MAX_ROOM_BODY_BYTES = 500_000; // generoso pro tamanho da sala hoje (12x7), evita payload absurdo

/** POST /room/floor -- ver comentário grande no topo do arquivo. Desativado
 * fora de dev (NODE_ENV=production) -- segunda trava, do lado do
 * servidor, além de já esconder o botão/painel pro cliente final (ver
 * IS_ROOM_EDITOR_ENABLED em GameRoom.tsx). */
function handlePostFloor(req, res) {
  if (process.env.NODE_ENV === "production") {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = roomStore.setFloor(data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

/** POST /room/areas -- mesma ideia/travas do handlePostFloor acima, só
 * troca roomStore.setFloor por roomStore.setAreas (ver validação em
 * server/roomStore.js -- rejeita item com `type` que não seja
 * "mesa-privada"/"sala"). */
function handlePostAreas(req, res) {
  if (process.env.NODE_ENV === "production") {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = roomStore.setAreas(data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });

  req.on("error", () => {
    aborted = true;
  });
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

  if (req.method === "GET" && url.pathname === "/room/floor") {
    handleGetFloor(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/floor") {
    handlePostFloor(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/areas") {
    handleGetAreas(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/areas") {
    handlePostAreas(req, res);
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
    // móvel (id) em que a pessoa tá sentada agora, ou null -- ver "seat"
    // no comentário de protocolo lá em cima. Guardado no player (igual
    // x/y) pra sair certo dentro de "init"/"join" pra quem entra DEPOIS
    // de alguém já sentado numa mesa privada.
    seatFurnitureId: null,
    status: "online",
    instagram: "",
    bio: "",
    photoUrl: "",
    role: PROFILE_ROLE_PLACEHOLDER,
  };

  room.set(id, { ws, player });
  connectionsById.set(id, { ws, player });
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
        // roster de "todo mundo cadastrado no ambiente" (ver
        // listAllUsers em chatStore.js) -- manda de novo pra sala inteira
        // toda vez que alguém entra/identifica, assim quem já tava
        // conectado também enxerga gente nova sem precisar recarregar.
        broadcast(room, { type: "users:list", users: chatStore.listAllUsers() });
        break;
      }
      case "move": {
        player.x = data.x;
        player.y = data.y;
        broadcast(room, { type: "move", id, x: player.x, y: player.y }, id);
        break;
      }
      case "seat": {
        const furnitureId =
          typeof data.furnitureId === "string" && data.furnitureId ? data.furnitureId.slice(0, 200) : null;
        player.seatFurnitureId = furnitureId;
        broadcast(room, { type: "seat", id, furnitureId }, id);
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
        // nome/cor/foto podem ter mudado -- atualiza o roster de todo
        // mundo pra refletir no picker de participantes/busca da Agenda
        // (ver comentário em "identify" acima).
        broadcast(room, { type: "users:list", users: chatStore.listAllUsers() });
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
        // já manda o estado de chamada de quem já tiver uma rolando --
        // sem isso o botão verde "entrar na call" só apareceria depois
        // da PRÓXIMA mudança (ver broadcastCallState), não já na
        // primeira vez que a lista de conversas carrega.
        for (const conv of conversations) {
          const participants = callParticipantsPayload(conv.id);
          if (participants.length > 0) {
            ws.send(JSON.stringify({ type: "call:state", conversationId: conv.id, participants }));
          }
        }
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
      case "chat:delete": {
        // "apagar mensagem" numa conversa direta/grupo -- apaga PRA
        // TODOS (ver deleteMessage em chatStore.js), só quem mandou pode
        // apagar a própria mensagem.
        if (typeof data.conversationId !== "string" || typeof data.messageId !== "string") break;
        if (!chatStore.isParticipant(data.conversationId, player.userId)) break;
        const deleted = chatStore.deleteMessage(data.conversationId, data.messageId, player.userId);
        if (!deleted) break;
        const conv = chatStore.getConversation(data.conversationId);
        for (const uid of conv.participantIds) {
          sendToUser(uid, { type: "chat:message_deleted", conversationId: data.conversationId, messageId: deleted.id });
        }
        break;
      }
      case "chat:delete_room": {
        // "apagar mensagem" na SALA -- diferente do de cima, a Sala não
        // guarda histórico nenhum (ver o case "chat" logo ali em cima),
        // então não tem como o servidor conferir aqui quem mandou a
        // mensagem original; só repassa pra quem tá conectado AGORA
        // tarjar no próprio log local. O cliente só mostra o botão de
        // apagar nas mensagens do PRÓPRIO usuário (ver ChatMessageRow em
        // GameRoom.tsx) -- risco aceitável pro tamanho desse projeto
        // (mesmo modelo de confiança do resto da Sala, que já deixa
        // qualquer um mandar o nome que quiser no "profile").
        if (typeof data.messageId !== "string") break;
        broadcast(room, { type: "chat_room_deleted", messageId: data.messageId });
        break;
      }

      // --- chamada de voz/vídeo de uma conversa direta/grupo ("tipo
      // discord"): opt-in (ninguém entra sozinho), qualquer participante
      // pode entrar/sair a qualquer momento, o mesh de WebRTC entre quem
      // tá NA chamada usa o mesmo relay "signal" de cima (endereçado por
      // connectionId, ver comentário em activeCalls) -- só a lista de
      // quem tá dentro passa por aqui. ---
      case "call:join": {
        if (typeof data.conversationId !== "string") break;
        if (!chatStore.isParticipant(data.conversationId, player.userId)) break;
        let set = activeCalls.get(data.conversationId);
        if (!set) {
          set = new Set();
          activeCalls.set(data.conversationId, set);
        }
        set.add(id);
        broadcastCallState(data.conversationId);
        break;
      }
      case "call:leave": {
        if (typeof data.conversationId !== "string") break;
        const set = activeCalls.get(data.conversationId);
        if (set) {
          set.delete(id);
          if (set.size === 0) activeCalls.delete(data.conversationId);
        }
        broadcastCallState(data.conversationId);
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
        // participantIds pode vir vazio -- "a pessoa pode subir
        // compromisso pra ela sozinha" (sem convidar ninguém, só ocupa
        // a própria agenda). createCall sempre inclui quem criou, então
        // um array vazio ainda vira uma call válida com 1 participante.
        const participantIds = data.participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
        const startTs = Number(data.startTs);
        const durationMinutes = Number(data.durationMinutes) || 30;
        if (!Number.isFinite(startTs)) break;

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
          visibility: data.visibility === "private" ? "private" : "public",
          description: data.description,
          attachments: data.attachments,
          blocksAgenda: data.blocksAgenda,
        });
        for (const p of call.participants) {
          sendToUser(p.id, { type: "agenda:call", call });
          if (p.id !== player.userId) sendToUser(p.id, { type: "agenda:invite", call });
        }
        scheduleReminder(call);
        break;
      }
      case "agenda:add_attachment": {
        // anexar arquivo numa call já existente (ver comentário em
        // addAttachmentToCall em server/agendaStore.js) -- o upload em si
        // já rolou por HTTP (POST /upload, ver comentário grande no
        // topo), aqui só chega a URL resultante.
        if (typeof data.callId !== "string" || !data.callId) break;
        const call = agendaStore.addAttachmentToCall(data.callId, data.attachment, player.userId);
        if (!call) break;
        for (const p of call.participants) {
          sendToUser(p.id, { type: "agenda:call", call });
        }
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
      case "agenda:view_colleague": {
        // "pesquise a agenda de um colega" -- devolve as calls dele
        // (privadas vêm tarjadas se quem pediu não for participante, ver
        // listCallsForColleague em server/agendaStore.js). Não precisa
        // ser participante de nada em comum, qualquer um da sala pode
        // pesquisar qualquer um.
        if (typeof data.userId !== "string" || !data.userId) break;
        const targetUserId = data.userId.trim().slice(0, 80);
        const calls = agendaStore.listCallsForColleague(player.userId, targetUserId);
        ws.send(JSON.stringify({ type: "agenda:colleague_calls", userId: targetUserId, calls }));
        break;
      }
    }
  });

  ws.on("close", () => {
    room.delete(id);
    connectionsById.delete(id);
    unregisterUserConnection(player.userId, ws);
    leaveAllCalls(id);
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
