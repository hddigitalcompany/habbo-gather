// Persistência do chat (conversas diretas + grupo, histórico de
// mensagens) -- ANTES vivia num arquivo JSON local (data/chat.json);
// MUDOU pro Supabase (tabela public.chat_store_state, ver
// supabase/migrations/0035_chat_and_agenda_state.sql) em 28/set, mesmo
// motivo/mesmo esquema de server/roomStore.js (ver comentário grande
// lá): disco local do Render não sobrevive a um serviço recriado, e
// não é garantido persistir nem entre deploys no free tier -- Douglas:
// "chat tem que salvar historico", e é justamente isso que esse
// arquivo guarda, então merecia a mesma correção. Continua um blob
// JSON simples ({ users, conversations, messages }), só troca ONDE
// mora. getUser/getOrCreateDirectConversation/etc continuam SÍNCRONOS
// (leem do cache em memória, `store`) -- nenhum call site mudou. Se
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não estiverem configurados
// nesse processo, cai pro arquivo local de sempre (mesmo fallback de
// roomStore.js/roomAuth.js).
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
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "chat.json");

const STORE_SLUG = "mapa-publicado";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

// quantas mensagens guarda por conversa -- limite generoso, só pra não
// deixar o arquivo crescer sem fim numa sala que fica anos no ar.
const MAX_MESSAGES_PER_CONVERSATION = 1000;

function emptyStore() {
  return { users: {}, conversations: {}, messages: {} };
}

function normalizeStore(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyStore();
  return {
    users: parsed.users ?? {},
    conversations: parsed.conversations ?? {},
    messages: parsed.messages ?? {},
  };
}

function loadStoreFromFile() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (e) {
    console.error("Não deu pra ler data/chat.json, começando do zero.", e);
    return emptyStore();
  }
}

function persistToFile(snapshot) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(snapshot), "utf8");
  } catch (e) {
    console.error("Não deu pra salvar data/chat.json", e);
  }
}

/** Mesma ideia de bootStore em roomStore.js: Supabase quando
 * configurado, com migração automática do arquivo local (se existir)
 * no primeiro boot depois desse deploy; senão cai pro arquivo. */
async function bootStore() {
  if (!admin) return loadStoreFromFile();
  try {
    const { data, error } = await admin
      .from("chat_store_state")
      .select("data")
      .eq("store_slug", STORE_SLUG)
      .maybeSingle();
    if (error) throw error;
    if (data?.data) return normalizeStore(data.data);
    const fromFile = loadStoreFromFile();
    await admin
      .from("chat_store_state")
      .upsert({ store_slug: STORE_SLUG, data: fromFile, updated_at: new Date().toISOString() });
    return fromFile;
  } catch (e) {
    console.error("Não deu pra carregar o chat do Supabase, caindo pro arquivo local.", e);
    return loadStoreFromFile();
  }
}

const store = await bootStore();

async function persist() {
  if (!admin) {
    persistToFile(store);
    return;
  }
  try {
    const { error } = await admin
      .from("chat_store_state")
      .upsert({ store_slug: STORE_SLUG, data: store, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (e) {
    console.error("Não deu pra salvar o chat no Supabase.", e);
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

// "lane" (29/set, pedido do Douglas: "vao ter duas abas nas
// conversas / EmpresaTal / Conversas Privadas / empresa, sem
// necessidade de amigo, qualquer um dentro da empresa chama qualquer
// um / conversas privadas e so desses amigos") -- "company" é o
// comportamento de SEMPRE desse arquivo (qualquer um conversa com
// qualquer um, sem trava nenhuma) e continua exatamente assim, só
// ganhou um nome; "private" é NOVO e só pode ser criada entre amigos
// mútuos (ver areMutualFriends abaixo, chamada pelos call sites em
// server/index.js ANTES de chegar aqui -- essa função aqui não
// confere nada, só guarda o rótulo). O par de usuários pode ter as
// DUAS conversas ao mesmo tempo (uma "company", uma "private") --
// por isso o directKey agora inclui a lane, senão a segunda
// conversa "roubaria" o histórico da primeira.
function directKeyFor(userIdA, userIdB, lane) {
  return [lane, ...[userIdA, userIdB].sort()].join("::");
}

/** Acha (ou cria) a conversa direta entre dois usuários NUMA lane --
 * sempre a MESMA conversa pro mesmo par+lane, não importa quem abriu
 * primeiro. `lane` default "company" mantém o comportamento de
 * sempre pra quem já chama isso sem saber da lane nova. */
export function getOrCreateDirectConversation(userIdA, userIdB, lane = "company", companyInfo = null) {
  const key = directKeyFor(userIdA, userIdB, lane);
  const existing = Object.values(store.conversations).find(
    (c) => c.kind === "direct" && c.directKey === key
  );
  if (existing) return existing;

  const conv = {
    id: randomUUID(),
    kind: "direct",
    directKey: key,
    lane,
    name: null,
    // 29/set (13), pedido do Douglas: "quero a logo da empresa em que
    // ele abriu o chat, porque funcionarios podem participar de mais
    // empresas" -- só faz sentido lane "company" (direta com QUALQUER
    // um por perto, ver comentário grande de "lane" mais abaixo);
    // "private" nunca tem sala envolvida (pode nascer de fora, ver
    // painel de Amigos/FriendsPanel.tsx), fica sempre null. Congelado
    // no momento da criação -- mesmo espírito "última conhecida" que
    // getUser já usa (ver createGroupConversation acima).
    companyName: lane === "company" && companyInfo ? companyInfo.name : null,
    companyLogoUrl: lane === "company" && companyInfo ? companyInfo.logoUrl : null,
    participantIds: [userIdA, userIdB],
    createdBy: userIdA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // 29/set (14), pedido do Douglas: "quando eu abro a conversa nao
    // mostra onde ta a mensagem nao vista, e quando eu vejo, ela nao
    // some a marcacao" -- contador de não-lida de verdade (ver
    // markConversationRead/listConversationsForUser abaixo). Quem CRIA
    // a conversa já "leu" ela na hora (sem isso, o próprio criador
    // veria a marcação de não-lida na conversa que ele mesmo abriu).
    lastRead: { [userIdA]: Date.now() },
  };
  store.conversations[conv.id] = conv;
  store.messages[conv.id] = [];
  persist();
  return conv;
}

/** Confere se dois usuários são amigos mútuos (os dois se seguem, ver
 * tabela public.followers / app/api/friends/**) -- só usado pra
 * travar a criação de conversa na lane "private" (ver comentário
 * grande acima); "company" nunca chama isso. Sem Supabase configurado
 * (dev local sem .env), deixa passar -- mesma postura permissiva do
 * resto desse arquivo quando cai pro arquivo local. */
export async function areMutualFriends(userIdA, userIdB) {
  if (!admin) return true;
  try {
    const [a, b] = await Promise.all([
      admin.from("followers").select("follower_id").eq("follower_id", userIdA).eq("followed_id", userIdB).maybeSingle(),
      admin.from("followers").select("follower_id").eq("follower_id", userIdB).eq("followed_id", userIdA).maybeSingle(),
    ]);
    return !!a.data && !!b.data;
  } catch {
    return false;
  }
}

export function createGroupConversation({ name, participantIds, createdBy, companyInfo = null }) {
  const ids = Array.from(new Set([...participantIds, createdBy]));
  const conv = {
    id: randomUUID(),
    kind: "group",
    directKey: null,
    // grupo é sempre lane "company" (servidor nunca manda "private"
    // num grupo, ver chat:create_group em server/index.js) -- antes
    // ficava implícito (listConversationsForUser caía no fallback
    // `c.lane || "company"`), agora vem explícito porque companyName/
    // companyLogoUrl abaixo só fazem sentido nessa lane.
    lane: "company",
    name: String(name || "Grupo sem nome").slice(0, 60),
    // 29/set (13), pedido do Douglas: "quero a logo da empresa em que
    // ele abriu o chat, porque funcionarios podem participar de mais
    // empresas" -- congela o nome/logo da empresa (sala) de onde o
    // grupo nasceu (ver getRoomCompanyInfo em server/roomAuth.js,
    // chamado pelo case "chat:create_group" em index.js), mesmo
    // espírito de "última conhecida" que getUser já usa pra nome/cor/
    // foto de pessoa -- não persegue a sala se a empresa mudar de
    // nome/logo depois.
    companyName: companyInfo ? companyInfo.name : null,
    companyLogoUrl: companyInfo ? companyInfo.logoUrl : null,
    participantIds: ids,
    createdBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // ver comentário grande em getOrCreateDirectConversation acima --
    // mesmo motivo (quem cria já leu a própria conversa).
    lastRead: { [createdBy]: Date.now() },
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

/** "3 pontinhos" -- mover uma conversa 1x1 de aba (Empresa <-> Privada,
 * pedido do Douglas, 29/set (18): "nas conversas tem que ter 3
 * pontinhos do lado lá, que ele pode jogar a conversa pra alguma
 * empresa, e vice versa, apenas com conversas 1x1, nos grupos nao").
 * Não mexe na TRAVA de amigo mútuo (essa é só pra CRIAR uma conversa
 * nova pela aba Empresa/painel de Amigos, ver getOrCreateDirectConversation
 * e os call sites em server/index.js) -- mover uma conversa que já
 * existe é ação deliberada da própria pessoa, não passa por ela.
 *
 * `directKey` inclui a lane (ver comentário grande dela acima -- o
 * mesmo par pode ter uma conversa "company" E uma "private" ao mesmo
 * tempo), então mudar a lane de uma conversa existente pode fazer ela
 * colidir com outra que já existia na lane de destino. Nesse caso,
 * MESCLA: todas as mensagens das duas entram na sobrevivente (por
 * ordem de horário), a outra é apagada -- histórico de nenhum dos dois
 * lados se perde, só vira uma conversa só, exatamente o que "jogar a
 * conversa pra lá" quer dizer quando já tinha prosa nas duas.
 *
 * `companyInfo` (mesmo formato de getOrCreateDirectConversation) só
 * importa indo PRA "company" -- indo pra "private" sempre limpa
 * companyName/companyLogoUrl (conversa privada nunca carimba empresa).
 * Devolve { conversation, removedConversationId } -- removedConversationId
 * é o id da OUTRA conversa apagada na mescla (null se não colidiu com
 * nenhuma), pra quem chamar avisar os dois lados de tirar esse id da
 * lista local deles (ver sendConversationTo/chat:conversation-removed
 * em server/index.js). null (não o objeto) se não existir/não for
 * direta (grupo)/quem pediu não for participante dela.
 */
export function setConversationLane(conversationId, requesterUserId, lane, companyInfo = null) {
  const conv = store.conversations[conversationId];
  if (!conv || conv.kind !== "direct") return null;
  if (!conv.participantIds.includes(requesterUserId)) return null;
  if (lane !== "company" && lane !== "private") return null;
  if (conv.lane === lane) return { conversation: conv, removedConversationId: null }; // já tá lá, nada pra fazer

  const [userIdA, userIdB] = conv.participantIds;
  const newKey = directKeyFor(userIdA, userIdB, lane);
  const collision = Object.values(store.conversations).find(
    (c) => c.id !== conv.id && c.kind === "direct" && c.directKey === newKey
  );

  if (collision) {
    // mescla as mensagens das duas na sobrevivente (conv, a que
    // mudou de lane) -- ordena por ts pra não embaralhar o histórico.
    const ownMsgs = store.messages[conv.id] ?? [];
    const otherMsgs = store.messages[collision.id] ?? [];
    const merged = [...ownMsgs, ...otherMsgs].sort((a, b) => a.ts - b.ts);
    if (merged.length > MAX_MESSAGES_PER_CONVERSATION) {
      merged.splice(0, merged.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    store.messages[conv.id] = merged;
    delete store.messages[collision.id];
    // lastRead: mantém o mais RECENTE de cada usuário entre as duas
    // (nunca marca como "lido" algo que a pessoa não tinha visto).
    const mergedLastRead = { ...collision.lastRead, ...conv.lastRead };
    for (const uid of Object.keys(collision.lastRead || {})) {
      if (collision.lastRead[uid] > (conv.lastRead?.[uid] ?? 0)) mergedLastRead[uid] = collision.lastRead[uid];
    }
    conv.lastRead = mergedLastRead;
    if (merged.length > 0) conv.updatedAt = merged[merged.length - 1].ts;
    delete store.conversations[collision.id];
  }

  conv.lane = lane;
  conv.directKey = newKey;
  conv.companyName = lane === "company" && companyInfo ? companyInfo.name : null;
  conv.companyLogoUrl = lane === "company" && companyInfo ? companyInfo.logoUrl : null;
  persist();
  return { conversation: conv, removedConversationId: collision ? collision.id : null };
}

export function isParticipant(conversationId, userId) {
  const conv = store.conversations[conversationId];
  return !!conv && conv.participantIds.includes(userId);
}

/** Marca uma conversa como lida por um usuário (chamado quando abre a
 * conversa -- ver o case "chat:open" no WebSocket e POST /chat/open
 * em server/index.js, esse último pro Lobby que não tem socket).
 * Devolve o lastRead ANTERIOR (ou 0 se nunca tinha lido) -- é o corte
 * que o cliente usa pra desenhar a linha "mensagens não vistas" na
 * hora que abre (pedido do Douglas, 29/set: "quando eu abro a
 * conversa nao mostra onde ta a mensagem nao vista"), antes desse
 * corte avançar pro "agora". null se a conversa não existe ou o
 * usuário não é participante dela. */
export function markConversationRead(conversationId, userId) {
  const conv = store.conversations[conversationId];
  if (!conv || !conv.participantIds.includes(userId)) return null;
  if (!conv.lastRead) conv.lastRead = {};
  const previous = conv.lastRead[userId] ?? 0;
  conv.lastRead[userId] = Date.now();
  persist();
  return previous;
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
      // 29/set (14), pedido do Douglas: "gostei da forma de mostrar
      // que tem mensagem, mantenha / mas nao esta funcionando" -- a
      // marcação antiga era só "tem conversa nenhuma" (contava TODAS
      // as conversas, não as com mensagem não vista de verdade). Conta
      // de verdade: mensagens de QUALQUER outro participante, depois
      // do último lastRead salvo pra esse userId (0 == nunca leu, ver
      // markConversationRead acima -- conversa criada por ESSE userId
      // já nasce com lastRead preenchido, ver getOrCreateDirectConversation/
      // createGroupConversation).
      const lastReadTs = c.lastRead?.[userId] ?? 0;
      const unreadCount = msgs.reduce(
        (n, m) => (m.senderId !== userId && m.ts > lastReadTs ? n + 1 : n),
        0
      );
      return {
        id: c.id,
        kind: c.kind,
        // conversas criadas ANTES dessa lane existir não têm o campo
        // -- trata como "company", que é o comportamento que elas
        // sempre tiveram (ver comentário grande em
        // getOrCreateDirectConversation acima).
        lane: c.lane || "company",
        name: c.name,
        // 29/set (13): ver comentário grande em getOrCreateDirectConversation/
        // createGroupConversation acima -- conversa criada ANTES dessa
        // mudança não tem esses campos, cai pra null (mesmo trato que
        // "lane" já recebia com c.lane || "company").
        companyName: c.companyName ?? null,
        companyLogoUrl: c.companyLogoUrl ?? null,
        participantIds: c.participantIds,
        participants: c.participantIds
          .filter((id) => id !== userId)
          .map((id) => ({ id, ...getUser(id) })),
        updatedAt: c.updatedAt,
        unreadCount,
        lastMessage: last
          ? { senderId: last.senderId, senderName: last.senderName, kind: last.kind, text: last.text, ts: last.ts }
          : null,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addMessage(conversationId, { senderId, senderName, kind, text, attachment, roomCard }) {
  const conv = store.conversations[conversationId];
  if (!conv) return null;
  const msg = {
    id: randomUUID(),
    conversationId,
    senderId,
    senderName: String(senderName || "").slice(0, 80),
    kind, // "text" | "image" | "file" | "audio" | "room_card"
    text: text ? String(text).slice(0, 2000) : "",
    attachment: attachment
      ? {
          url: String(attachment.url || "").slice(0, 500),
          name: String(attachment.name || "arquivo").slice(0, 200),
          size: Number(attachment.size) || 0,
          mime: String(attachment.mime || "").slice(0, 100),
        }
      : null,
    // "convidar amigo pra sua sala" / "pedir pra visitar" (pedido do
    // Douglas, 30/set: "os contatos, se convidarem direto com envio de
    // convite que na conversa fica como um cardzinho ... visitante nao
    // se tornam membros") -- cardzinho especial dentro da conversa, NÃO
    // é um anexo de verdade (não passa por /upload). action "invite" já
    // vem com a sala de quem convidou (roomSlug/roomName/roomLogoUrl);
    // action "visit" é só o pedido ("Fulano está querendo ir até você"),
    // sem sala nenhuma anexada -- quem recebe é que decide convidar de
    // volta (ver onAcceptVisit em ChatMessageRow/GameRoom.tsx). "Entrar"
    // num convite reaproveita o MESMO link ?visitar=<slug> de sempre
    // (POST /api/room/visit só registra um bookmark, nunca vira membro,
    // ver comentário grande na rota) -- então visitante continua nunca
    // virando membro por essa via, do jeito que o Douglas pediu.
    roomCard: roomCard
      ? {
          action: roomCard.action === "invite" ? "invite" : "visit",
          roomSlug: String(roomCard.roomSlug || "").slice(0, 200),
          roomName: String(roomCard.roomName || "").slice(0, 200),
          roomLogoUrl: String(roomCard.roomLogoUrl || "").slice(0, 500),
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
