// Persistência do PISO, das ÁREAS e da MOBÍLIA da sala (ver "Editar
// espaço" -> abas "Piso"/"Área"/móvel em GameRoom.tsx/MainScene.ts) --
// mesmo esquema simples de chatStore.js/agendaStore.js: um arquivo JSON
// em disco (data/room.json), sem banco de dados de verdade. Antes o
// editor só gerava um texto pra Douglas colar à mão em game/floor.ts ou
// game/furniture.ts (ROOM_FLOOR/ROOM_FURNITURE); agora ele coloca/pinta
// e já fica salvo sozinho aqui (ver POST /room/floor, /room/areas e
// /room/furniture em server/index.js). Área e móvel usam o MESMO
// arquivo do piso (só mais campos na store), não um arquivo separado --
// ver game/areas.ts pro conceito de área NOMEADA (AreaDef, a lista) +
// tile pintado apontando pra ela por id (AreaTileDef), e game/furniture.ts
// pra FurnitureDef (item colocado) + FurnitureSeatOffsetsMap (ajuste de
// onde o boneco senta, por MODELO+direção -- ver "Assento" no editor,
// não por instância colocada). ROOM_FURNITURE (furniture.ts) continua
// existindo à parte, sempre desenhado -- é mobília "de fábrica" fixa no
// código; a mobília daqui é ADICIONAL, colocada pelo Douglas pela tela,
// sem precisar editar código nenhum.
//
// A POSSE de mesa privada (quem clicou "Assumir mesa", campo
// `areaOwners` abaixo) TAMBÉM persiste aqui, no MESMO arquivo -- pedido
// do Douglas: "quando voce assume a mesa, ela e sua, ate apagarem o
// espaco, se nao nao troca". (Comentário antigo dizia o contrário --
// "NÃO entra aqui, só em memória, não sobrevive a um restart" -- ficou
// desatualizado depois que a persistência foi adicionada; ver
// setAreaOwner/getAreaOwners/removeAreaOwner abaixo e o comentário
// grande de "areaOwners" em emptyStore. `roomAreaOwners` citado ali NÃO
// existe mais em server/index.js, era o Map só-em-memória de ANTES
// dessa migração.) NA PRÁTICA: server/index.js e este arquivo são
// módulos Node carregados uma vez só no processo do servidor -- ao
// contrário do front-end Next.js (que recompila sozinho a cada save),
// uma mudança AQUI só entra em vigor depois de reiniciar o processo
// `node server/index.js` de verdade. Rodar com código velho ainda em
// memória é a explicação mais comum pra "assumi a mesa e depois de
// atualizar a página ela pede pra assumir de novo" -- o claim aconteceu
// de verdade na tela (broadcast confirmado pelo servidor), mas o
// processo rodando não tinha esse persist() ainda, então nunca foi pro
// disco.

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

// parede de sistema (ver game/wall.ts) -- mesma grade pequena do
// piso/área, mesmos limites reaproveitados. MAX_WALL_ITEMS um pouco
// menor que MAX_FLOOR_ITEMS: parede é ARESTA (2 por tile no máximo,
// contando as compartilhadas com o vizinho), não teria como existir
// mais aresta pintada que quadrado de piso na mesma sala.
const MAX_WALL_ITEMS = 2000;
// "center"/"centerRow" são o 3º e 4º modos de parede (pilastra solta no
// MEIO do tile, 2 orientações possíveis -- ver WallSide em
// game/wall.ts) -- "center" faltava aqui antes, mesmo padrão de bug já
// visto com FACINGS de mobília ("coloco mobi, atualizo e some"): parede
// pintada no modo "Centro do tile" passava batido pela tela
// (paintWallAt desenha na hora, sem checar o servidor), mas era
// descartada por sanitizeWallItem no autosave seguinte -- nunca ia pro
// disco, então sumia pra sempre no próximo refresh (Douglas: "e quando
// atualio ela some"). "centerRow" (2ª orientação, pedido posterior:
// "as paredes de centro de tile precisam poder nas duas direcoes")
// entra aqui já de cara, pra não repetir o mesmo bug de novo.
const WALL_SIDES = new Set(["colPlus", "rowPlus", "center", "centerRow"]);

// porta (ver game/door.ts) -- mesma grade/aresta de parede, MAS só as 2
// variantes de fronteira (uma porta sempre separa 2 tiles, nunca faz
// sentido "no centro do tile" -- ver comentário grande de DoorSide em
// game/door.ts). MAX_DOOR_ITEMS bem folgado (não teria como existir mais
// porta que aresta na sala), `facing` é o lado (esq/dir, ver DoorFacing)
// escolhido ANTES de posicionar, guardado junto igual FACINGS de móvel.
const MAX_DOOR_ITEMS = 500;
const DOOR_SIDES = new Set(["colPlus", "rowPlus"]);
const DOOR_FACINGS = new Set(["left", "right"]);

// mesmos limites do piso (ver comentário acima) -- a área usa a MESMA
// grade pequena (12x7), então os limites fazem sentido reaproveitados.
// MAX_AREA_DEFS é generoso mas bem menor que MAX_AREA_TILES -- não devia
// existir centena de ÁREAS distintas (nomes), só potencialmente muitos
// TILES espalhados cobrindo elas.
const MAX_AREA_DEFS = 200;
const MAX_AREA_NAME_LEN = 100;
const MAX_AREA_TILES = 2000;
// pedido do Douglas: "os nomes renomeie, sala privada / Mesa privada /
// sala aberta" -- 3 tipos agora (ver AreaType em game/areas.ts), "sala"
// e "mesa-privada" continuam com o mesmo id de sempre (área antiga
// salva com esse type continua válida), "sala-privada" é o novo.
const AREA_TYPES = new Set(["mesa-privada", "sala-privada", "sala"]);

// mobília colocada pelo editor -- limite mais folgado que piso/área
// porque cada item também carrega id/modelId/colorId (strings), não só
// col/row. MAX_SEAT_MODELS é baixo de propósito: não deveria existir
// centena de MODELOS distintos (ver game/furniture.ts), só
// potencialmente muitos itens COLOCADOS deles (esses não entram aqui,
// ver seatOffsets abaixo -- é por modelo, não por instância).
const MAX_FURNITURE_ITEMS = 1000;
const MAX_ID_LEN = 200;
// "cornerTop"/"cornerBottom" são as 2 quinas de parede (ver FurnitureFacing
// em game/furniture.ts) -- faltavam aqui, então qualquer parede colocada
// virada pra uma quina era rejeitada nesse validador e nunca era
// gravada em disco (ficava só na tela até a próxima atualizada, quando
// sumia pra sempre -- ACHADO/CORRIGIDO: "coloco mobi, atualizo e some").
const FACINGS = new Set(["down", "left", "right", "up", "cornerTop", "cornerBottom"]);
const MAX_SEAT_MODELS = 300;
const MAX_SEAT_OFFSET = 500; // px -- bem mais que qualquer ajuste fino de verdade precisaria

function emptyStore() {
  return {
    floor: [],
    walls: [],
    doors: [],
    areaDefs: [],
    areaTiles: [],
    // posse de mesa privada (quem clicou "Assumir mesa") -- CAMPO NOVO,
    // pedido do Douglas: "quando voce assume a mesa, ela e sua, ate
    // apagarem o espaco, se nao nao troca". Antes vivia só em memória do
    // lado do WebSocket (roomAreaOwners em server/index.js) e caía
    // automaticamente a cada desconexão (F5, wifi, restart do servidor)
    // -- agora persiste igual o resto da sala. { [areaId]: { userId,
    // name } }, guardado pelo userId PERSISTENTE (ver comentário de
    // "identify" em index.js), nunca pelo id de conexão (esse muda a
    // cada reconexão) -- o id de conexão "ao vivo" de quem tá com
    // aquela mesa agora, se estiver online, é recalculado na hora de
    // mandar pro cliente (ver livePlayerIdForUserId em index.js), nunca
    // guardado aqui.
    areaOwners: {},
    furniture: [],
    furnitureSeatOffsets: {},
  };
}

function loadStore() {
  try {
    if (!existsSync(STORE_PATH)) return emptyStore();
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      floor: Array.isArray(parsed.floor) ? parsed.floor : [],
      // "walls" é campo NOVO -- sala salva antes desta feature não tem
      // essa chave no room.json ainda, por isso o fallback pra [] (senão
      // toda sala existente quebraria o GET /room/walls no primeiro
      // load depois do deploy).
      walls: Array.isArray(parsed.walls) ? parsed.walls : [],
      // "doors" é campo NOVO, mesmo motivo/fallback de "walls" acima
      // (sala salva antes desta feature não tem essa chave ainda).
      doors: Array.isArray(parsed.doors) ? parsed.doors : [],
      areaDefs: Array.isArray(parsed.areaDefs) ? parsed.areaDefs : [],
      areaTiles: Array.isArray(parsed.areaTiles) ? parsed.areaTiles : [],
      // "areaOwners" é campo NOVO, mesmo motivo/fallback de "walls"/
      // "doors" acima (sala salva antes desta feature não tem essa
      // chave ainda).
      areaOwners:
        parsed.areaOwners && typeof parsed.areaOwners === "object" && !Array.isArray(parsed.areaOwners)
          ? parsed.areaOwners
          : {},
      furniture: Array.isArray(parsed.furniture) ? parsed.furniture : [],
      furnitureSeatOffsets:
        parsed.furnitureSeatOffsets && typeof parsed.furnitureSeatOffsets === "object"
          ? parsed.furnitureSeatOffsets
          : {},
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

/** Valida/saneia um segmento de parede vindo do cliente -- mesma ideia
 * de sanitizeFloorItem, com `side` a mais (ver WallSide em
 * game/wall.ts, só "colPlus"/"rowPlus" são válidos). */
function sanitizeWallItem(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const side = String(item.side ?? "");
  const styleId = String(item.styleId ?? "");
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!WALL_SIDES.has(side)) return null;
  if (!styleId || styleId.length > MAX_STYLE_ID_LEN) return null;
  return { col, row, side, styleId };
}

export function getWalls() {
  return store.walls;
}

/** Substitui a parede inteira pela lista mandada -- mesma ideia de
 * setFloor acima (sempre o estado completo, não um diff). */
export function setWalls(items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_WALL_ITEMS).map(sanitizeWallItem).filter(Boolean);
  store.walls = clean;
  persist();
  return clean;
}

/** Valida/saneia um segmento de porta vindo do cliente -- mesma ideia de
 * sanitizeWallItem, com `facing` a mais (ver DoorFacing em
 * game/door.ts) e `side` restrito às 2 variantes de fronteira (ver
 * DOOR_SIDES acima). */
function sanitizeDoorItem(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const side = String(item.side ?? "");
  const styleId = String(item.styleId ?? "");
  const facing = String(item.facing ?? "");
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!DOOR_SIDES.has(side)) return null;
  if (!styleId || styleId.length > MAX_STYLE_ID_LEN) return null;
  if (!DOOR_FACINGS.has(facing)) return null;
  return { col, row, side, styleId, facing };
}

export function getDoors() {
  return store.doors;
}

/** Substitui a porta inteira pela lista mandada -- mesma ideia de
 * setWalls acima (sempre o estado completo, não um diff). */
export function setDoors(items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_DOOR_ITEMS).map(sanitizeDoorItem).filter(Boolean);
  store.doors = clean;
  persist();
  return clean;
}

/** Valida/saneia uma área da LISTA (nome + tipo, ver AreaDef em
 * game/areas.ts) -- devolve null se o item for inválido (sem nome, nome
 * grande demais, ou `type` que não é um dos 3 de AREA_TYPES acima). */
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
  // uma área apagada (id que não existe mais na lista nova) leva a posse
  // dela junto -- pedido do Douglas: "ela e sua, ate apagarem o espaco"
  // (só ENTÃO troca) -- sem isso, apagar/recriar uma mesa com o MESMO id
  // reapareceria com o dono antigo "de graça".
  for (const areaId of Object.keys(store.areaOwners)) {
    if (!validIds.has(areaId)) delete store.areaOwners[areaId];
  }
  persist();
  return { list, tiles };
}

/** Posse de mesa privada persistida -- { [areaId]: { userId, name } },
 * ver comentário grande de "areaOwners" em emptyStore acima. Devolve o
 * objeto de verdade (não cópia) -- só server/index.js lê isso, sempre
 * síncrono, sem risco de mutação concorrente (Node é single-thread). */
export function getAreaOwners() {
  return store.areaOwners;
}

/** Registra a posse de UMA área (ver "claim-area" em server/index.js) --
 * `userId` é o id PERSISTENTE de quem clicou (nunca o id de conexão),
 * `name` é só pra mostrar no rótulo "mesa de <nome>" sem precisar achar
 * o jogador de novo depois (ver comentário grande de areaOwners acima).
 * Sobrescreve sem confirmar nada -- quem chama (claim-area) já confere
 * que a área tá livre antes. */
export function setAreaOwner(areaId, userId, name) {
  const cleanAreaId = String(areaId ?? "").slice(0, MAX_AREA_NAME_LEN);
  const cleanUserId = String(userId ?? "").slice(0, MAX_ID_LEN);
  const cleanName = String(name ?? "").slice(0, MAX_AREA_NAME_LEN);
  if (!cleanAreaId || !cleanUserId || !cleanName) return null;
  const entry = { userId: cleanUserId, name: cleanName };
  store.areaOwners[cleanAreaId] = entry;
  persist();
  return entry;
}

/** Solta a posse de UMA área (ver "release-area"/"force-release-area" em
 * server/index.js) -- não confirma dono nenhum, quem chama já conferiu. */
export function removeAreaOwner(areaId) {
  const cleanAreaId = String(areaId ?? "").slice(0, MAX_AREA_NAME_LEN);
  if (!cleanAreaId || !(cleanAreaId in store.areaOwners)) return false;
  delete store.areaOwners[cleanAreaId];
  persist();
  return true;
}

/** Valida/saneia UM item de mobília colocado (ver FurnitureDef em
 * game/furniture.ts) -- devolve null se o item for inválido. Não confere
 * aqui se type/modelId/colorId batem com algum catálogo de verdade (o
 * servidor não conhece o catálogo gerado, ver comentário grande no topo
 * do arquivo) -- só limita tamanho/formato genérico, igual sanitizeFloorItem
 * faz com styleId; um id de modelo/cor que não existe mais (pasta de
 * origem renomeada/apagada) só faz o item cair num fallback visual do
 * lado do cliente (ver resolveFurnitureArt em game/furniture.ts), não
 * quebra nada aqui. */
function sanitizeFurnitureItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? "").slice(0, MAX_ID_LEN);
  const type = String(item.type ?? "").slice(0, MAX_ID_LEN);
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const facing = String(item.facing ?? "");
  if (!id || !type) return null;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!FACINGS.has(facing)) return null;
  const out = { id, type, col, row, facing };
  if (item.modelId != null) {
    const modelId = String(item.modelId).slice(0, MAX_ID_LEN);
    if (modelId) out.modelId = modelId;
  }
  if (item.colorId != null) {
    const colorId = String(item.colorId).slice(0, MAX_ID_LEN);
    if (colorId) out.colorId = colorId;
  }
  return out;
}

/** Valida/saneia o MAPA de ajuste de assento (ver FurnitureSeatOffsetsMap
 * em game/furniture.ts) -- { grupo (modelId ou "classic"): { direção:
 * {x,y} } }. Um grupo/direção com formato errado é descartado (não
 * derruba o mapa inteiro). */
function sanitizeSeatOffsets(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  const groupKeys = Object.keys(raw).slice(0, MAX_SEAT_MODELS);
  for (const groupKey of groupKeys) {
    const key = String(groupKey).slice(0, MAX_ID_LEN);
    if (!key) continue;
    const byFacing = raw[groupKey];
    if (!byFacing || typeof byFacing !== "object") continue;
    const cleanByFacing = {};
    for (const facing of Object.keys(byFacing)) {
      if (!FACINGS.has(facing)) continue;
      const point = byFacing[facing];
      if (!point || typeof point !== "object") continue;
      const x = Math.trunc(Number(point.x));
      const y = Math.trunc(Number(point.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (Math.abs(x) > MAX_SEAT_OFFSET || Math.abs(y) > MAX_SEAT_OFFSET) continue;
      cleanByFacing[facing] = { x, y };
    }
    if (Object.keys(cleanByFacing).length > 0) out[key] = cleanByFacing;
  }
  return out;
}

export function getFurnitureState() {
  return { items: store.furniture, seatOffsets: store.furnitureSeatOffsets };
}

/** Substitui a mobília colocada E o mapa de ajuste de assento de uma vez
 * só (mesmo esquema combinado de setAreaState acima -- o editor sempre
 * manda os dois juntos, ver autosave em GameRoom.tsx). Devolve null se
 * `items`/`seatOffsets` não vierem no formato esperado. */
export function setFurnitureState(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.items)) return null;
  const items = payload.items.slice(0, MAX_FURNITURE_ITEMS).map(sanitizeFurnitureItem).filter(Boolean);
  const seatOffsets = sanitizeSeatOffsets(payload.seatOffsets);
  store.furniture = items;
  store.furnitureSeatOffsets = seatOffsets;
  persist();
  return { items, seatOffsets };
}
