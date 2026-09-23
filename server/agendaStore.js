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
  };
}

export function createCall({ title, startTs, durationMinutes, needs, participantIds, createdBy }) {
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
  };
  store.calls[call.id] = call;
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
