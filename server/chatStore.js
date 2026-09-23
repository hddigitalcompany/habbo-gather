// Persistência do chat (conversas diretas + grupo, histórico de
// mensagens) -- um arquivo JSON simples (data/chat.json), sem banco de
// dados de verdade: dá conta do tamanho de uma sala de amigos, e não
// depende de instalar/compilar nenhum pacote novo (só fs/crypto/path,
// que já vêm com o Node). Carrega tudo em memória uma vez no boot e
// GRAVA no disco a cada mutação (mensagem nova, conversa criada,
// grupo renomeado) -- escreve pouco, então isso é rápido o bastante.
//
// IMPORTANTE (identidade): tudo aqui é indexado pelo userId PERSISTENTE
// que o cliente manda na mensagem "identify" (gerado e salvo no
// localStorage do navegador, ver getOrCreateUserId em GameRoom.tsx) --
// NÃO pelo id de conexão (esse é novo a cada reconexão, ver server/
// index.js). Sem isso o histórico "sumiria" toda vez que a pessoa
// atualizasse a página.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "chat.json");

// quantas mensagens guarda por conversa -- limite generoso, só pra não
// deixar o arquivo crescer sem fim numa sala que fica anos no ar.
const MAX_MESSAGES_PER_CONVERSATION = 1000;

function emptyStore() {
  return { users: {}, conversations: {}, messages: {} };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users ?? {},
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    };
  } catch (e) {
    console.error("Não deu pra ler data/chat.json, começando do zero.", e);
    return emptyStore();
  }
}

const store = loadStore();

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch (e) {
    console.error("Não deu pra salvar data/chat.json", e);
  }
}

/** Guarda o último nome/cor/foto conhecidos de um usuário -- pra dar pra
 * mostrar o nome certo numa conversa mesmo com a pessoa offline. */
export function upsertUser(userId, info) {
  if (!userId) return;
  const prev = store.users[userId] ?? {};
  store.users[userId] = {
    name: info.name ?? prev.name ?? "",
    color: info.color ?? prev.color ?? "#5c9bff",
    photoUrl: info.photoUrl ?? prev.photoUrl ?? "",
  };
  persist();
}

export function getUser(userId) {
  return store.users[userId] ?? { name: "", color: "#5c9bff", photoUrl: "" };
}

/** Todo mundo já cadastrado no ambiente (qualquer um que já mandou
 * "identify" alguma vez), online ou não -- ver "Todos cadastrados no
 * ambiente, independente se ta online ou nao" no picker de participantes
 * da Agenda e na busca "pesquise a agenda de um colega" (GameRoom.tsx),
 * que antes só enxergavam quem tava conectado na sala NAQUELE momento. */
export function listAllUsers() {
  return Object.entries(store.users).map(([userId, u]) => ({
    userId,
    name: u.name || "",
    color: u.color || "#5c9bff",
    photoUrl: u.photoUrl || "",
  }));
}

function directKeyFor(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join("::");
}

/** Acha (ou cria) a conversa direta entre dois usuários -- sempre a
 * MESMA conversa pro mesmo par, não importa quem abriu primeiro. */
export function getOrCreateDirectConversation(userIdA, userIdB) {
  const key = directKeyFor(userIdA, userIdB);
  const existing = Object.values(store.conversations).find(
    (c) => c.kind === "direct" && c.directKey === key
  );
  if (existing) return existing;

  const conv = {
    id: randomUUID(),
    kind: "direct",
    directKey: key,
    name: null,
    participantIds: [userIdA, userIdB],
    createdBy: userIdA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.conversations[conv.id] = conv;
  store.messages[conv.id] = [];
  persist();
  return conv;
}

export function createGroupConversation({ name, participantIds, createdBy }) {
  const ids = Array.from(new Set([...participantIds, createdBy]));
  const conv = {
    id: randomUUID(),
    kind: "group",
    directKey: null,
    name: String(name || "Grupo sem nome").slice(0, 60),
    participantIds: ids,
    createdBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.conversations[conv.id] = conv;
  store.messages[conv.id] = [];
  persist();
  return conv;
}

export function renameGroupConversation(conversationId, name) {
  const conv = store.conversations[conversationId];
  if (!conv || conv.kind !== "group") return null;
  conv.name = String(name || conv.name).slice(0, 60);
  persist();
  return conv;
}

export function getConversation(conversationId) {
  return store.conversations[conversationId] ?? null;
}

export function isParticipant(conversationId, userId) {
  const conv = store.conversations[conversationId];
  return !!conv && conv.participantIds.includes(userId);
}

/** Todas as conversas de um usuário, mais recente primeiro, já com um
 * preview da última mensagem e os dados (nome/cor) dos outros
 * participantes -- pronto pra desenhar a lista sem consulta extra. */
export function listConversationsForUser(userId) {
  return Object.values(store.conversations)
    .filter((c) => c.participantIds.includes(userId))
    .map((c) => {
      const msgs = store.messages[c.id] ?? [];
      const last = msgs[msgs.length - 1] ?? null;
      return {
        id: c.id,
        kind: c.kind,
        name: c.name,
        participantIds: c.participantIds,
        participants: c.participantIds
          .filter((id) => id !== userId)
          .map((id) => ({ id, ...getUser(id) })),
        updatedAt: c.updatedAt,
        lastMessage: last
          ? { senderId: last.senderId, senderName: last.senderName, kind: last.kind, text: last.text, ts: last.ts }
          : null,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addMessage(conversationId, { senderId, senderName, kind, text, attachment }) {
  const conv = store.conversations[conversationId];
  if (!conv) return null;
  const msg = {
    id: randomUUID(),
    conversationId,
    senderId,
    senderName: String(senderName || "").slice(0, 80),
    kind, // "text" | "image" | "file" | "audio"
    text: text ? String(text).slice(0, 2000) : "",
    attachment: attachment
      ? {
          url: String(attachment.url || "").slice(0, 500),
          name: String(attachment.name || "arquivo").slice(0, 200),
          size: Number(attachment.size) || 0,
          mime: String(attachment.mime || "").slice(0, 100),
        }
      : null,
    ts: Date.now(),
  };
  const list = store.messages[conversationId] ?? (store.messages[conversationId] = []);
  list.push(msg);
  if (list.length > MAX_MESSAGES_PER_CONVERSATION) list.splice(0, list.length - MAX_MESSAGES_PER_CONVERSATION);
  conv.updatedAt = msg.ts;
  persist();
  return msg;
}

export function getMessages(conversationId, limit = 200) {
  const list = store.messages[conversationId] ?? [];
  return list.slice(-limit);
}

/** "Apagar mensagem" -- apaga PRA TODOS (não é só esconder do lado de
 * quem apagou): zera texto/anexo e marca "deleted", mas mantém a
 * mensagem na lista (na posição/horário originais) pra virar a tarja
 * "Fulano apagou uma mensagem" no lugar de sumir sem deixar rastro. Só
 * quem MANDOU a mensagem pode apagá-la -- devolve null se não achar a
 * mensagem/conversa ou se quem pediu não for o remetente. Idempotente
 * (apagar de novo uma já apagada só devolve ela mesma). */
export function deleteMessage(conversationId, messageId, requesterUserId) {
  const list = store.messages[conversationId];
  if (!list) return null;
  const msg = list.find((m) => m.id === messageId);
  if (!msg) return null;
  if (msg.senderId !== requesterUserId) return null;
  if (msg.deleted) return msg;
  msg.deleted = true;
  msg.text = "";
  msg.attachment = null;
  persist();
  return msg;
}
