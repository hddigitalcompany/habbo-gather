// Persistência do PISO, das ÁREAS e da MOBÍLIA da sala (ver "Editar
// espaço" -> abas "Piso"/"Área"/móvel em GameRoom.tsx/MainScene.ts) --
// ANTES vivia num arquivo JSON no disco local do servidor
// (data/room.json); MUDOU pro Supabase (tabela public.room_layout_state,
// ver supabase/migrations/0034_room_layout_state.sql) em 28/set depois
// de achar na prática que disco local não serve pra isso: criar um
// serviço novo no Render (ex: montar o ambiente de staging) nasce SEM
// esse arquivo, e mesmo em produção o disco não é garantidamente
// persistente entre deploys no Render free tier -- Douglas viu a sala
// nascer vazia no staging e teve que decorar tudo de novo. Continua
// sendo um blob JSON simples (mesmo formato de sempre: floor, walls,
// doors, areaDefs, areaTiles, areaOwners, furniture,
// furnitureSeatOffsets), só troca ONDE mora -- não virou um schema
// relacional de verdade de propósito (menor risco, migração
// praticamente igual ao formato antigo).
//
// MULTI-SALA (29/set, pedido do Douglas: "Mapa de teste (depois) / Mapa
// publicada (essa) / Mapa modelo (ja pode criar um, mesmo que sem
// decoracao, so pra gente estruturar como vai ser pros clientes)") --
// esse arquivo ERA um singleton de verdade: uma `store` só, um
// `ROOM_SLUG` fixo ("mapa-publicado"), carregada uma vez com top-level
// await no boot do processo. Virou um Map<roomSlug, store> (ver
// `ensureStore` abaixo) -- cada sala (hoje: "mapa-publicado" = Mapa
// Publicada, "mapa-modelo" = Mapa Modelo) tem seu PRÓPRIO blob,
// carregado sob demanda (na primeira vez que alguém pede aquele slug) e
// cacheado em memória depois disso, mesma ideia de bootStore de sempre,
// só que agora parametrizada por slug em vez de uma constante. A sala
// padrão ("mapa-publicado") continua pré-aquecida no boot do módulo
// (ver `await ensureStore(DEFAULT_ROOM_SLUG)` lá embaixo) pra não mudar
// a latência de hoje em nada -- só uma sala NOVA (tipo "mapa-modelo")
// paga o custo de um boot (1 leitura no Supabase) na primeira vez que
// alguém entra nela.
//
// Por causa disso, getRoomShape/getFloor/getWalls/getDoors/
// getAreaState/getAreaOwners/getFurnitureState e todos os setters
// PARARAM de ser síncronos (liam de um cache em memória carregado uma
// vez no boot) -- agora recebem `roomSlug` como PRIMEIRO argumento e
// devolvem Promise (await `ensureStore(roomSlug)` antes de ler/mudar
// qualquer coisa). Todo call site em server/index.js precisou virar
// `await roomStore.get/setAlgumaCoisa(roomSlug, ...)` -- ver
// comentários lá.
//
// Ainda NÃO é multi-tenant de verdade (Task #63 maior, ainda pendente):
// continua chaveado por um SLUG texto (hoje só "mapa-publicado" e
// "mapa-modelo" existem, mesmo valor que o cliente manda no PartySocket
// e nas chamadas REST /room/*), não por public.rooms.id/dono/permissão
// nenhuma -- qualquer slug que alguém mandar cria uma sala nova vazia
// na hora (comportamento igual a "mapa-publicado" antes dessa mudança:
// sempre existiu, nunca pediu permissão pra existir). Isso é de
// propósito nessa passada: o pedido do Douglas foi "so pra gente
// estruturar como vai ser pros clientes", não ownership/RLS/catálogo de
// sala ainda (isso fica pra quando o `public.rooms` -- migration 0032,
// ainda sem nenhum código lendo ela -- entrar em uso de verdade).
//
// Se SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não estiverem configurados
// nesse processo (mesmo esquema de fallback de server/roomAuth.js),
// cai pro arquivo local de sempre (data/room.json pra "mapa-publicado",
// data/room.<slug>.json pra qualquer outro slug) em vez de travar --
// só afeta ambiente sem Supabase configurado (não devia acontecer em
// produção/staging, os dois já têm essas variáveis, ver README).
//
// Antes o editor só gerava um texto pra Douglas colar à mão em
// game/floor.ts ou game/furniture.ts (ROOM_FLOOR/ROOM_FURNITURE); agora
// ele coloca/pinta e já fica salvo sozinho aqui (ver POST /room/floor,
// /room/areas e /room/furniture em server/index.js). Área e móvel usam
// o MESMO registro do piso (só mais campos na store), não um separado --
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
// `areaOwners` abaixo) TAMBÉM persiste aqui, no MESMO registro -- pedido
// do Douglas: "quando voce assume a mesa, ela e sua, ate apagarem o
// espaco, se nao nao troca" -- ver setAreaOwner/getAreaOwners/
// removeAreaOwner abaixo.
//
// persist() (que grava no Supabase/disco) continua best-effort, chamada
// sem await pelos setters (mesmo comportamento de antes: a escrita não
// era esperada por quem chamava) -- só a LEITURA (ensureStore) que
// virou algo que todo call site precisa esperar agora, porque antes de
// esperar ela simplesmente não existia como conceito (só rodava uma vez
// no boot do processo inteiro).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

export const DEFAULT_ROOM_SLUG = "mapa-publicado";
// slug só pode ter letras/números/hífen (mesma ideia de um "handle" --
// vem de query string em requests REST, ver roomSlugFromUrl em
// server/index.js, então precisa ser seguro pra virar nome de arquivo
// em disco -- ver storePathFor abaixo -- e pra ir numa cláusula
// .eq(...) do Supabase). Qualquer slug fora desse formato (ou vazio)
// cai pro padrão -- nunca trava a chamada, só ignora um slug malformado
// e usa "mapa-publicado" no lugar dele.
const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;

function normalizeSlug(roomSlug) {
  const slug = typeof roomSlug === "string" ? roomSlug.trim() : "";
  return slug && SLUG_PATTERN.test(slug) ? slug : DEFAULT_ROOM_SLUG;
}

/** Caminho do arquivo local pra um slug -- a sala padrão continua
 * usando EXATAMENTE data/room.json (mesmo nome de sempre, sem migração
 * nenhuma pra quem já tinha esse arquivo); qualquer sala nova (ex:
 * "mapa-modelo") ganha o próprio arquivo (data/room.<slug>.json), pra
 * não colidir com a padrão. */
function storePathFor(roomSlug) {
  if (roomSlug === DEFAULT_ROOM_SLUG) return path.join(DATA_DIR, "room.json");
  return path.join(DATA_DIR, `room.${roomSlug}.json`);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

// limites bem folgados (a sala tem só 12x7 quadrados hoje) -- só pra
// impedir um payload absurdo de travar o servidor ou inchar o arquivo,
// não pra travar o uso normal.
const MAX_FLOOR_ITEMS = 2000;
const MAX_STYLE_ID_LEN = 200;
const MAX_COORD = 1000;

// FORMATO da sala (ver roomShape/isTileInRoom em game/MainScene.ts) --
// pedido do Douglas: "eu quero adicionar mais piso alem do limite que
// ja tem da sala, quero aumentar a sala", confirmado como "formato
// livre, tile por tile" (não esticar um retângulo -- uma tentativa
// ANTERIOR desse pedido tratava assim, descartada). DEFAULT_GRID_COLS/
// DEFAULT_GRID_ROWS só geram o retângulo PADRÃO (13x8, mesmo tamanho
// de sempre) quando a sala ainda não tem roomTiles salvo (ver
// normalizeStore abaixo) -- não limitam mais o tamanho de verdade em
// lugar nenhum, isso agora é só quantos tiles cabem em MAX_ROOM_TILES.
const DEFAULT_GRID_COLS = 12;
const DEFAULT_GRID_ROWS = 7;
// generoso (bem mais que o retângulo padrão, 13x8=104), só pra impedir
// um formato absurdo de travar o servidor ou inchar o arquivo -- mesmo
// espírito de MAX_FLOOR_ITEMS acima, não pra travar o uso normal.
const MAX_ROOM_TILES = 2000;

function defaultRoomTiles() {
  const tiles = [];
  for (let col = 0; col <= DEFAULT_GRID_COLS; col++) {
    for (let row = 0; row <= DEFAULT_GRID_ROWS; row++) {
      tiles.push({ col, row });
    }
  }
  return tiles;
}

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

// LED de parede (ver LedSegmentDef em game/wall.ts) -- pedido do
// Douglas: "efeito de led... led de parede", fita colorida numa EMENDA
// entre 2 painéis de parede do mesmo estilo. Mora na MESMA grade de
// aresta que parede, com `end` a mais (A/B, qual ponta da aresta é a
// emenda) e `color` (hex #rrggbb escolhido no editor, ver
// ColorPickerField). MAX_LED_ITEMS folgado igual MAX_WALL_ITEMS (no
// máximo 2 LEDs por aresta -- um em cada ponta -- então nunca passaria
// o dobro de paredes na mesma sala).
const MAX_LED_ITEMS = 2000;
const LED_ENDS = new Set(["A", "B"]);
const LED_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

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
    // FORMATO da sala (ver comentário grande acima) -- CAMPO NOVO,
    // pedido do Douglas. Default é o retângulo de sempre (13x8), pra
    // sala já salva ANTES dessa feature (sem esse campo) continuar
    // exatamente do mesmo tamanho/formato de sempre -- ver
    // normalizeStore abaixo.
    roomTiles: defaultRoomTiles(),
    floor: [],
    walls: [],
    // LED de parede (ver sanitizeLedItem/getLeds/setLeds abaixo) --
    // CAMPO NOVO, mesmo espírito de roomTiles acima: sala salva ANTES
    // dessa feature (sem esse campo) simplesmente não tinha LED nenhum
    // ainda, [] é o valor certo pra ela (ver normalizeStore abaixo).
    leds: [],
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

/** Valida/saneia a lista de tiles do FORMATO da sala -- devolve []
 * quando `raw` não é uma lista usável (normalizeStore cai pro
 * retângulo padrão nesse caso, ver defaultRoomTiles acima) ou uma
 * lista limpa (col/row inteiros dentro de MAX_COORD, sem duplicata,
 * capada em MAX_ROOM_TILES) quando é. Mesma ideia de
 * sanitizeFloorItem/sanitizeWallItem mais abaixo, só que o "item" aqui
 * é só {col,row}, sem campo nenhum além desses dois. */
function sanitizeRoomTiles(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const clean = [];
  for (const item of raw) {
    if (clean.length >= MAX_ROOM_TILES) break;
    if (!item || typeof item !== "object") continue;
    const col = Math.trunc(Number(item.col));
    const row = Math.trunc(Number(item.row));
    if (!Number.isFinite(col) || !Number.isFinite(row)) continue;
    if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) continue;
    const key = `${col},${row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ col, row });
  }
  return clean;
}

/** Normaliza um blob cru (vindo do arquivo local OU do Supabase) pro
 * formato de sempre -- mesmos fallbacks de campo "novo" que faltava em
 * sala salva antes de alguma feature (walls/doors/areaOwners), agora
 * reaproveitado nos dois carregadores abaixo em vez de duplicado. */
function normalizeStore(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyStore();
  const roomTiles = sanitizeRoomTiles(parsed.roomTiles);
  return {
    roomTiles: roomTiles.length > 0 ? roomTiles : defaultRoomTiles(),
    floor: Array.isArray(parsed.floor) ? parsed.floor : [],
    walls: Array.isArray(parsed.walls) ? parsed.walls : [],
    leds: Array.isArray(parsed.leds) ? parsed.leds : [],
    doors: Array.isArray(parsed.doors) ? parsed.doors : [],
    areaDefs: Array.isArray(parsed.areaDefs) ? parsed.areaDefs : [],
    areaTiles: Array.isArray(parsed.areaTiles) ? parsed.areaTiles : [],
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
}

/** Fallback de sempre (arquivo local) -- usado quando o Supabase não tá
 * configurado nesse processo, ou se a leitura no Supabase falhar. */
function loadStoreFromFile(roomSlug) {
  const storePath = storePathFor(roomSlug);
  try {
    if (!existsSync(storePath)) return emptyStore();
    const raw = readFileSync(storePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (e) {
    console.error(`Não deu pra ler ${storePath}, começando do zero.`, e);
    return emptyStore();
  }
}

function persistToFile(roomSlug, snapshot) {
  const storePath = storePathFor(roomSlug);
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(storePath, JSON.stringify(snapshot), "utf8");
  } catch (e) {
    console.error(`Não deu pra salvar ${storePath}`, e);
  }
}

/** Carrega o estado inicial de UMA sala (roomSlug) -- Supabase quando
 * configurado (tabela room_layout_state, ver migration 0034), senão cai
 * pro arquivo local de sempre. Se o Supabase estiver configurado mas
 * AINDA não tiver linha pra esse slug (primeiro boot desse slug depois
 * desse deploy, ou sala nova tipo "mapa-modelo" entrando pela primeira
 * vez), e existir um arquivo local pra esse mesmo slug (sala decorada
 * antes dessa migração, ainda no disco DESSE boot), usa ele como ponto
 * de partida e já sobe pro Supabase na hora -- migração automática, sem
 * passo manual, só funciona nesse primeiro boot daquele slug (disco
 * local não sobrevive a um serviço recriado do zero, por isso a pressa
 * em subir assim que possível). Sem arquivo nenhum (caso normal de uma
 * sala nova, tipo "mapa-modelo" na primeira vez), começa de emptyStore()
 * mesmo -- é assim que uma sala nasce vazia. */
async function bootStore(roomSlug) {
  if (!admin) return loadStoreFromFile(roomSlug);
  try {
    const { data, error } = await admin
      .from("room_layout_state")
      .select("data")
      .eq("room_slug", roomSlug)
      .maybeSingle();
    if (error) throw error;
    if (data?.data) return normalizeStore(data.data);
    // sem linha ainda no Supabase -- tenta herdar do arquivo local
    // desse boot (pode não existir, tudo bem, emptyStore() nesse caso).
    const fromFile = loadStoreFromFile(roomSlug);
    await admin
      .from("room_layout_state")
      .upsert({ room_slug: roomSlug, data: fromFile, updated_at: new Date().toISOString() });
    return fromFile;
  } catch (e) {
    console.error(`Não deu pra carregar a sala "${roomSlug}" do Supabase, caindo pro arquivo local.`, e);
    return loadStoreFromFile(roomSlug);
  }
}

// Map<roomSlug, store> -- cache em memória de cada sala já carregada
// (ver comentário grande "MULTI-SALA" no topo do arquivo). Map<roomSlug,
// Promise<store>> separado pro boot em andamento -- evita 2 boots
// concorrentes da MESMA sala nova se 2 requests chegarem juntos antes do
// primeiro terminar (ex: GET /room/shape?room=mapa-modelo e GET
// /room/floor?room=mapa-modelo quase juntos, ver GameRoom.tsx que
// dispara várias chamadas em paralelo ao entrar numa sala).
const storeCache = new Map();
const bootingCache = new Map();

/** Devolve (e cacheia) a store de UM slug -- todo getter/setter abaixo
 * começa chamando isso. Primeira vez que um slug aparece: dispara
 * bootStore(slug) (1 leitura no Supabase/disco) e cacheia a Promise pra
 * quem pedir de novo enquanto isso ainda tá em andamento reaproveitar a
 * MESMA leitura em vez de disparar outra; depois de resolvida, guarda o
 * objeto de verdade em storeCache e todo pedido seguinte é síncrono na
 * prática (Promise.resolve de um valor já em mãos). */
function ensureStore(roomSlug) {
  const slug = normalizeSlug(roomSlug);
  if (storeCache.has(slug)) return Promise.resolve(storeCache.get(slug));
  if (bootingCache.has(slug)) return bootingCache.get(slug);
  const booting = bootStore(slug).then((store) => {
    storeCache.set(slug, store);
    bootingCache.delete(slug);
    return store;
  });
  bootingCache.set(slug, booting);
  return booting;
}

// pré-aquece a sala padrão ("mapa-publicado" = Mapa Publicada) no boot
// do módulo -- preserva EXATAMENTE a latência de hoje pra ela (já
// carregada em memória antes do primeiro request chegar, mesmo
// comportamento do antigo `const store = await bootStore()`). Só uma
// sala NOVA (ex: "mapa-modelo") paga o custo de esperar 1 leitura na
// primeira vez que alguém entra nela -- ver ensureStore acima.
await ensureStore(DEFAULT_ROOM_SLUG);

/** Grava o estado atual de UM slug -- Supabase quando configurado,
 * senão o arquivo local de sempre. Best-effort/assíncrono (mesmo
 * contrato de antes: quem chama não espera a escrita terminar) -- erro
 * só vai pro log, nunca derruba a chamada que gerou a mudança (o dado já
 * está certo em memória, é só a gravação que pode falhar). */
async function persist(roomSlug, store) {
  if (!admin) {
    persistToFile(roomSlug, store);
    return;
  }
  try {
    const { error } = await admin
      .from("room_layout_state")
      .upsert({ room_slug: roomSlug, data: store, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (e) {
    console.error(`Não deu pra salvar a sala "${roomSlug}" no Supabase.`, e);
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

/** Formato salvo da sala (ver comentário grande de roomTiles acima) --
 * devolvido pra popular a cena assim que ela fica pronta (ver GET
 * /room/shape em server/index.js, aplicado via MainScene.loadSavedRoomShape
 * chamado de GameRoom.tsx), mesma ideia de getFloor/getWalls/etc. */
export async function getRoomShape(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.roomTiles;
}

/** Muda o formato da sala -- pedido do Douglas: "eu quero adicionar
 * mais piso alem do limite que ja tem da sala, quero aumentar a sala"
 * (formato livre, tile por tile, ver aba "Tamanho" no editor de
 * espaço). O cliente (MainScene.paintRoomShapeAt/eraseRoomShapeAt) já
 * garante que a sala nunca fica vazia/desconectada ANTES de mandar pra
 * cá -- aqui só saneia formato/tamanho de payload (mesma cautela de
 * setFloor/setWalls/etc.), sem reconferir conectividade (confiar no
 * cliente aqui é seguro: o pior que um payload malformado faz é uma
 * sala com formato estranho, nunca dado de outra sala/usuário). Devolve
 * null só se a lista sanear pra vazia (nunca aceita esvaziar a sala de
 * verdade). */
export async function setRoomShape(roomSlug, items) {
  const clean = sanitizeRoomTiles(items);
  if (clean.length === 0) return null;
  const store = await ensureStore(roomSlug);
  store.roomTiles = clean;
  persist(normalizeSlug(roomSlug), store);
  return clean;
}

export async function getFloor(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.floor;
}

/** Substitui o piso inteiro pela lista mandada (o editor sempre manda o
 * estado completo, não um diff -- ver onDraftFloorChange em
 * MainScene.ts). Itens inválidos são descartados silenciosamente em vez
 * de rejeitar a chamada inteira. Devolve a lista realmente salva. */
export async function setFloor(roomSlug, items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_FLOOR_ITEMS).map(sanitizeFloorItem).filter(Boolean);
  const store = await ensureStore(roomSlug);
  store.floor = clean;
  persist(normalizeSlug(roomSlug), store);
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

export async function getWalls(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.walls;
}

/** Substitui a parede inteira pela lista mandada -- mesma ideia de
 * setFloor acima (sempre o estado completo, não um diff). */
export async function setWalls(roomSlug, items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_WALL_ITEMS).map(sanitizeWallItem).filter(Boolean);
  const store = await ensureStore(roomSlug);
  store.walls = clean;
  persist(normalizeSlug(roomSlug), store);
  return clean;
}

/** Valida/saneia um LED vindo do cliente -- mesma ideia de
 * sanitizeWallItem, com `end` (A/B, ver LED_ENDS) no lugar de styleId e
 * `color` (hex #rrggbb, ver LED_COLOR_RE) a mais. Não confere se a
 * ponta é mesmo uma emenda "straight" de verdade (isso é geometria do
 * CLIENTE, ver wallJunctionAt em MainScene.ts, que já só deixa colocar
 * numa emenda válida) -- aqui só garante que o FORMATO do dado é são;
 * um LED "órfão" (emenda que deixou de existir porque um dos 2
 * segmentos foi apagado) simplesmente não é desenhado no próximo load
 * (ver ledJunctionPoint em MainScene.ts), sem precisar o servidor saber
 * de parede nenhuma. */
function sanitizeLedItem(item) {
  if (!item || typeof item !== "object") return null;
  const col = Math.trunc(Number(item.col));
  const row = Math.trunc(Number(item.row));
  const side = String(item.side ?? "");
  const end = String(item.end ?? "");
  const color = String(item.color ?? "");
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (Math.abs(col) > MAX_COORD || Math.abs(row) > MAX_COORD) return null;
  if (!WALL_SIDES.has(side)) return null;
  if (!LED_ENDS.has(end)) return null;
  if (!LED_COLOR_RE.test(color)) return null;
  return { col, row, side, end, color };
}

export async function getLeds(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.leds;
}

/** Substitui os LEDs inteiros pela lista mandada -- mesma ideia de
 * setWalls acima (sempre o estado completo, não um diff). */
export async function setLeds(roomSlug, items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_LED_ITEMS).map(sanitizeLedItem).filter(Boolean);
  const store = await ensureStore(roomSlug);
  store.leds = clean;
  persist(normalizeSlug(roomSlug), store);
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

export async function getDoors(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.doors;
}

/** Substitui a porta inteira pela lista mandada -- mesma ideia de
 * setWalls acima (sempre o estado completo, não um diff). */
export async function setDoors(roomSlug, items) {
  if (!Array.isArray(items)) return null;
  const clean = items.slice(0, MAX_DOOR_ITEMS).map(sanitizeDoorItem).filter(Boolean);
  const store = await ensureStore(roomSlug);
  store.doors = clean;
  persist(normalizeSlug(roomSlug), store);
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

export async function getAreaState(roomSlug) {
  const store = await ensureStore(roomSlug);
  return { list: store.areaDefs, tiles: store.areaTiles };
}

/** Substitui a lista de áreas E os tiles pintados de uma vez só (o
 * editor sempre manda o estado completo dos dois juntos, não um diff --
 * ver autosave combinado em GameRoom.tsx). Um tile cujo `areaId` não
 * bate com NENHUMA área da lista mandada é descartado (pode acontecer
 * se o cliente apagou a área mas ainda tinha um tile dela em rascunho) --
 * devolve null se `list`/`tiles` não vierem como array. */
export async function setAreaState(roomSlug, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.list) || !Array.isArray(payload.tiles)) return null;
  const list = payload.list.slice(0, MAX_AREA_DEFS).map(sanitizeAreaDef).filter(Boolean);
  const rawTiles = payload.tiles.slice(0, MAX_AREA_TILES).map(sanitizeAreaTile).filter(Boolean);
  const validIds = new Set(list.map((a) => a.id));
  const tiles = rawTiles.filter((t) => validIds.has(t.areaId));
  const store = await ensureStore(roomSlug);
  store.areaDefs = list;
  store.areaTiles = tiles;
  // uma área apagada (id que não existe mais na lista nova) leva a posse
  // dela junto -- pedido do Douglas: "ela e sua, ate apagarem o espaco"
  // (só ENTÃO troca) -- sem isso, apagar/recriar uma mesa com o MESMO id
  // reapareceria com o dono antigo "de graça".
  for (const areaId of Object.keys(store.areaOwners)) {
    if (!validIds.has(areaId)) delete store.areaOwners[areaId];
  }
  persist(normalizeSlug(roomSlug), store);
  return { list, tiles };
}

/** Posse de mesa privada persistida -- { [areaId]: { userId, name } },
 * ver comentário grande de "areaOwners" em emptyStore acima. Devolve o
 * objeto de verdade (não cópia) -- só server/index.js lê isso, sempre
 * dentro do mesmo processo Node (single-thread), sem risco de mutação
 * concorrente. */
export async function getAreaOwners(roomSlug) {
  const store = await ensureStore(roomSlug);
  return store.areaOwners;
}

/** Registra a posse de UMA área (ver "claim-area" em server/index.js) --
 * `userId` é o id PERSISTENTE de quem clicou (nunca o id de conexão),
 * `name` é só pra mostrar no rótulo "mesa de <nome>" sem precisar achar
 * o jogador de novo depois (ver comentário grande de areaOwners acima).
 * Sobrescreve sem confirmar nada -- quem chama (claim-area) já confere
 * que a área tá livre antes. */
export async function setAreaOwner(roomSlug, areaId, userId, name) {
  const cleanAreaId = String(areaId ?? "").slice(0, MAX_AREA_NAME_LEN);
  const cleanUserId = String(userId ?? "").slice(0, MAX_ID_LEN);
  const cleanName = String(name ?? "").slice(0, MAX_AREA_NAME_LEN);
  if (!cleanAreaId || !cleanUserId || !cleanName) return null;
  const entry = { userId: cleanUserId, name: cleanName };
  const store = await ensureStore(roomSlug);
  store.areaOwners[cleanAreaId] = entry;
  persist(normalizeSlug(roomSlug), store);
  return entry;
}

/** Solta a posse de UMA área (ver "release-area"/"force-release-area" em
 * server/index.js) -- não confirma dono nenhum, quem chama já conferiu. */
export async function removeAreaOwner(roomSlug, areaId) {
  const cleanAreaId = String(areaId ?? "").slice(0, MAX_AREA_NAME_LEN);
  const store = await ensureStore(roomSlug);
  if (!cleanAreaId || !(cleanAreaId in store.areaOwners)) return false;
  delete store.areaOwners[cleanAreaId];
  persist(normalizeSlug(roomSlug), store);
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

export async function getFurnitureState(roomSlug) {
  const store = await ensureStore(roomSlug);
  return { items: store.furniture, seatOffsets: store.furnitureSeatOffsets };
}

/** Substitui a mobília colocada E o mapa de ajuste de assento de uma vez
 * só (mesmo esquema combinado de setAreaState acima -- o editor sempre
 * manda os dois juntos, ver autosave em GameRoom.tsx). Devolve null se
 * `items`/`seatOffsets` não vierem no formato esperado. */
export async function setFurnitureState(roomSlug, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.items)) return null;
  const items = payload.items.slice(0, MAX_FURNITURE_ITEMS).map(sanitizeFurnitureItem).filter(Boolean);
  const seatOffsets = sanitizeSeatOffsets(payload.seatOffsets);
  const store = await ensureStore(roomSlug);
  store.furniture = items;
  store.furnitureSeatOffsets = seatOffsets;
  persist(normalizeSlug(roomSlug), store);
  return { items, seatOffsets };
}
