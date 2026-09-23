// Persistência da Agenda (marcar call: data/horário/participantes,
// necessidades de câmera/áudio/tela, aprovação dos convidados) -- mesmo
// esquema do chatStore.js: um arquivo JSON simples (data/agenda.json),
// sem banco de dados de verdade. Indexado pelo userId PERSISTENTE (ver
// comentário grande em chatStore.js sobre por que não usa o id de
// conexão).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { getUser } from "./chatStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "agenda.json");

function emptyStore() {
  return { calls: {} };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { calls: parsed.calls ?? {} };
  } catch (e) {
    console.error("Não deu pra ler data/agenda.json, começando do zero.", e);
    return emptyStore();
  }
}

const store = loadStore();

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch (e) {
    console.error("Não deu pra salvar data/agenda.json", e);
  }
}

function overlaps(aStart, aDuration, bStart, bDuration) {
  const aEnd = aStart + aDuration * 60_000;
  const bEnd = bStart + bDuration * 60_000;
  return aStart < bEnd && bStart < aEnd;
}

/** Mesmo saneamento de anexo que o chatStore.js usa pras mensagens de
 * chat (ver addMessage lá) -- reaproveitado aqui pros anexos de um
 * compromisso, que vêm do MESMO endpoint HTTP de upload (POST /upload
 * em server/index.js), só que penduram na call em vez de numa mensagem. */
function sanitizeAttachment(a) {
  if (!a || typeof a !== "object") return null;
  const url = String(a.url || "").slice(0, 500);
  if (!url) return null;
  return {
    url,
    name: String(a.name || "arquivo").slice(0, 200),
    size: Number(a.size) || 0,
    mime: String(a.mime || "").slice(0, 100),
  };
}

/** Pra cada userId candidato, diz se ele já tem uma call (que ele não
 * recusou) batendo com o horário pedido -- usado tanto pra já marcar
 * como "indisponível" quem a pessoa está escolhendo pra call nova
 * quanto pra revalidar no momento exato de criar (evita corrida: outra
 * pessoa marcou uma call com esse convidado ENQUANTO o formulário
 * estava sendo preenchido). excludeCallId serve pra reconferir uma call
 * já existente sem ela colidir consigo mesma (não usado ainda, mas
 * deixa pronto pra uma futura edição de horário). */
export function getConflictingUserIds(candidateUserIds, startTs, durationMinutes, excludeCallId) {
  const busy = new Set();
  for (const call of Object.values(store.calls)) {
    if (excludeCallId && call.id === excludeCallId) continue;
    // "mostrar compromisso sem travar agenda" -- não conta como ocupado
    // pra ninguém, só aparece na agenda de quem participa (ver
    // blocksAgenda em createCall/enrich).
    if (call.blocksAgenda === false) continue;
    if (!overlaps(startTs, durationMinutes, call.startTs, call.durationMinutes)) continue;
    for (const p of call.participants) {
      if (p.status === "declined") continue;
      if (candidateUserIds.includes(p.id)) busy.add(p.id);
    }
  }
  return Array.from(busy);
}

function enrich(call) {
  const creator = getUser(call.createdBy);
  return {
    id: call.id,
    title: call.title,
    startTs: call.startTs,
    durationMinutes: call.durationMinutes,
    needs: call.needs,
    createdBy: call.createdBy,
    createdByName: creator.name || call.createdByName || "",
    participants: call.participants.map((p) => {
      const u = getUser(p.id);
      return { id: p.id, name: u.name || "", color: u.color || "#5c9bff", status: p.status };
    }),
    createdAt: call.createdAt,
    // "público" (padrão) = quem pesquisar a agenda de um participante
    // dessa call vê o conteúdo (título/necessidades/participantes);
    // "privado" = só ocupa o horário, ver listCallsForColleague embaixo
    // pra quem NÃO é participante, o conteúdo some (vira "redacted").
    visibility: call.visibility === "private" ? "private" : "public",
    redacted: false,
    description: call.description || "",
    attachments: Array.isArray(call.attachments) ? call.attachments : [],
    // "travar agenda" (padrão true) -- ver comentário em
    // getConflictingUserIds. call.blocksAgenda pode não existir em calls
    // criadas antes dessa feature, por isso o "!== false" em vez de só
    // ler o valor direto.
    blocksAgenda: call.blocksAgenda !== false,
  };
}

/** Versão "tarjada" de uma call PRIVADA pra quem tá pesquisando a
 * agenda de um colega e NÃO é participante -- mantém só o horário
 * (pra saber que a pessoa tá ocupada), esconde título/necessidades/
 * quem mais participa. */
function redact(call) {
  return {
    id: call.id,
    title: "",
    startTs: call.startTs,
    durationMinutes: call.durationMinutes,
    needs: { camera: false, audio: false, screen: false },
    createdBy: "",
    createdByName: "",
    participants: [],
    createdAt: call.createdAt,
    visibility: "private",
    redacted: true,
    description: "",
    attachments: [],
    blocksAgenda: true,
  };
}

export function createCall({
  title,
  startTs,
  durationMinutes,
  needs,
  participantIds,
  createdBy,
  visibility,
  description,
  attachments,
  blocksAgenda,
}) {
  const ids = Array.from(new Set([...participantIds.filter((x) => x !== createdBy), createdBy]));
  const call = {
    id: randomUUID(),
    title: String(title || "Call").slice(0, 80),
    startTs: Number(startTs),
    durationMinutes: Math.min(Math.max(Number(durationMinutes) || 30, 5), 480),
    needs: {
      camera: !!needs?.camera,
      audio: !!needs?.audio,
      screen: !!needs?.screen,
    },
    createdBy,
    createdByName: getUser(createdBy).name || "",
    participants: ids.map((id) => ({ id, status: id === createdBy ? "approved" : "pending" })),
    createdAt: Date.now(),
    visibility: visibility === "private" ? "private" : "public",
    description: String(description || "").slice(0, 2000),
    attachments: Array.isArray(attachments) ? attachments.map(sanitizeAttachment).filter(Boolean).slice(0, 20) : [],
    blocksAgenda: blocksAgenda !== false,
  };
  store.calls[call.id] = call;
  persist();
  return enrich(call);
}

/** Anexa um arquivo numa call JÁ CRIADA (visível pra todo mundo que já
 * participa dela) -- diferente dos anexos mandados junto com createCall
 * (esses entram no formulário ANTES de a call existir), esse aqui pendura
 * direto numa call existente. Só um PARTICIPANTE pode anexar; devolve
 * null se a call não existir ou quem pediu não participar dela. */
export function addAttachmentToCall(callId, attachment, requesterUserId) {
  const call = store.calls[callId];
  if (!call) return null;
  if (!call.participants.some((p) => p.id === requesterUserId)) return null;
  const clean = sanitizeAttachment(attachment);
  if (!clean) return null;
  if (!Array.isArray(call.attachments)) call.attachments = [];
  call.attachments.push(clean);
  persist();
  return enrich(call);
}

export function respondToCall(callId, userId, status) {
  const call = store.calls[callId];
  if (!call) return null;
  if (status !== "approved" && status !== "declined") return null;
  const p = call.participants.find((p) => p.id === userId);
  if (!p) return null;
  p.status = status;
  persist();
  return enrich(call);
}

export function getCall(callId) {
  const call = store.calls[callId];
  return call ? enrich(call) : null;
}

/** Todas as calls de um usuário (como criador ou convidado), mais
 * próxima primeiro. */
export function listCallsForUser(userId) {
  return Object.values(store.calls)
    .filter((c) => c.participants.some((p) => p.id === userId))
    .map(enrich)
    .sort((a, b) => a.startTs - b.startTs);
}

/** Agenda de um COLEGA (targetUserId), do ponto de vista de quem tá
 * pesquisando (viewerUserId) -- ver "pesquise a agenda de um colega"
 * no chat. Só entram as calls que o colega não recusou (recusada não
 * ocupa mais o horário dele). Cada call pública (ou em que o próprio
 * viewer também participa -- aí ele já vê o conteúdo de qualquer jeito
 * na PRÓPRIA agenda) vem completa; call privada em que o viewer NÃO
 * participa vem tarjada (ver redact acima), só com o horário, pra dar
 * pra saber que o colega tá ocupado sem expor o conteúdo. */
export function listCallsForColleague(viewerUserId, targetUserId) {
  return Object.values(store.calls)
    .filter((c) => c.participants.some((p) => p.id === targetUserId && p.status !== "declined"))
    .map((c) => {
      const viewerIsParticipant = c.participants.some((p) => p.id === viewerUserId);
      if (c.visibility === "private" && !viewerIsParticipant) return redact(c);
      return enrich(c);
    })
    .sort((a, b) => a.startTs - b.startTs);
}
