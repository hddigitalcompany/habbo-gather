// Persistência do PISO e das ÁREAS da sala (ver "Editar espaço" -> abas
// "Piso"/"Área" em GameRoom.tsx/MainScene.ts) -- mesmo esquema simples de
// chatStore.js/agendaStore.js: um arquivo JSON em disco (data/room.json),
// sem banco de dados de verdade. Antes o editor só gerava um texto pra
// Douglas colar à mão em game/floor.ts (ROOM_FLOOR); agora ele pinta e já
// fica salvo sozinho aqui (ver POST /room/floor e POST /room/areas em
// server/index.js). Área usa o MESMO arquivo/esquema do piso (só mais um
// campo na store), não um arquivo separado -- ver game/areas.ts pro
// formato de cada tile de área (col/row/type).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "room.json");

// limites bem folgados (a sala tem só 12x7 quadrados hoje) -- só pra
// impedir um payload absurdo de travar o servidor ou inchar o arquivo,
// não pra travar o uso normal.
const MAX_FLOOR_ITEMS = 2000;
const MAX_STYLE_ID_LEN = 200;
const MAX_COORD = 1000;

// mesmos limites do piso (ver comentário acima) -- a área usa a MESMA
// grade pequena (12x7), então os limites fazem sentido reaproveitados.
const MAX_AREA_ITEMS = 2000;
const AREA_TYPES = new Set(["mesa-privada", "sala"]);

function emptyStore() {
  return { floor: [], areas: [] };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      floor: Array.isArray(parsed.floor) ? parsed.floor : [],
      areas: Array.isArray(parsed.areas) ? parsed.areas : [],
    };
  } catch (e) {
    console.error("Não deu pra ler data/room.json, começando do zero.", e);
    return emptyStore();
  }
}

const store = loadStore();

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch (e) {
    console.error("Não deu pra salvar data/room.json", e);
  }
}

/** Valida/saneia um item de piso vindo do cliente -- devolve null se o
 * item for inválido (o chamador descarta em vez de salvar lixo). */
function sanitizeFloorItem(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const styleId = String(item.styleId ?? "");
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!styleId || styleId.length > MAX_STYLE_ID_LEN) return null;
  return { col, row, styleId };
}

export function getFloor() {
  return store.floor;
}

/** Substitui o piso inteiro pela lista mandada (o editor sempre manda o
 * estado completo, não um diff -- ver onDraftFloorChange em
 * MainScene.ts). Itens inválidos são descartados silenciosamente em vez
 * de rejeitar a chamada inteira. Devolve a lista realmente salva. */
export function setFloor(items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_FLOOR_ITEMS).map(sanitizeFloorItem).filter(Boolean);
  store.floor = clean;
  persist();
  return clean;
}

/** Valida/saneia um item de área vindo do cliente -- devolve null se o
 * item for inválido (col/row fora da faixa, ou `type` que não é nem
 * "mesa-privada" nem "sala", ver AreaType em game/areas.ts). */
function sanitizeAreaItem(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const type = String(item.type ?? "");
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!AREA_TYPES.has(type)) return null;
  return { col, row, type };
}

export function getAreas() {
  return store.areas;
}

/** Substitui as áreas inteiras pela lista mandada (mesmo esquema do
 * piso -- o editor sempre manda o estado completo, não um diff, ver
 * onDraftAreaChange em MainScene.ts). */
export function setAreas(items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_AREA_ITEMS).map(sanitizeAreaItem).filter(Boolean);
  store.areas = clean;
  persist();
  return clean;
}
