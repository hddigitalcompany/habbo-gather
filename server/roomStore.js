// Persistência do PISO e das ÁREAS da sala (ver "Editar espaço" -> abas
// "Piso"/"Área" em GameRoom.tsx/MainScene.ts) -- mesmo esquema simples de
// chatStore.js/agendaStore.js: um arquivo JSON em disco (data/room.json),
// sem banco de dados de verdade. Antes o editor só gerava um texto pra
// Douglas colar à mão em game/floor.ts (ROOM_FLOOR); agora ele pinta e já
// fica salvo sozinho aqui (ver POST /room/floor e POST /room/areas em
// server/index.js). Área usa o MESMO arquivo do piso (só mais dois
// campos na store), não um arquivo separado -- ver game/areas.ts pro
// conceito de área NOMEADA (AreaDef, a lista) + tile pintado apontando
// pra ela por id (AreaTileDef). A POSSE de mesa privada (quem clicou
// "Tomar posse") NÃO entra aqui -- é estado só em memória, do lado do
// WebSocket (ver roomAreaOwners em server/index.js), não sobrevive a um
// restart do servidor (mesmo motivo do activeCalls de chat: ninguém
// fica "conectado" depois que o processo cai, então não faz sentido
// persistir quem tava sentado onde).

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
// MAX_AREA_DEFS é generoso mas bem menor que MAX_AREA_TILES -- não devia
// existir centena de ÁREAS distintas (nomes), só potencialmente muitos
// TILES espalhados cobrindo elas.
const MAX_AREA_DEFS = 200;
const MAX_AREA_NAME_LEN = 100;
const MAX_AREA_TILES = 2000;
const AREA_TYPES = new Set(["mesa-privada", "sala"]);

function emptyStore() {
  return { floor: [], areaDefs: [], areaTiles: [] };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      floor: Array.isArray(parsed.floor) ? parsed.floor : [],
      areaDefs: Array.isArray(parsed.areaDefs) ? parsed.areaDefs : [],
      areaTiles: Array.isArray(parsed.areaTiles) ? parsed.areaTiles : [],
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

/** Valida/saneia uma área da LISTA (nome + tipo, ver AreaDef em
 * game/areas.ts) -- devolve null se o item for inválido (sem nome, nome
 * grande demais, ou `type` que não é nem "mesa-privada" nem "sala"). */
function sanitizeAreaDef(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? "").slice(0, MAX_AREA_NAME_LEN);
  const name = String(item.name ?? "").trim().slice(0, MAX_AREA_NAME_LEN);
  const type = String(item.type ?? "");
  if (!id || !name) return null;
  if (!AREA_TYPES.has(type)) return null;
  return { id, name, type };
}

/** Valida/saneia um tile de área vindo do cliente -- devolve null se o
 * item for inválido (col/row fora da faixa, ou sem `areaId`, ver
 * AreaTileDef em game/areas.ts). Não confere aqui se `areaId` bate com
 * alguma área da lista -- isso é feito em setAreaState, que já tem as
 * duas listas em mãos (descarta tile "órfão" depois de limpar as duas). */
function sanitizeAreaTile(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const areaId = String(item.areaId ?? "").slice(0, MAX_AREA_NAME_LEN);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!areaId) return null;
  return { col, row, areaId };
}

export function getAreaState() {
  return { list: store.areaDefs, tiles: store.areaTiles };
}

/** Substitui a lista de áreas E os tiles pintados de uma vez só (o
 * editor sempre manda o estado completo dos dois juntos, não um diff --
 * ver autosave combinado em GameRoom.tsx). Um tile cujo `areaId` não
 * bate com NENHUMA área da lista mandada é descartado (pode acontecer
 * se o cliente apagou a área mas ainda tinha um tile dela em rascunho) --
 * devolve null se `list`/`tiles` não vierem como array. */
export function setAreaState(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.list) || !Array.isArray(payload.tiles)) return null;
  const list = payload.list.slice(0, MAX_AREA_DEFS).map(sanitizeAreaDef).filter(Boolean);
  const rawTiles = payload.tiles.slice(0, MAX_AREA_TILES).map(sanitizeAreaTile).filter(Boolean);
  const validIds = new Set(list.map((a) => a.id));
  const tiles = rawTiles.filter((t) => validIds.has(t.areaId));
  store.areaDefs = list;
  store.areaTiles = tiles;
  persist();
  return { list, tiles };
}
