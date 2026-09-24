// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import {
  ROOM_FURNITURE,
  FurnitureDef,
  FurnitureType,
  FurnitureCatalogEntry,
  FURNITURE_ART,
  furnitureWorldPos,
  furnitureTextureKey,
  blockingFurnitureAt,
} from "./furniture";
import { clampTile, tileToWorld, worldToTile, Direction, TILE, GRID_COLS, GRID_ROWS } from "./grid";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  SKIN_CATALOG,
  DEFAULT_SKIN_ID,
  BEARD_CATALOG,
  DEFAULT_BEARD_ID,
  resolveBeardSkinId,
  ACCESSORY_CATALOG,
  DEFAULT_ACCESSORY_ID,
  OUTFIT_CATALOG,
  DEFAULT_OUTFIT_ID,
  resolveOutfitSkinId,
} from "./customization";
import { FLOOR_CATALOG, FloorCatalogEntry, FloorTileDef, floorTextureKey, floorWorldPos, floorEntryById } from "./floor";
import {
  AreaType,
  AreaTileDef,
  AreaZone,
  areaTypeMeta,
  areaWorldPos,
  computeAreaZones,
  zoneAtTile,
  zoneBounds,
} from "./areas";

/**
 * Cena principal: renderiza a sala, o avatar local (controlado por
 * teclado) e os avatares remotos (posições recebidas via PartyKit).
 *
 * Esta classe só cuida de RENDERIZAÇÃO e INPUT. A sincronização de rede
 * (enviar/receber posições, WebRTC) é toda feita fora, em GameRoom.tsx,
 * que fala com esta cena através de:
 *   - scene.onLocalMove(x, y)      -> callback chamado a cada frame com a nova posição local
 *   - scene.upsertRemotePlayer(...) -> chamado quando um jogador remoto se move/entra
 *   - scene.removeRemotePlayer(id)  -> chamado quando um jogador remoto sai
 *   - scene.getLocalPosition()      -> lido para calcular distância/proximidade
 *
 * Arte do avatar: sistema de CAMADAS (layers) -- o "base" (corpo/pele)
 * é um spritesheet, e cada item de customização (cabelo, óculos, barba,
 * traje) é OUTRO spritesheet separado, desenhado empilhado por cima, na
 * mesma posição e MESMO frame que o base (ver LAYER_DRAW_ORDER mais
 * abaixo). Isso troca o sistema anterior de "um visual = uma imagem só"
 * pelo esquema modular pedido: cada peça pode ser adicionada/trocada
 * independente, e o boneco base fica padronizado. "Traje" é a roupa
 * inteira do pescoço pra baixo como UMA peça só (não separada em
 * camisa/calça/tênis) -- ver OutfitOption/OUTFIT_CATALOG em
 * customization.ts.
 *
 * Cada spritesheet de camada (base ou item) usa o MESMO layout de
 * frames -- 13 frames:
 *   0-2   down  (parado, passoA, passoB)
 *   3-5   left  (parado, passoA, passoB)
 *   6-8   right (parado, passoA, passoB) -- mesma arte de "left", espelhada
 *   9-11  up    (parado, passoA, passoB)
 *   12    sentado
 * (passoA/passoB alternam a cada passo dado, pra dar sensação real de
 * andar -- ver playWalk.)
 *
 * "base", "cabelo", "barba", "oculos" e "traje" já têm (ou têm estrutura
 * pronta pra receber) arte de verdade -- cada camada nova precisa ser
 * processada pelo mesmo pipeline (chroma-key, normalização, alinhamento)
 * do base, pra bater exatamente o mesmo frame/pose/escala.
 *
 * Movimento é por GRADE (tile a tile, estilo Gather/Habbo) — ver
 * game/grid.ts. Segurando uma direção, o boneco anda de quadrado em
 * quadrado (sem diagonal); ele só é considerado "parado" quando termina
 * de chegar num tile.
 *
 * Sentar é AUTOMÁTICO por móvel (ver game/furniture.ts), não por tecla:
 * o avatar só senta quando PARA totalmente em cima do tile de um móvel
 * sentável (não é mais raio de proximidade enquanto anda perto —
 * só dispara quando ele efetivamente chega e fica parado ali). Anda de
 * novo (qualquer tecla de direção) e levanta sozinho.
 */

const FRAME_W = 200;
const FRAME_H = 260;
// caractere ocupa ~210px de altura dentro do frame de 260 -> essa escala
// deixa ele com uns 90px de altura em tela (tamanho aprovado)
const AVATAR_SCALE = 0.43;

// o container do boneco fica ancorado no CENTRO do tile (tileToWorld) --
// isso é o que worldToTile/clampTile/movimento usam pra saber em que
// tile ele está, não pode mudar. Só que desenhar o "pé" (origem das
// sprites) bem EM CIMA desse ponto (offset 0) deixava o boneco com os
// pés "flutuando" no meio do quadrado visualmente -- por isso as
// sprites (e o label do nome) são desenhadas com um offset PRA BAIXO
// dentro do container: puramente visual, não mexe na posição lógica
// usada pro grid/colisão/sentar.
const AVATAR_FOOT_OFFSET_Y = 14;

// [parado, passoA, passoB] -- passoA/passoB alternam a cada passo dado
// (ver playWalk), não por tempo -- assim funciona igual pra um pulo de
// um quadrado só ou pra caminhada contínua.
const WALK_FRAMES: Record<"down" | "left" | "right" | "up", [number, number, number]> = {
  down: [0, 1, 2],
  left: [3, 4, 5],
  right: [6, 7, 8],
  up: [9, 10, 11],
};

// sentado tem uma pose por direção -- ainda falta uma pose SENTADA de
// costas de verdade (essa leva só trouxe frente/esquerda/direita), então
// "up" usa por enquanto a pose de PÉ de costas (frame 9, mesma da
// caminhada) como aproximação. Funciona porque nesse caso o móvel é
// desenhado NA FRENTE do boneco (ver DEPTH_* e sitAt) -- só a cabeça
// aparece por cima do encosto, então os detalhes de "sentado" do corpo
// (que ficariam escondidos mesmo) não fazem diferença visual.
const SENTADO_FRAMES: Record<Direction, number> = {
  down: 12,
  left: 13,
  right: 14,
  up: WALK_FRAMES.up[0],
};

/**
 * Camadas de customização, na ordem em que são desenhadas (primeiro =
 * mais atrás, último = mais na frente). É um palpite inicial razoável
 * pra roupa/corpo -- fácil de reordenar aqui quando a arte de verdade
 * chegar (ex: se o cabelo tiver franja que devia cobrir os óculos, é só
 * trocar a ordem das duas linhas).
 */
const LAYER_DRAW_ORDER = [
  "base",
  "traje",
  "barba",
  "cabelo",
  "oculos",
] as const;
type LayerKey = (typeof LAYER_DRAW_ORDER)[number];

/**
 * Arquivo de cada camada. Só "base" existe por enquanto -- as outras
 * ficam `null` (não carrega, não desenha) até a arte chegar. Pra
 * "adicionar" um item, basta trocar o `null` pelo nome do arquivo (já
 * processado pelo pipeline de chroma-key/normalização) em
 * `public/assets/`.
 *
 * "cabelo", "base", "barba", "oculos" e "traje" são DIFERENTES das
 * outras -- não são mais um arquivo único, e sim um CATÁLOGO de opções
 * (ver game/customization.ts / HAIR_CATALOG, SKIN_CATALOG,
 * BEARD_CATALOG, ACCESSORY_CATALOG, OUTFIT_CATALOG), porque dá pra
 * trocar ao vivo (editor de personagem, ver setLocalHairId/
 * setLocalSkinId/setLocalBeardId/setLocalAccessoryId/setLocalOutfitId).
 * O valor `null` aqui continua só pra manter o record completo/tipado --
 * a arte de verdade é carregada à parte, ver preload() e createAvatar().
 */
const LAYER_TEXTURE_FILE: Record<LayerKey, string | null> = {
  base: null,
  traje: null,
  barba: null,
  cabelo: null,
  oculos: null,
};

/** Chave da textura no Phaser pra uma camada (ex: "cabelo" -> "avatar-cabelo"). */
function layerTextureKey(layer: LayerKey): string {
  return `avatar-${layer}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de cabelo do catálogo (ver HAIR_CATALOG). */
function hairTextureKey(hairId: string): string {
  return `avatar-cabelo-${hairId}`;
}

/** Chave da textura no Phaser pra UM TOM de pele do catálogo (ver SKIN_CATALOG). */
function skinTextureKey(skinId: string): string {
  return `avatar-base-${skinId}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de barba NUM TOM de pele
 * específico (ver BEARD_CATALOG/resolveBeardSkinId) -- igual ao traje,
 * a arte varia pelos dois, então a chave carrega os dois ids. */
function beardTextureKey(beardId: string, resolvedSkinId: string): string {
  return `avatar-barba-${beardId}-${resolvedSkinId}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de acessório do catálogo (ver ACCESSORY_CATALOG). */
function accessoryTextureKey(accessoryId: string): string {
  return `avatar-oculos-${accessoryId}`;
}

/** Chave da textura no Phaser pra UM TRAJE NUM TOM de pele específico (ver
 * OUTFIT_CATALOG/resolveOutfitSkinId) -- a arte varia pelos dois, então a
 * chave carrega os dois ids. */
function outfitTextureKey(outfitId: string, resolvedSkinId: string): string {
  return `avatar-traje-${outfitId}-${resolvedSkinId}`;
}

// profundidade (z-order): a "fronteira" de um móvel é a borda de CIMA da
// própria fileira dele (onde o tile do móvel começa) -- o boneco fica
// por TRÁS enquanto seu Y não cruzou essa borda (ainda tá na fileira de
// CIMA, onde só a parte que "vaza" do móvel aparece), e passa pra FRENTE
// assim que entra na fileira do móvel (ou below). Comparar direto contra
// essa borda (em vez da base do móvel) é o que faz a troca acontecer
// bem quando o boneco cruza a linha entre as duas fileiras -- inclusive
// no MEIO de um passo (andando continuamente) -- e não só quando ele já
// terminou de chegar.
//
// IMPORTANTE: a fronteira usa a FILEIRA LÓGICA do móvel (f.row), não a
// posição visual dele (furnitureWorldPos, que pode ter um baseOffsetY
// de ajuste fino -- ver furniture.ts) -- assim reposicionar a arte pra
// ficar bonita não muda em que tile a troca de profundidade acontece,
// que continua sendo sempre a borda entre a fileira de cima e a
// fileira onde o móvel está ancorado (col/row).
const DEPTH_FURNITURE_ROW_HEIGHT = TILE;

// exceção: móveis "flat" (tapete, por exemplo -- sem altura de verdade,
// não faz sentido o boneco passar "por trás" deles) ficam sempre atrás
// de tudo, feito decoração colada no chão, fora desse jogo de
// profundidade -- ver FurnitureDef.flat em furniture.ts.
const DEPTH_FLAT_FURNITURE = -1_000_000;

// piso pintado (ver game/floor.ts) fica ATRÁS até de um tapete "flat" --
// é o próprio chão, tudo o mais (móvel flat incluso) fica em cima dele.
const DEPTH_FLOOR = -2_000_000;

// tinta de área (ver game/areas.ts) fica ENTRE o piso e a mobília "flat" --
// é um "verniz" por cima do chão marcando a zona (mesa privada/sala),
// então precisa aparecer ACIMA do piso pintado, mas ainda atrás de
// qualquer móvel (mesmo um tapete flat) pra não competir visualmente com
// a mobília de verdade que fica dentro da área.
const DEPTH_AREA = -1_500_000;

// hitbox de hover do nome do dono (ver updateAreaHoverLabels) fica logo
// acima da tinta, e o próprio label (texto) mais acima ainda -- só
// precisam ficar atrás do boneco/móvel (que usam profundidade dinâmica
// bem maior, perto de 0+), nunca vão colidir de verdade.
const DEPTH_AREA_HOVER = DEPTH_AREA + 1;
const DEPTH_AREA_LABEL = DEPTH_AREA + 2;

// a arte de fundo da sala (textura "room", ver create()) precisa ficar
// AINDA MAIS atrás que o piso pintado -- sem isso ela ficava com
// profundidade padrão (0), ou seja, na FRENTE do piso (DEPTH_FLOOR é
// negativo!), e cobria completamente qualquer quadrado pintado: o piso
// era desenhado certinho, na posição certa, com a textura certa, só que
// sempre escondido atrás do fundo opaco da sala -- por isso nunca
// aparecia nada pintado, por mais que o clique/arrasto funcionasse.
const DEPTH_ROOM_BACKGROUND = -3_000_000;

/** Fronteira de profundidade de um móvel a partir da FILEIRA lógica dele (não da posição visual) -- ver comentário acima. */
function furnitureDepthForRow(row: number): number {
  return tileToWorld(0, row).y + TILE / 2 - DEPTH_FURNITURE_ROW_HEIGHT;
}

// móveis "de vidro" (FurnitureDef.transparent) desenham com essa opacidade
// em vez de opacos -- quem fica por trás (boneco, outro móvel, ordenado
// pela mesma profundidade acima) continua parcialmente visível através.
const GLASS_ALPHA = 0.55;

/** Profundidade do boneco -- é só o próprio Y dele (ancorado no centro do tile), sem ajuste nenhum: compara direto contra furnitureDepthForRow(). */
function avatarDepthForY(y: number): number {
  return y;
}

// grade e highlight do editor de espaço (ver setEditMode) sempre por
// CIMA de tudo (móvel, boneco) -- é UI de edição, não faz parte da
// cena "de verdade".
const EDIT_UI_DEPTH = 10_000_000;

// cor do highlight de hover no editor: verde = tile livre (dá pra
// colocar), vermelho = ocupado (tile já tem âncora de outro móvel --
// clicar ali remove o item em vez de colocar um novo).
const EDIT_HOVER_COLOR_FREE = 0x59d97a;
const EDIT_HOVER_COLOR_OCCUPIED = 0xd95959;

// bolinha de status (foco/ausente/online) ao lado do nome, dentro do
// jogo -- a COR vem sempre de fora (GameRoom.tsx, ver STATUS_COLORS),
// pra não duplicar a paleta aqui; a cena só sabe desenhar um círculo.
const STATUS_DOT_RADIUS = 4;
const STATUS_DOT_GAP = 5;

type Activity = "idle" | "sentado";

/** Ferramenta de piso selecionada no editor (ver selectFloorTool) --
 * "paint" pinta o modelo escolhido, "erase" apaga (volta pro fundo
 * padrão da sala), null = nenhuma ferramenta armada (clique não faz
 * nada nos tiles). */
type FloorTool = { kind: "paint"; entry: FloorCatalogEntry } | { kind: "erase" } | null;

/** Ferramenta de área selecionada no editor (ver selectAreaTool) -- MESMA
 * ideia da FloorTool acima (paint pinta o tipo escolhido, erase apaga,
 * null = nada armado), só que "paint" leva um AreaType em vez de um
 * FloorCatalogEntry (área não tem "modelo", só 2 tipos fixos, ver
 * AREA_TYPES em game/areas.ts). */
type AreaTool = { kind: "paint"; type: AreaType } | { kind: "erase" } | null;

// depois de levantar (por movimento), ignora o auto-sentar por um
// instante -- senão sentaria de novo assim que parasse ainda em cima
// do mesmo tile da cadeira.
const STAND_COOLDOWN_MS = 350;

// tempo pra andar UM quadrado (grade tile a tile, não pixel livre)
const STEP_DURATION_MS = 180;

// zoom da câmera (controles "estilo Gather" no canto do mapa, ver
// MapControls em GameRoom.tsx) -- 1 é o zoom padrão, que já mostra a
// sala inteira (mesmo comportamento de sempre, ver game/config.ts:
// resolução interna 800x600 == GRID_ORIGIN/GRID_COLS/GRID_ROWS
// ocupando toda a área visível), então não faz sentido zoom < 1 (só
// sobraria fundo vazio nas bordas). Exportado pra GameRoom.tsx habilitar/
// desabilitar os botões "+"/"-" no limite, sem duplicar o número aqui.
export const MIN_ZOOM_LEVEL = 1;
export const MAX_ZOOM_LEVEL = 2;
const ZOOM_STEP = 0.25;

// mesma resolução interna do jogo (ver width/height em game/config.ts) --
// é o limite de scroll da câmera (setBounds), pra não deixar
// pan/zoom mostrar área fora da sala.
const CAMERA_WORLD_W = 800;
const CAMERA_WORLD_H = 600;

export default class MainScene extends Phaser.Scene {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

  // trava o movimento por teclado enquanto um campo de texto do React
  // (nome/bio/instagram/chat) está focado -- ver setMovementLocked,
  // chamado pelo listener focusin/focusout em GameRoom.tsx. Ignora o
  // estado "isDown" dos Keys do Phaser direto (que continuam sendo
  // atualizados pelo browser mesmo com o campo focado), em vez de
  // tentar desligar o KeyboardPlugin inteiro -- mais simples e sem
  // risco de tecla "grudar" pressionada ao reativar.
  private movementLocked = false;

  // ignora clique em QUALQUER boneco enquanto o card de perfil (base ou
  // editando) está aberto por cima do jogo -- ver setAvatarClicksLocked,
  // chamado pelo GameRoom.tsx toda vez que profileCard muda. Defensivo:
  // sem isso, um clique na UI do React que por algum motivo alcance o
  // canvas por baixo reabriria/resetaria o card sem querer.
  private avatarClicksLocked = false;

  private localContainer!: Phaser.GameObjects.Container;
  private remoteContainers: Map<string, Phaser.GameObjects.Container> = new Map();

  private lastSent = 0;

  private localActivity: Activity = "idle";
  private sitCooldownUntil = 0;
  private seatedAt: FurnitureDef | null = null;

  // estado do passo atual na grade (tile a tile)
  private stepping = false;
  private stepFrom = { x: 0, y: 0 };
  private stepTo = { x: 0, y: 0 };
  private stepElapsed = 0;
  private stepDir: Direction = "down";

  /** Definido de fora (GameRoom.tsx) após a cena ficar pronta. */
  onLocalMove?: (x: number, y: number) => void;

  localColor = "#5c9bff";
  localName = "Você";
  localStatusColor = "#4fd97a";

  // --- câmera (zoom/arrastar pra olhar ao redor, ver MapControls em
  // GameRoom.tsx: botão de centralizar + zoom "+"/"-") -- arrastar fica
  // DESLIGADO durante o editor de espaço (this.editMode), senão brigaria
  // com o clique/arrasto de colocar móvel (ver handleEditPointerDown).
  private isPanningCamera = false;
  private panStart = { x: 0, y: 0 };
  private panStartScroll = { x: 0, y: 0 };

  // --- editor de espaço ("Editar espaço", ver setEditMode) ---------
  // itens colocados pelo editor ainda não são "de verdade" (não entram
  // em ROOM_FURNITURE nem salvam em lugar nenhum) -- é um RASCUNHO só
  // desta sessão, que o editor mostra como código TS pra colar à mão
  // em furniture.ts (ver game/furnitureCodegen.ts). Por isso ficam à
  // parte de ROOM_FURNITURE, num Map próprio (id -> definição/sprite).
  private editMode = false;
  private selectedCatalogEntry: FurnitureCatalogEntry | null = null;
  private draftFurniture: Map<string, FurnitureDef> = new Map();
  private draftSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  private gridGraphics?: Phaser.GameObjects.Graphics;
  private hoverGraphics?: Phaser.GameObjects.Graphics;

  /** Definido de fora (GameRoom.tsx) -- chamado toda vez que um item é colocado/removido no editor, pra React manter a lista/código em dia. */
  onDraftChange?: (items: FurnitureDef[]) => void;

  // --- piso do editor de espaço (aba "Piso", ver selectFloorTool) --
  // draftFloor/draftFloorSprites guardam TODO o piso da sala (tanto o já
  // salvo no servidor, carregado por loadSavedFloor, quanto o pintado
  // agora nesta sessão -- tudo no MESMO Map, não tem mais uma lista
  // "fixa" separada), chave "col,row" (um piso por tile, não por id --
  // pintar de novo em cima troca o estilo daquele quadrado em vez de
  // empilhar) e o clique pinta/arrasta em vez de só colocar um item por
  // clique (ver paintFloorAt/handleEditPointerDown).
  private selectedFloorTool: FloorTool = null;
  private draftFloor: Map<string, FloorTileDef> = new Map();
  private draftFloorSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  private isPaintingFloor = false;
  private lastPaintedFloorKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftChange, mas pro piso. */
  onDraftFloorChange?: (items: FloorTileDef[]) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em QUALQUER avatar (local ou remoto), pra abrir o card de perfil. */
  onAvatarClick?: (info: { playerId: string; isLocal: boolean; name: string; color: string }) => void;

  // --- área do editor de espaço (aba "Área", ver selectAreaTool) --
  // MESMO esquema do piso (draftFloor acima): draftArea/draftAreaSprites
  // guardam TODA a área da sala (salva no servidor + pintada agora nesta
  // sessão, tudo no mesmo Map, chave "col,row" -- um tipo de área por
  // tile, pintar de novo em cima troca o tipo em vez de empilhar).
  private selectedAreaTool: AreaTool = null;
  private draftArea: Map<string, AreaTileDef> = new Map();
  private draftAreaSprites: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private isPaintingArea = false;
  private lastPaintedAreaKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftFloorChange, mas pra área. */
  onDraftAreaChange?: (items: AreaTileDef[]) => void;

  // zonas calculadas a partir de draftArea (grupos de tiles vizinhos do
  // MESMO tipo, ver computeAreaZones em game/areas.ts) -- recalculadas
  // toda vez que a área, a mobília ou quem tá sentado onde muda (ver
  // refreshAreaZones). Usadas pra: desenhar o contorno de cada zona,
  // achar o dono de uma mesa privada (refreshAreaOwnership) e responder
  // "esse tile tá dentro de qual área?" (areaZoneAt, chamado de fora
  // pelo checkProximity em GameRoom.tsx pra isolar áudio/vídeo).
  private areaZones: AreaZone[] = [];
  private areaZoneBorderGfx: Phaser.GameObjects.Graphics[] = [];

  // dono atual de cada zona "mesa-privada" (zoneId -> quem tá sentado
  // numa cadeira dentro dela) -- só mesas privadas entram aqui, "sala"
  // nunca tem dono. playerId "local" identifica o PRÓPRIO jogador (ver
  // onAreaOwnerClick/isLocal).
  private areaOwnerByZoneId: Map<string, { playerId: string; name: string }> = new Map();

  // móvel (id) + nome de cada jogador REMOTO sentado agora, alimentado
  // de fora pelas mensagens "seat" recebidas (ver setRemoteSeat, chamado
  // pelo GameRoom.tsx) -- o LOCAL usa this.seatedAt direto, nunca passa
  // por aqui.
  private remoteSeat: Map<string, { furnitureId: string | null; name: string }> = new Map();

  // hitbox de hover (mostra/esconde o nome) + o próprio texto do nome,
  // um par por zona "mesa-privada" -- ver updateAreaHoverLabels.
  private areaHoverZones: Map<string, Phaser.GameObjects.Zone> = new Map();
  private areaNameLabels: Map<string, Phaser.GameObjects.Text> = new Map();

  /** Definido de fora (GameRoom.tsx) -- chamado toda vez que o jogador LOCAL senta/levanta, pra mandar "seat" pro servidor (ver protocolo em server/index.js). */
  onLocalSeatChange?: (furnitureId: string | null) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar no nome (hover) do dono de uma mesa privada, pra abrir o card de perfil dele -- mesmo destino do onAvatarClick acima, só que disparado pela MESA, não pelo boneco. */
  onAreaOwnerClick?: (info: { playerId: string; isLocal: boolean }) => void;

  constructor() {
    super("main");
  }

  preload() {
    // carrega o spritesheet de cada camada que já tem arte definida em
    // LAYER_TEXTURE_FILE (as com valor `null` ficam de fora até a arte
    // chegar -- ver createAvatar, que também só desenha as camadas
    // carregadas).
    for (const layer of LAYER_DRAW_ORDER) {
      if (layer === "cabelo") continue; // carregado abaixo, ver HAIR_CATALOG
      if (layer === "base") continue; // carregado abaixo, ver SKIN_CATALOG
      if (layer === "barba") continue; // carregado abaixo, ver BEARD_CATALOG
      if (layer === "oculos") continue; // carregado abaixo, ver ACCESSORY_CATALOG
      if (layer === "traje") continue; // carregado abaixo, ver OUTFIT_CATALOG
      const file = LAYER_TEXTURE_FILE[layer];
      if (!file) continue;
      this.load.spritesheet(layerTextureKey(layer), `/assets/${file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        // 2px de espaço transparente entre cada frame -- sem isso, com
        // antialias:true (necessário pra arte gerada não ficar serrilhada),
        // a GPU "vaza" um fiapo de pixel do frame vizinho nas bordas
        // (bilinear filtering lendo além do frame), o que aparecia como o
        // frame de outra pose "grudado" junto, principalmente entre poses
        // adjacentes na folha (ex: perna de "passo" aparecendo junto com a
        // pose do lado).
        spacing: 2,
      });
    }

    // cada opção de cabelo do catálogo é o SEU PRÓPRIO spritesheet (mesmo
    // layout de frames do base) -- carrega todas de uma vez (não só a
    // escolhida agora) pra trocar ao vivo sem precisar recarregar nada
    // (ver setLocalHairId, chamado pelo editor de personagem). Cada
    // VARIAÇÃO DE COR (ver HairOption.colors, ex: "Castanho"/"Loiro"/
    // "Preto" de um mesmo penteado) também é seu próprio spritesheet à
    // parte -- carrega junto aqui, indexado pelo id da COR (não do
    // penteado), porque escolher uma cor troca de textura pro arquivo
    // dela, exatamente como trocar de penteado.
    for (const opt of HAIR_CATALOG) {
      this.load.spritesheet(hairTextureKey(opt.id), `/assets/${opt.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
      for (const color of opt.colors ?? []) {
        this.load.spritesheet(hairTextureKey(color.id), `/assets/${color.file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }

    // cada tom de pele do catálogo (ver SKIN_CATALOG) é o SEU PRÓPRIO
    // spritesheet, mesmo esquema de "base" -- carrega todos de uma vez
    // pra trocar ao vivo sem recarregar nada (ver setLocalSkinId).
    for (const skin of SKIN_CATALOG) {
      this.load.spritesheet(skinTextureKey(skin.id), `/assets/${skin.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
    }

    // barba: igual ao traje, cada OPÇÃO tem VÁRIOS arquivos (um por tom
    // de pele, ver BeardOption.bySkin) -- carrega cada combinação
    // barba+tom que existe de verdade como seu próprio spritesheet (ver
    // beardTextureKey). "Nenhuma" (arquivo transparente) é só mais um
    // spritesheet normal pro Phaser, sem tratamento especial.
    for (const beard of BEARD_CATALOG) {
      for (const [skinId, file] of Object.entries(beard.bySkin)) {
        if (!file) continue;
        this.load.spritesheet(beardTextureKey(beard.id, skinId), `/assets/${file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }
    // acessório: catálogo + cores aninhadas (ver ACCESSORY_CATALOG) --
    // inclui a opção "Nenhum" (arquivo transparente), que também é só
    // mais um spritesheet normal pro Phaser, sem tratamento especial.
    for (const accessory of ACCESSORY_CATALOG) {
      this.load.spritesheet(accessoryTextureKey(accessory.id), `/assets/${accessory.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
      for (const color of accessory.colors ?? []) {
        this.load.spritesheet(accessoryTextureKey(color.id), `/assets/${color.file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }

    // traje: diferente das outras camadas, cada OPÇÃO tem VÁRIOS arquivos
    // (um por tom de pele, ver OutfitOption.bySkin) -- carrega cada
    // combinação traje+tom que realmente existe (não todo tom pra todo
    // traje, só os que a pasta de origem trouxe de verdade) como seu
    // próprio spritesheet, indexado pelos dois ids (ver outfitTextureKey).
    for (const outfit of OUTFIT_CATALOG) {
      for (const [skinId, file] of Object.entries(outfit.bySkin)) {
        if (!file) continue;
        this.load.spritesheet(outfitTextureKey(outfit.id, skinId), `/assets/${file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }
    this.load.image("room", "/assets/room.png");

    // carrega a arte de TODA combinação tipo+direção que existe em
    // FURNITURE_ART (não só as que ROOM_FURNITURE já usa) -- assim o
    // editor de espaço (ver setEditMode/paleta) consegue colocar
    // qualquer item do catálogo na hora, mesmo um que ainda não
    // apareça em nenhum móvel fixo da sala.
    for (const type of Object.keys(FURNITURE_ART) as FurnitureType[]) {
      const artByFacing = FURNITURE_ART[type];
      for (const facing of Object.keys(artByFacing) as Direction[]) {
        const file = artByFacing[facing];
        if (!file) continue;
        this.load.image(furnitureTextureKey(type, facing), `/assets/${file}`);
      }
    }

    // cada modelo de piso (ver FLOOR_CATALOG) é uma imagem PLANA só,
    // sem poses/direção (diferente do avatar) -- carrega todos de uma
    // vez pra pintar ao vivo no editor sem recarregar nada.
    for (const entry of FLOOR_CATALOG) {
      this.load.image(floorTextureKey(entry.id), `/assets/${entry.file}`);
    }
  }

  create() {
    this.add.image(400, 300, "room").setOrigin(0.5).setDepth(DEPTH_ROOM_BACKGROUND);

    // piso pintado vai ATRÁS de tudo o resto, cobrindo só os quadrados
    // escolhidos -- por isso desenha antes até dos móveis fixos (ver
    // DEPTH_FLOOR). O piso salvo de verdade chega depois, assíncrono (ver
    // loadSavedFloor mais abaixo, chamado pelo React em GameRoom.tsx
    // assim que a busca em GET /room/floor responder) -- create() não
    // espera por ele.

    for (const f of ROOM_FURNITURE) {
      this.addFurnitureSprite(f);
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

    const spawn = tileToWorld(6, 4);
    this.localContainer = this.createAvatar(
      spawn.x,
      spawn.y,
      this.localColor,
      this.localName,
      true,
      "local",
      this.localStatusColor
    );

    this.drawEditGrid();
    this.hoverGraphics = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(false);

    // câmera começa igual sempre foi (zoom 1, sala inteira visível) --
    // setBounds só define até onde dá pra arrastar/dar zoom sem mostrar
    // área fora da sala (ver CAMERA_WORLD_W/H).
    this.cameras.main.setBounds(0, 0, CAMERA_WORLD_W, CAMERA_WORLD_H);
    this.cameras.main.setZoom(MIN_ZOOM_LEVEL);

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.handleEditPointerMove(pointer);
      this.handleCameraPan(pointer);
    });
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.handleEditPointerDown(pointer);
      this.startCameraPan(pointer);
    });
    this.input.on("pointerup", () => {
      this.stopCameraPan();
      this.stopFloorPaint();
      this.stopAreaPaint();
    });
    this.input.on("pointerupoutside", () => {
      this.stopCameraPan();
      this.stopFloorPaint();
      this.stopAreaPaint();
    });
  }

  /**
   * Cria (ou recria) a imagem de UM móvel na cena, já com origem,
   * profundidade e transparência certas -- usado tanto pros móveis
   * fixos (ROOM_FURNITURE, no create()) quanto pros itens "rascunho"
   * colocados pelo editor de espaço (ver placeDraftFurniture), pra
   * garantir que os dois renderizam exatamente igual.
   */
  private addFurnitureSprite(f: FurnitureDef): Phaser.GameObjects.Image {
    // origem embaixo-centro, igual ao avatar: a posição do móvel é o
    // pontinho onde ele "toca o chão", alinhado ao tile dele
    const pos = furnitureWorldPos(f);
    return this.add
      .image(pos.x, pos.y, furnitureTextureKey(f.type, f.facing))
      .setOrigin(0.5, 1)
      .setDepth(f.flat ? DEPTH_FLAT_FURNITURE : furnitureDepthForRow(f.row))
      .setAlpha(f.transparent ? GLASS_ALPHA : 1);
  }

  /**
   * Cria (ou recria) a imagem de UM quadrado de piso pintado, já com
   * origem/tamanho/profundidade certos -- usado tanto pro piso já salvo
   * (ver loadSavedFloor) quanto pros tiles pintados na hora no editor de
   * espaço (ver paintFloorAt), mesma ideia do addFurnitureSprite. Devolve
   * null se o styleId não bate com nenhum item do catálogo (defensivo --
   * não deveria acontecer normalmente).
   */
  private addFloorSprite(f: FloorTileDef): Phaser.GameObjects.Image | null {
    const entry = floorEntryById(f.styleId);
    if (!entry) return null;
    const pos = floorWorldPos(f);
    return this.add
      .image(pos.x, pos.y, floorTextureKey(f.styleId))
      .setOrigin(0.5, 0.5)
      .setDisplaySize(TILE, TILE)
      .setDepth(DEPTH_FLOOR);
  }

  /**
   * Carrega o piso já salvo no servidor (ver GET /room/floor em
   * server/index.js) -- chamado UMA vez pelo React (GameRoom.tsx) assim
   * que a cena fica pronta E a busca responder (podem chegar em
   * qualquer ordem, por isso não faz parte do create() direto, que não
   * espera rede nenhuma).
   *
   * Cada tile carregado entra direto em draftFloor/draftFloorSprites --
   * o MESMO Map que o pincel usa pros tiles pintados nesta sessão -- em
   * vez de ficar num Map/desenho separado tipo "fixo". Isso é de
   * propósito: assim o botão "Apagar" e o "Limpar tudo" funcionam em
   * QUALQUER tile (salvo antes ou pintado agora), sem distinção, e o
   * autosave (ver onDraftFloorChange, disparado no fim daqui) sempre
   * manda pro servidor o piso INTEIRO certo, não só o que mudou agora.
   */
  loadSavedFloor(items: FloorTileDef[]) {
    for (const f of items) {
      const key = `${f.col},${f.row}`;
      if (this.draftFloor.has(key)) continue; // já carregado (ex: chamado 2x) -- não duplica sprite
      const sprite = this.addFloorSprite(f);
      if (!sprite) continue;
      this.draftFloor.set(key, f);
      this.draftFloorSprites.set(key, sprite);
    }
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  private createAvatar(
    x: number,
    y: number,
    color: string,
    name: string,
    isLocal: boolean,
    playerId: string,
    statusColor: string = "#4fd97a"
  ): Phaser.GameObjects.Container {
    // uma Sprite por camada EQUIPADA (só as que já têm arte carregada em
    // LAYER_TEXTURE_FILE), empilhadas na ordem de LAYER_DRAW_ORDER --
    // todas na mesma posição/frame, então de longe parecem um boneco só.
    // "cabelo", "base", "barba", "oculos" e "traje" são especiais:
    // sempre entram (têm catálogo de verdade agora, ver HAIR_CATALOG/
    // SKIN_CATALOG/BEARD_CATALOG/ACCESSORY_CATALOG/OUTFIT_CATALOG),
    // começando na opção padrão -- guardam a própria Sprite à parte
    // (hairSprite/skinSprite/beardSprite/accessorySprite/outfitSprite)
    // pra dar pra trocar de textura DEPOIS sem recriar o boneco inteiro
    // (ver setLocalHairId/setLocalSkinId/setLocalBeardId/
    // setLocalAccessoryId/setLocalOutfitId). "Nenhuma(o)" (barba/
    // acessório/traje) é só mais uma opção do catálogo (arquivo
    // transparente), não precisa de tratamento diferente aqui.
    const layerSprites: Phaser.GameObjects.Sprite[] = [];
    let hairSprite: Phaser.GameObjects.Sprite | null = null;
    let skinSprite: Phaser.GameObjects.Sprite | null = null;
    let beardSprite: Phaser.GameObjects.Sprite | null = null;
    let accessorySprite: Phaser.GameObjects.Sprite | null = null;
    let outfitSprite: Phaser.GameObjects.Sprite | null = null;
    for (const layer of LAYER_DRAW_ORDER) {
      if (layer === "cabelo") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          hairTextureKey(DEFAULT_HAIR_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        hairSprite = sprite;
        continue;
      }
      if (layer === "base") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          skinTextureKey(DEFAULT_SKIN_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        skinSprite = sprite;
        continue;
      }
      if (layer === "traje") {
        const defaultOutfit = OUTFIT_CATALOG.find((o) => o.id === DEFAULT_OUTFIT_ID) ?? OUTFIT_CATALOG[0];
        const resolvedSkinId = resolveOutfitSkinId(defaultOutfit, DEFAULT_SKIN_ID) ?? DEFAULT_SKIN_ID;
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          outfitTextureKey(defaultOutfit.id, resolvedSkinId),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        outfitSprite = sprite;
        continue;
      }
      if (layer === "barba") {
        const defaultBeard = BEARD_CATALOG.find((b) => b.id === DEFAULT_BEARD_ID) ?? BEARD_CATALOG[0];
        const resolvedBeardSkinId = resolveBeardSkinId(defaultBeard, DEFAULT_SKIN_ID) ?? DEFAULT_SKIN_ID;
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          beardTextureKey(defaultBeard.id, resolvedBeardSkinId),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        beardSprite = sprite;
        continue;
      }
      if (layer === "oculos") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          accessoryTextureKey(DEFAULT_ACCESSORY_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        accessorySprite = sprite;
        continue;
      }
      if (!LAYER_TEXTURE_FILE[layer]) continue;
      const sprite = this.add.sprite(0, AVATAR_FOOT_OFFSET_Y, layerTextureKey(layer), WALK_FRAMES.down[0]);
      // origem embaixo-centro: o "pé" do boneco fica no (0,0) do
      // container, que é a posição lógica dele na sala (chão)
      sprite.setOrigin(0.5, 1);
      sprite.setScale(AVATAR_SCALE);
      layerSprites.push(sprite);
    }

    const label = this.add
      .text(0, AVATAR_FOOT_OFFSET_Y - layerSprites[0].displayHeight - 8, name, {
        fontSize: "11px",
        color: "#ffffff",
        fontFamily: "monospace",
        backgroundColor: "#00000088",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5);

    // bolinha de status: fica à esquerda do nome, o par inteiro
    // (bolinha + espaço + texto) centralizado sobre o boneco -- ver
    // layoutNameplate, chamado aqui embaixo e de novo toda vez que o
    // nome muda (setNameplate).
    const statusDot = this.add.circle(
      0,
      label.y,
      STATUS_DOT_RADIUS,
      Phaser.Display.Color.HexStringToColor(statusColor).color
    );

    const dispW = layerSprites[0].displayWidth;
    const dispH = layerSprites[0].displayHeight;

    // destaque ao passar o mouse (ver hitArea/pointerdown mais abaixo --
    // o avatar inteiro já é clicável, isso só acrescenta o feedback
    // visual de hover, igual o Gather): um CONTORNO em cada camada
    // (Phaser FX "Glow", só funciona no renderer WebGL -- ver
    // supportsGlowFX), que segue o alfa de cada sprite -- por isso
    // contorna o boneco certinho (roupa/pose/cabelo do momento, o que
    // estiver equipado), em vez de uma forma fixa por cima que só cobre
    // um pedaço dele. outerStrength começa em 0 (sem contorno visível)
    // -- pointerover/pointerout mais abaixo animam ele com tween (e um
    // leve aumento de escala nas sprites, junto). Em Canvas (sem
    // suporte a FX) essa parte não faz nada -- sobra só o zoom leve.
    const supportsGlowFX = this.game.renderer.type === Phaser.WEBGL;
    const glowFx: Phaser.FX.Glow[] = supportsGlowFX
      ? layerSprites.map((sprite) => sprite.postFX.addGlow(0x7c5cff, 0, 0, false, 0.3, 10))
      : [];

    const container = this.add.container(x, y, [...layerSprites, label, statusDot]);
    container.setSize(dispW, dispH);
    container.setDepth(avatarDepthForY(y));
    container.setData("layers", layerSprites);
    container.setData("label", label);
    container.setData("statusDot", statusDot);
    container.setData("dir", "down" as Direction);
    container.setData("stepToggle", false);
    container.setData("hairSprite", hairSprite);
    container.setData("hairId", DEFAULT_HAIR_ID);
    container.setData("skinSprite", skinSprite);
    container.setData("skinId", DEFAULT_SKIN_ID);
    container.setData("beardSprite", beardSprite);
    container.setData("beardId", DEFAULT_BEARD_ID);
    container.setData("accessorySprite", accessorySprite);
    container.setData("accessoryId", DEFAULT_ACCESSORY_ID);
    container.setData("outfitSprite", outfitSprite);
    container.setData("outfitId", DEFAULT_OUTFIT_ID);
    container.setData("playerId", playerId);
    container.setData("isLocal", isLocal);
    this.layoutNameplate(label, statusDot);

    // clicável (card de perfil, ver onAvatarClick) -- a área de clique
    // precisa ser um retângulo próprio porque as sprites são ancoradas
    // embaixo-centro (origem 0.5,1) com um offset vertical
    // (AVATAR_FOOT_OFFSET_Y), então o boneco visualmente ocupa uma faixa
    // ACIMA e ao redor do (0,0) do container, não abaixo/à direita dele
    // (que é a área padrão que setInteractive() usaria sem essa forma
    // customizada).
    const hitArea = new Phaser.Geom.Rectangle(-dispW / 2, AVATAR_FOOT_OFFSET_Y - dispH, dispW, dispH);
    container.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);
    if (container.input) container.input.cursor = "pointer";
    container.on("pointerdown", () => {
      if (this.avatarClicksLocked) return;
      this.onAvatarClick?.({ playerId, isLocal, name, color });
    });
    // destaque de hover (ver glowFx acima) -- desliga junto com o
    // clique quando avatarClicksLocked (não faz sentido destacar algo
    // que não vai responder ao clique agora).
    container.on("pointerover", () => {
      if (this.avatarClicksLocked) return;
      if (glowFx.length > 0) {
        this.tweens.killTweensOf(glowFx);
        this.tweens.add({ targets: glowFx, outerStrength: 3, duration: 120, ease: "Sine.easeOut" });
      }
      this.tweens.killTweensOf(layerSprites);
      this.tweens.add({
        targets: layerSprites,
        scaleX: AVATAR_SCALE * 1.05,
        scaleY: AVATAR_SCALE * 1.05,
        duration: 120,
        ease: "Sine.easeOut",
      });
    });
    container.on("pointerout", () => {
      if (glowFx.length > 0) {
        this.tweens.killTweensOf(glowFx);
        this.tweens.add({ targets: glowFx, outerStrength: 0, duration: 120, ease: "Sine.easeIn" });
      }
      this.tweens.killTweensOf(layerSprites);
      this.tweens.add({
        targets: layerSprites,
        scaleX: AVATAR_SCALE,
        scaleY: AVATAR_SCALE,
        duration: 120,
        ease: "Sine.easeIn",
      });
    });

    return container;
  }

  /**
   * Reposiciona a bolinha de status + o texto do nome como UM grupo só,
   * centralizado sobre o boneco (em vez de cada um centralizado por
   * si) -- precisa ser recalculado toda vez que o texto do nome muda,
   * porque a largura do label muda junto.
   */
  private layoutNameplate(label: Phaser.GameObjects.Text, dot: Phaser.GameObjects.Arc) {
    const groupWidth = STATUS_DOT_RADIUS * 2 + STATUS_DOT_GAP + label.width;
    const left = -groupWidth / 2;
    dot.setPosition(left + STATUS_DOT_RADIUS, label.y);
    label.setOrigin(0, 0.5);
    label.setX(left + STATUS_DOT_RADIUS * 2 + STATUS_DOT_GAP);
  }

  /** Atualiza nome + cor da bolinha de status de um boneco já existente (local ou remoto), sem recriar nada. */
  private setNameplate(container: Phaser.GameObjects.Container, name: string, statusColor: string) {
    const label = container.getData("label") as Phaser.GameObjects.Text | undefined;
    const dot = container.getData("statusDot") as Phaser.GameObjects.Arc | undefined;
    if (!label || !dot) return;
    if (label.text !== name) label.setText(name);
    dot.setFillStyle(Phaser.Display.Color.HexStringToColor(statusColor).color);
    this.layoutNameplate(label, dot);
  }

  /** Chamado de fora (GameRoom.tsx) toda vez que MEU nome ou status muda no card de perfil, pra refletir ao vivo no boneco dentro do jogo. */
  setLocalProfile(name: string, statusColor: string) {
    this.localName = name;
    this.localStatusColor = statusColor;
    if (this.localContainer) this.setNameplate(this.localContainer, name, statusColor);
  }

  /** Liga/desliga o clique nos bonecos (ver avatarClicksLocked) -- chamado de fora sempre que profileCard muda (GameRoom.tsx). */
  setAvatarClicksLocked(locked: boolean) {
    this.avatarClicksLocked = locked;
  }

  /** Troca o penteado do jogador LOCAL ao vivo (ver HAIR_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalHairId(hairId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("hairSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(hairTextureKey(hairId), currentFrame);
    this.localContainer.setData("hairId", hairId);
  }

  /** Troca o tom de pele do jogador LOCAL ao vivo (ver SKIN_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx). Também reaplica a
   * textura do TRAJE e da BARBA equipados (se algum), porque a arte dos
   * dois varia por tom de pele -- ver resolveOutfitSkinId/
   * resolveBeardSkinId. Isso garante que trocar o tom mantém a mão e a
   * barba combinando, independente da ordem em que skin/traje/barba
   * forem trocados. */
  setLocalSkinId(skinId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("skinSprite") as Phaser.GameObjects.Sprite | null;
    if (sprite) {
      const currentFrame = sprite.frame.name;
      sprite.setTexture(skinTextureKey(skinId), currentFrame);
    }
    this.localContainer.setData("skinId", skinId);

    const outfitSprite = this.localContainer.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    const outfitId = this.localContainer.getData("outfitId") as string | undefined;
    if (outfitSprite && outfitId) {
      const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
      if (outfit) {
        const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
        if (resolvedSkinId) {
          const currentFrame = outfitSprite.frame.name;
          outfitSprite.setTexture(outfitTextureKey(outfit.id, resolvedSkinId), currentFrame);
        }
      }
    }

    const beardSprite = this.localContainer.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    const beardId = this.localContainer.getData("beardId") as string | undefined;
    if (beardSprite && beardId) {
      const beard = BEARD_CATALOG.find((b) => b.id === beardId);
      if (beard) {
        const resolvedBeardSkinId = resolveBeardSkinId(beard, skinId);
        if (resolvedBeardSkinId) {
          const currentFrame = beardSprite.frame.name;
          beardSprite.setTexture(beardTextureKey(beard.id, resolvedBeardSkinId), currentFrame);
        }
      }
    }
  }

  /** Troca a barba do jogador LOCAL ao vivo (ver BEARD_CATALOG) -- chamado
   * pelo editor de personagem (GameRoom.tsx). Usa o tom de pele ATUAL do
   * jogador pra escolher a arte certa (ver resolveBeardSkinId) -- não
   * precisa escolha manual de cor/tom, igual o traje. */
  setLocalBeardId(beardId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const beard = BEARD_CATALOG.find((b) => b.id === beardId);
    if (!beard) return;
    const skinId = (this.localContainer.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveBeardSkinId(beard, skinId);
    if (!resolvedSkinId) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(beardTextureKey(beard.id, resolvedSkinId), currentFrame);
    this.localContainer.setData("beardId", beardId);
  }

  /** Troca o acessório do jogador LOCAL ao vivo (ver ACCESSORY_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalAccessoryId(accessoryId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("accessorySprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(accessoryTextureKey(accessoryId), currentFrame);
    this.localContainer.setData("accessoryId", accessoryId);
  }

  /** Troca o traje do jogador LOCAL ao vivo (ver OUTFIT_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx). Usa o tom de pele
   * ATUAL do jogador pra escolher a arte certa (mão exposta, ver
   * resolveOutfitSkinId) -- não precisa escolha manual de cor/tom. */
  setLocalOutfitId(outfitId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
    if (!outfit) return;
    const skinId = (this.localContainer.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
    if (!resolvedSkinId) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(outfitTextureKey(outfit.id, resolvedSkinId), currentFrame);
    this.localContainer.setData("outfitId", outfitId);
  }

  /**
   * Mostra o frame de "passo" (andando) na direção dada, direto -- sem
   * depender de uma animação com frameRate próprio. Um passo na grade
   * dura só STEP_DURATION_MS (180ms); uma animação por tempo (frameRate)
   * podia nem chegar a trocar de frame nesse intervalo curto, fazendo um
   * pulo de UM quadrado parecer que o boneco não se moveu de verdade.
   * Setando o frame direto, o "passo" fica visível a viagem toda.
   *
   * Alterna entre passoA/passoB a cada CHAMADA (ou seja, a cada passo de
   * verdade dado -- ver startStep/upsertRemotePlayer), não por tempo. Com
   * só 1 frame de passo o boneco "deslizava" parado; agora a perna troca
   * de fato a cada quadrado andado, contínuo ou não.
   */
  private playWalk(container: Phaser.GameObjects.Container, dir: Direction) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    const prevDir = container.getData("dir") as Direction;
    // só alterna a perna se já estava andando NA MESMA direção -- ao
    // mudar de direção, recomeça do passoA pra ficar previsível
    const toggle = prevDir === dir ? !container.getData("stepToggle") : true;
    container.setData("dir", dir);
    container.setData("stepToggle", toggle);
    const frame = WALK_FRAMES[dir][toggle ? 1 : 2];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  private stopWalk(container: Phaser.GameObjects.Container) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    const dir = container.getData("dir") as Direction;
    const frame = WALK_FRAMES[dir][0];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  private setPoseFrame(container: Phaser.GameObjects.Container, frame: number) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  /** Levanta (se estiver sentado) e libera o movimento de novo. */
  private standUp() {
    this.localActivity = "idle";
    this.seatedAt = null;
    this.sitCooldownUntil = this.time.now + STAND_COOLDOWN_MS;
    this.localContainer.setDepth(avatarDepthForY(this.localContainer.y));
    this.stopWalk(this.localContainer);
    // "solta" a posse de mesa privada, se a cadeira em que tava sentado
    // ficava dentro de uma (ver refreshAreaOwnership) -- avisa o servidor
    // (ver protocolo "seat" em server/index.js) e já recalcula local.
    this.onLocalSeatChange?.(null);
    this.refreshAreaZones();
  }

  /** Senta automaticamente no móvel passado (chamado ao PARAR no tile dele). */
  private sitAt(furniture: FurnitureDef) {
    const pos = furnitureWorldPos(furniture);
    this.localActivity = "sentado";
    this.seatedAt = furniture;
    this.localContainer.setPosition(
      pos.x + (furniture.seatOffsetX ?? 0),
      pos.y + (furniture.seatOffsetY ?? 0)
    );
    // a pose sentada segue a direção que o móvel "olha" (facing), não a
    // direção que o jogador estava andando antes de sentar
    this.localContainer.setData("dir", furniture.facing);
    this.setPoseFrame(this.localContainer, SENTADO_FRAMES[furniture.facing]);
    // virado "up" (de costas pra câmera): o móvel fica NA FRENTE do
    // boneco, então só a cabeça aparece por cima do encosto -- isso é
    // uma EXCEÇÃO deliberada à regra geral de profundidade por fileira
    // (força o boneco pra 1px atrás desse móvel específico, não importa
    // o Y dele). Nas outras direções, usa a regra geral (avatarDepthForY)
    // -- como o assento fica dentro da própria fileira do móvel, ele já
    // sai na frente naturalmente, sentado "visível" sobre o móvel.
    this.localContainer.setDepth(
      furniture.facing === "up"
        ? furnitureDepthForRow(furniture.row) - 1
        : avatarDepthForY(this.localContainer.y)
    );
    // sentar numa cadeira dentro de uma zona "mesa-privada" TOMA POSSE
    // dela (ver refreshAreaOwnership) -- avisa o servidor (protocolo
    // "seat") e já recalcula local, pra própria pessoa ver o nome/o
    // dono mudar na hora, sem esperar o round-trip de rede.
    this.onLocalSeatChange?.(furniture.id);
    this.refreshAreaZones();
  }

  /**
   * Só considera sentar quando o boneco está IDLE (parado, não no meio
   * de um passo) exatamente em cima do tile de uma cadeira -- andar
   * perto ou passar por cima sem parar não senta.
   */
  private findChairAtCurrentTile(): FurnitureDef | null {
    if (this.time.now < this.sitCooldownUntil) return null;
    const { col, row } = worldToTile(this.localContainer.x, this.localContainer.y);
    for (const f of ROOM_FURNITURE) {
      // só "poltrona" é sentável -- vidro (e outros móveis de decoração
      // que forem chegando) não deve disparar o auto-sentar só por o
      // boneco parar em cima do tile dele.
      if (f.type === "poltrona" && f.col === col && f.row === row) return f;
    }
    return null;
  }

  /** Relata a posição atual pro servidor, no máximo a cada 50ms. */
  private reportPosition(_time: number) {
    if (_time - this.lastSent > 50) {
      this.lastSent = _time;
      this.onLocalMove?.(this.localContainer.x, this.localContainer.y);
    }
  }

  /**
   * Liga/desliga a leitura de teclado (ver comentário em movementLocked).
   * O flag sozinho barra o MOVIMENTO, mas não bastava: o Phaser também
   * "captura" teclas de seta globalmente (preventDefault direto no
   * KeyboardManager, ANTES de qualquer isDown/enabled de plugin) só pra
   * evitar a página rolar durante o jogo -- só que isso quebra também o
   * cursor de texto (setinha esquerda/direita) dentro de um input
   * focado. disableGlobalCapture()/enableGlobalCapture() desliga essa
   * captura por completo enquanto um campo de texto tá focado.
   */
  setMovementLocked(locked: boolean) {
    this.movementLocked = locked;
    if (locked) {
      this.input.keyboard?.disableGlobalCapture();
    } else {
      this.input.keyboard?.enableGlobalCapture();
    }
  }

  // --- câmera: zoom + arrastar pra olhar ao redor (botões em
  // MapControls, GameRoom.tsx) -------------------------------------

  /** Começa a arrastar a câmera com o mouse -- ignorado durante o editor
   * de espaço (o pointerdown ali já é pra colocar/selecionar móvel). */
  private startCameraPan(pointer: Phaser.Input.Pointer) {
    if (this.editMode) return;
    this.isPanningCamera = true;
    this.panStart = { x: pointer.x, y: pointer.y };
    this.panStartScroll = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY };
  }

  private handleCameraPan(pointer: Phaser.Input.Pointer) {
    if (!this.isPanningCamera || !pointer.isDown) return;
    // divide pelo zoom -- arrastar 1px de MOUSE precisa mover mais de
    // 1px de MUNDO quando a câmera tá afastada (zoom baixo) e menos
    // quando tá aproximada (zoom alto), senão o boneco "foge" ou "gruda"
    // no cursor dependendo do zoom atual.
    const zoom = this.cameras.main.zoom;
    const dx = (pointer.x - this.panStart.x) / zoom;
    const dy = (pointer.y - this.panStart.y) / zoom;
    this.cameras.main.setScroll(this.panStartScroll.x - dx, this.panStartScroll.y - dy);
  }

  private stopCameraPan() {
    this.isPanningCamera = false;
  }

  private stopFloorPaint() {
    this.isPaintingFloor = false;
    this.lastPaintedFloorKey = null;
  }

  private stopAreaPaint() {
    this.isPaintingArea = false;
    this.lastPaintedAreaKey = null;
  }

  /** Aplica um novo zoom mantendo o mesmo PONTO CENTRAL da câmera --
   * setZoom sozinho "puxa" a visão pro canto 0,0 do mundo, o que dá um
   * pulo feio na tela toda vez que aperta "+"/"-". */
  private applyZoom(nextZoom: number) {
    const clamped = Phaser.Math.Clamp(nextZoom, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL);
    const cam = this.cameras.main;
    const centerX = cam.worldView.centerX;
    const centerY = cam.worldView.centerY;
    cam.setZoom(clamped);
    cam.centerOn(centerX, centerY);
    return clamped;
  }

  /** Botão "+" do MapControls -- devolve o zoom já aplicado (limitado),
   * pra GameRoom.tsx saber quando desabilitar o botão no teto. */
  zoomIn(): number {
    return this.applyZoom(this.cameras.main.zoom + ZOOM_STEP);
  }

  /** Botão "-" do MapControls -- mesma ideia, limitado no piso. */
  zoomOut(): number {
    return this.applyZoom(this.cameras.main.zoom - ZOOM_STEP);
  }

  /** Botão de centralizar (ícone de mira) do MapControls -- volta a
   * câmera pro boneco local, SEM mudar o zoom atual (igual o Gather). */
  recenterCamera() {
    this.cameras.main.centerOn(this.localContainer.x, this.localContainer.y);
  }

  /** Tecla de direção pressionada agora, só uma por vez (sem diagonal). */
  private readInputDir(): Direction | null {
    if (this.movementLocked) return null;
    const left = this.cursors.left?.isDown || this.wasd.left.isDown;
    const right = this.cursors.right?.isDown || this.wasd.right.isDown;
    const up = this.cursors.up?.isDown || this.wasd.up.isDown;
    const down = this.cursors.down?.isDown || this.wasd.down.isDown;
    // prioridade fixa quando mais de uma tecla está pressionada junto
    if (down) return "down";
    if (up) return "up";
    if (left) return "left";
    if (right) return "right";
    return null;
  }

  /** Começa a andar um tile na direção pedida, se o destino for válido. */
  private startStep(dir: Direction) {
    const { col, row } = worldToTile(this.localContainer.x, this.localContainer.y);
    const delta = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }[dir];
    const target = clampTile(col + delta[0], row + delta[1]);
    const targetPos = tileToWorld(target.col, target.row);

    // bateu na borda do mapa (destino = posição atual) OU o tile de
    // destino é travado por um móvel (ex: divisória de vidro, ver
    // FURNITURE_BLOCKS_MOVEMENT em furniture.ts) -- nos dois casos só
    // vira de frente pra direção pedida, sem "andar" de verdade.
    const blocked =
      (targetPos.x === this.localContainer.x && targetPos.y === this.localContainer.y) ||
      !!blockingFurnitureAt(target.col, target.row);
    if (blocked) {
      this.localContainer.setData("dir", dir);
      this.stopWalk(this.localContainer);
      return;
    }

    this.stepping = true;
    this.stepDir = dir;
    this.stepFrom = { x: this.localContainer.x, y: this.localContainer.y };
    this.stepTo = targetPos;
    this.stepElapsed = 0;
    this.playWalk(this.localContainer, dir);
  }

  update(_time: number, delta: number) {
    const inputDir = this.readInputDir();

    if (this.localActivity === "sentado") {
      if (inputDir) {
        // qualquer tecla de direção levanta -- o passo de verdade só
        // começa no próximo frame (já sai da cadeira "de pé" primeiro)
        this.standUp();
      }
      this.reportPosition(_time);
      return;
    }

    if (this.stepping) {
      this.stepElapsed += delta;
      const t = Math.min(1, this.stepElapsed / STEP_DURATION_MS);
      const x = Phaser.Math.Linear(this.stepFrom.x, this.stepTo.x, t);
      const y = Phaser.Math.Linear(this.stepFrom.y, this.stepTo.y, t);
      this.localContainer.setPosition(x, y);

      if (t >= 1) {
        this.stepping = false;
        this.localContainer.setPosition(this.stepTo.x, this.stepTo.y);
      }
    } else if (inputDir) {
      this.startStep(inputDir);
    } else {
      // totalmente parado (não só entre passos) -- só aqui checa auto-sentar
      this.stopWalk(this.localContainer);
      const chair = this.findChairAtCurrentTile();
      if (chair) this.sitAt(chair);
    }

    // profundidade recalculada todo frame (contínuo, mesmo no meio de um
    // passo) pra passar por trás/na frente dos móveis suavemente -- só
    // NÃO faz isso se acabou de sentar agora mesmo (sitAt já setou a
    // profundidade certa, inclusive a exceção de virado "up", e isso
    // sobrescreveria ela).
    // cast: TS estreita localActivity pra "idle" logo no topo desta
    // função (por causa do early-return no if de cima) e não enxerga que
    // sitAt() -- chamado poucas linhas acima, dentro do branch "parado"
    // -- pode ter mudado pra "sentado" nesse meio tempo; sem o cast, ele
    // acusa a comparação como "sempre falsa" (TS2367), o que não é
    // verdade em runtime.
    if ((this.localActivity as Activity) !== "sentado") {
      this.localContainer.setDepth(avatarDepthForY(this.localContainer.y));
    }

    this.reportPosition(_time);
  }

  upsertRemotePlayer(
    id: string,
    x: number,
    y: number,
    color: string,
    name: string,
    statusColor: string = "#4fd97a"
  ) {
    let container = this.remoteContainers.get(id);
    if (!container) {
      container = this.createAvatar(x, y, color, name, false, id, statusColor);
      this.remoteContainers.set(id, container);
    } else {
      this.setNameplate(container, name, statusColor);
      const dx = x - container.x;
      const dy = y - container.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 1) {
        this.playWalk(container, dx > 0 ? "right" : "left");
      } else if (Math.abs(dy) > 1) {
        this.playWalk(container, dy > 0 ? "down" : "up");
      } else {
        this.stopWalk(container);
      }
      const target = container;
      this.tweens.add({
        targets: container,
        x,
        y,
        duration: 90,
        ease: "Linear",
        // mesma profundidade dinâmica do boneco local (ver update()) --
        // jogador remoto também passa por trás/na frente dos móveis
        // conforme a fileira. Isso é só pro MOVIMENTO -- sentado, ele já
        // não manda mais "move" nenhum (fica parado), então esse tween
        // nem roda mais; a pose/profundidade especial de "sentado" (ver
        // comentário em sitAt) é ajustada à parte, por setRemoteSeat, ao
        // receber "seat" pela rede.
        onUpdate: () => target.setDepth(avatarDepthForY(target.y)),
        onComplete: () => this.stopWalk(target),
      });
    }
  }

  removeRemotePlayer(id: string) {
    const container = this.remoteContainers.get(id);
    if (container) {
      container.destroy();
      this.remoteContainers.delete(id);
    }
    // se ele tava sentado (dono de alguma mesa privada), some o nome
    // dele junto -- senão o dono continuaria aparecendo pra sempre numa
    // mesa depois que a pessoa já saiu da sala.
    if (this.remoteSeat.delete(id)) this.refreshAreaZones();
  }

  getLocalPosition() {
    return { x: this.localContainer.x, y: this.localContainer.y };
  }

  // ------------------------------------------------------------------
  // Editor de espaço -- API pública chamada de fora (GameRoom.tsx),
  // igual ao onLocalMove/upsertRemotePlayer já existentes.
  // ------------------------------------------------------------------

  /** Liga/desliga o modo de edição (mostra/esconde a grade, some com a seleção da paleta/piso). Os itens já colocados continuam na cena dos dois jeitos. */
  setEditMode(active: boolean) {
    this.editMode = active;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.gridGraphics?.setVisible(active);
    if (!active) this.hoverGraphics?.setVisible(false);
    // a tinta/contorno de área fica mais forte durante a edição (pra
    // pintar com precisão) e mais discreta no uso normal (só um lembrete
    // visual de onde a zona está) -- ver refreshAreaTileAlpha/
    // redrawAreaZoneBorders.
    this.refreshAreaTileAlpha();
    this.redrawAreaZoneBorders();
  }

  /** Escolhe qual item da paleta o próximo clique num tile livre vai colocar (null = nenhum selecionado, clique não faz nada em tile livre). Selecionar um item de móvel desarma as ferramentas de piso/área (ver selectFloorTool/selectAreaTool) -- só uma ferramenta ativa por vez. */
  selectCatalogEntry(entry: FurnitureCatalogEntry | null) {
    this.selectedCatalogEntry = entry;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
  }

  getDraftFurnitureList(): FurnitureDef[] {
    return Array.from(this.draftFurniture.values());
  }

  removeDraftFurniture(id: string) {
    this.draftSprites.get(id)?.destroy();
    this.draftSprites.delete(id);
    this.draftFurniture.delete(id);
    this.onDraftChange?.(this.getDraftFurnitureList());
  }

  clearDraftFurniture() {
    for (const sprite of this.draftSprites.values()) sprite.destroy();
    this.draftSprites.clear();
    this.draftFurniture.clear();
    this.onDraftChange?.(this.getDraftFurnitureList());
  }

  /** Escolhe a ferramenta de piso ativa: {kind:"paint", entry} pinta esse modelo, {kind:"erase"} apaga, null desarma. Escolher uma ferramenta de piso desarma o item de móvel/a ferramenta de área (ver selectCatalogEntry/selectAreaTool) -- só uma ferramenta ativa por vez. */
  selectFloorTool(tool: FloorTool) {
    this.selectedFloorTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedAreaTool = null;
  }

  getDraftFloorList(): FloorTileDef[] {
    return Array.from(this.draftFloor.values());
  }

  clearDraftFloor() {
    for (const sprite of this.draftFloorSprites.values()) sprite.destroy();
    this.draftFloorSprites.clear();
    this.draftFloor.clear();
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /** Escolhe a ferramenta de área ativa -- mesma ideia da selectFloorTool acima, {kind:"paint", type} pinta "mesa-privada"/"sala", {kind:"erase"} apaga. Desarma móvel/piso (só uma ferramenta ativa por vez). */
  selectAreaTool(tool: AreaTool) {
    this.selectedAreaTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
  }

  getDraftAreaList(): AreaTileDef[] {
    return Array.from(this.draftArea.values());
  }

  clearDraftArea() {
    for (const sprite of this.draftAreaSprites.values()) sprite.destroy();
    this.draftAreaSprites.clear();
    this.draftArea.clear();
    this.refreshAreaZones();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /**
   * Carrega a área já salva no servidor (ver GET /room/areas em
   * server/index.js) -- mesma ideia/timing do loadSavedFloor (chamado
   * pelo React assim que a cena fica pronta E a busca responder).
   */
  loadSavedAreas(items: AreaTileDef[]) {
    for (const a of items) {
      const key = `${a.col},${a.row}`;
      if (this.draftArea.has(key)) continue; // já carregado (ex: chamado 2x) -- não duplica sprite
      const rect = this.addAreaTileRect(a);
      this.draftArea.set(key, a);
      this.draftAreaSprites.set(key, rect);
    }
    this.refreshAreaZones();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /**
   * Consulta pura: em qual zona de área (se alguma) a posição em MUNDO
   * (x, y) cai -- devolve o id da zona ou null. Usado de fora
   * (checkProximity em GameRoom.tsx) tanto pra posição local quanto pra
   * cada jogador remoto, pra decidir isolamento de áudio/vídeo: dois
   * jogadores só se conectam por proximidade normal se NENHUM dos dois
   * estiver numa área; se algum estiver, só conectam se for a MESMA
   * zona.
   */
  areaZoneAt(x: number, y: number): string | null {
    const { col, row } = worldToTile(x, y);
    const zone = zoneAtTile(this.areaZones, col, row);
    return zone?.id ?? null;
  }

  /**
   * Atualiza o que o jogador REMOTO `id` tá sentado agora (ver "seat" no
   * protocolo de server/index.js) -- chamado pelo GameRoom.tsx a cada
   * mensagem "seat" recebida (própria ou já presente no "init"/"join").
   * `name` vem de fora (remotePlayersRef em GameRoom.tsx) porque aqui
   * dentro não existe um jeito direto de ler o nome de um container
   * remoto sem duplicar esse estado.
   *
   * Além de guardar o estado (usado por refreshAreaOwnership), também
   * ajusta a POSE do boneco remoto pra pose sentada do móvel (a posição
   * em si já chega certa pelo "move" de sempre, ver comentário no
   * protocolo -- só a pose/direção que não sincronizava antes, ver
   * comentário em upsertRemotePlayer).
   */
  setRemoteSeat(id: string, furnitureId: string | null, name: string) {
    this.remoteSeat.set(id, { furnitureId, name });
    if (furnitureId) {
      const furniture = this.furnitureById(furnitureId);
      const container = this.remoteContainers.get(id);
      if (furniture && container) {
        container.setData("dir", furniture.facing);
        this.setPoseFrame(container, SENTADO_FRAMES[furniture.facing]);
        container.setDepth(
          furniture.facing === "up"
            ? furnitureDepthForRow(furniture.row) - 1
            : avatarDepthForY(container.y)
        );
      }
    }
    this.refreshAreaZones();
  }

  /** Item de mobília (fixo OU rascunho) com esse id, se houver -- usado só pra achar em qual tile uma cadeira ocupada está (ver refreshAreaOwnership/setRemoteSeat). */
  private furnitureById(id: string): FurnitureDef | undefined {
    return ROOM_FURNITURE.find((f) => f.id === id) ?? this.draftFurniture.get(id);
  }

  /**
   * Pinta (ou apaga, se a ferramenta ativa for "erase") o tile col/row
   * com a ferramenta de piso selecionada -- chamado tanto por um clique
   * único quanto, repetidamente, durante um arrasto (ver
   * handleEditPointerDown/handleCameraPan... não, handleEditPointerMove
   * mais embaixo). Sem ferramenta selecionada, não faz nada.
   */
  private paintFloorAt(col: number, row: number) {
    const tool = this.selectedFloorTool;
    if (!tool) return;
    const key = `${col},${row}`;

    if (tool.kind === "erase") {
      const existing = this.draftFloor.get(key);
      if (!existing) return; // nada pintado aqui nesta sessão, não tem o que apagar
      this.draftFloorSprites.get(key)?.destroy();
      this.draftFloorSprites.delete(key);
      this.draftFloor.delete(key);
      this.onDraftFloorChange?.(this.getDraftFloorList());
      return;
    }

    const existing = this.draftFloor.get(key);
    if (existing && existing.styleId === tool.entry.id) return; // já pintado com o mesmo modelo, nada a fazer

    this.draftFloorSprites.get(key)?.destroy();
    const def: FloorTileDef = { col, row, styleId: tool.entry.id };
    const sprite = this.addFloorSprite(def);
    if (!sprite) return;
    this.draftFloor.set(key, def);
    this.draftFloorSprites.set(key, sprite);
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /**
   * Pinta (via paintFloorAt) cada tile ao longo da linha reta entre o
   * último tile pintado e o tile atual, não só o tile de chegada --
   * durante um arrasto rápido o pointermove pode "pular" um tile inteiro
   * sem nenhum evento disparando em cima dele (o quadrado tem 60px), o
   * que deixava buracos na pintura. Bresenham simples em coordenadas de
   * grade (col/row), não em pixels.
   */
  private paintFloorLine(fromCol: number, fromRow: number, toCol: number, toRow: number) {
    let x0 = fromCol;
    let y0 = fromRow;
    const dx = Math.abs(toCol - x0);
    const dy = -Math.abs(toRow - y0);
    const sx = x0 < toCol ? 1 : -1;
    const sy = y0 < toRow ? 1 : -1;
    let err = dx + dy;
    // limite de segurança -- a grade é pequena (12x7), nunca deveria
    // precisar de mais passos que isso; só evita um loop infinito se
    // algum bug futuro passar coordenadas malucas.
    for (let i = 0; i < 200; i++) {
      this.paintFloorAt(x0, y0);
      if (x0 === toCol && y0 === toRow) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Cria o retângulo de tinta de UM tile de área -- sem textura própria
   * (diferente do piso/mobília), é só uma cor chapada semi-transparente
   * (ver AREA_TYPES em game/areas.ts). Alpha depende do modo de edição
   * (mais forte editando, mais discreto no uso normal -- ver
   * refreshAreaTileAlpha).
   */
  private addAreaTileRect(a: AreaTileDef): Phaser.GameObjects.Rectangle {
    const pos = areaWorldPos(a);
    const meta = areaTypeMeta(a.type);
    return this.add
      .rectangle(pos.x, pos.y, TILE, TILE, meta.color, this.editMode ? 0.35 : 0.16)
      .setDepth(DEPTH_AREA);
  }

  /** Reaplica o alpha certo (editando vs. uso normal) em toda tinta de área já desenhada -- chamado ao ligar/desligar o modo de edição (ver setEditMode). */
  private refreshAreaTileAlpha() {
    const alpha = this.editMode ? 0.35 : 0.16;
    for (const rect of this.draftAreaSprites.values()) rect.setAlpha(alpha);
  }

  /**
   * Pinta (ou apaga) o tile col/row com a ferramenta de área selecionada --
   * mesma mecânica exata do paintFloorAt (clique único ou repetido
   * durante um arrasto, ver handleEditPointerMove/handleEditPointerDown).
   * Sem ferramenta selecionada, não faz nada.
   */
  private paintAreaAt(col: number, row: number) {
    const tool = this.selectedAreaTool;
    if (!tool) return;
    const key = `${col},${row}`;

    if (tool.kind === "erase") {
      const existing = this.draftArea.get(key);
      if (!existing) return;
      this.draftAreaSprites.get(key)?.destroy();
      this.draftAreaSprites.delete(key);
      this.draftArea.delete(key);
      this.refreshAreaZones();
      this.onDraftAreaChange?.(this.getDraftAreaList());
      return;
    }

    const existing = this.draftArea.get(key);
    if (existing && existing.type === tool.type) return; // já pintado com o mesmo tipo, nada a fazer

    this.draftAreaSprites.get(key)?.destroy();
    const def: AreaTileDef = { col, row, type: tool.type };
    const rect = this.addAreaTileRect(def);
    this.draftArea.set(key, def);
    this.draftAreaSprites.set(key, rect);
    this.refreshAreaZones();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /** Pinta (via paintAreaAt) cada tile ao longo da linha reta entre o último tile pintado e o atual -- mesmo Bresenham do paintFloorLine, pra não deixar buraco num arrasto rápido. */
  private paintAreaLine(fromCol: number, fromRow: number, toCol: number, toRow: number) {
    let x0 = fromCol;
    let y0 = fromRow;
    const dx = Math.abs(toCol - x0);
    const dy = -Math.abs(toRow - y0);
    const sx = x0 < toCol ? 1 : -1;
    const sy = y0 < toRow ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; i < 200; i++) {
      this.paintAreaAt(x0, y0);
      if (x0 === toCol && y0 === toRow) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Recalcula TUDO que depende da área pintada: as zonas em si
   * (computeAreaZones), o contorno de cada zona, quem é dono de cada
   * mesa privada, e o hover/nome de cada uma -- chamado toda vez que a
   * área muda (pintar/apagar/carregar) E toda vez que "quem tá sentado
   * onde" muda (sitAt/standUp locais, setRemoteSeat remoto), já que os
   * dois afetam quem é "dono". Ponto único de recálculo em vez de cada
   * chamador ter que lembrar de atualizar cada coisa na ordem certa.
   */
  private refreshAreaZones() {
    this.areaZones = computeAreaZones(this.getDraftAreaList());
    this.redrawAreaZoneBorders();
    this.refreshAreaOwnership();
    this.updateAreaHoverLabels();
  }

  /** Desenha (do zero) o contorno de cada zona -- um retângulo por zona, do canto superior-esquerdo ao inferior-direito dela (ver zoneBounds em game/areas.ts; numa zona não-retangular isso pode incluir algum tile de fora, simplificação aceitável pro uso esperado). Mais forte durante a edição, mais discreto no uso normal. */
  private redrawAreaZoneBorders() {
    for (const g of this.areaZoneBorderGfx) g.destroy();
    this.areaZoneBorderGfx = [];
    for (const zone of this.areaZones) {
      const meta = areaTypeMeta(zone.type);
      const { minCol, maxCol, minRow, maxRow } = zoneBounds(zone);
      const topLeft = tileToWorld(minCol, minRow);
      const bottomRight = tileToWorld(maxCol, maxRow);
      const g = this.add.graphics().setDepth(DEPTH_AREA);
      g.lineStyle(2, meta.color, this.editMode ? 0.85 : 0.35);
      g.strokeRect(
        topLeft.x - TILE / 2,
        topLeft.y - TILE / 2,
        bottomRight.x - topLeft.x + TILE,
        bottomRight.y - topLeft.y + TILE
      );
      this.areaZoneBorderGfx.push(g);
    }
  }

  /**
   * Recalcula quem é "dono" de cada zona "mesa-privada" agora: o dono é
   * quem estiver SENTADO numa cadeira (móvel) cujo tile caia dentro da
   * zona -- não é só "estar em cima do tile", é estar mesmo sentado (ver
   * comentário grande em game/areas.ts). O jogador LOCAL (this.seatedAt)
   * tem prioridade sobre um remoto que porventura conste sentado na
   * mesma zona (não deveria acontecer com 1 cadeira por mesa, é só uma
   * ordem de desempate defensiva).
   */
  private refreshAreaOwnership() {
    this.areaOwnerByZoneId.clear();

    if (this.seatedAt) {
      const zone = zoneAtTile(this.areaZones, this.seatedAt.col, this.seatedAt.row);
      if (zone && zone.type === "mesa-privada") {
        this.areaOwnerByZoneId.set(zone.id, { playerId: "local", name: this.localName });
      }
    }

    for (const [playerId, seat] of this.remoteSeat.entries()) {
      if (!seat.furnitureId) continue;
      const furniture = this.furnitureById(seat.furnitureId);
      if (!furniture) continue;
      const zone = zoneAtTile(this.areaZones, furniture.col, furniture.row);
      if (!zone || zone.type !== "mesa-privada") continue;
      if (this.areaOwnerByZoneId.has(zone.id)) continue;
      this.areaOwnerByZoneId.set(zone.id, { playerId, name: seat.name });
    }
  }

  /**
   * Cria/atualiza a hitbox de hover + o texto do nome de cada zona
   * "mesa-privada" -- o texto só FICA VISÍVEL ao passar o mouse em cima
   * (ver setAreaLabelVisible), e clicar nele (só quando tem dono e fora
   * do modo de edição) abre o card de perfil do dono (ver
   * onAreaOwnerClick). Zonas que sumiram (apagadas/mudaram de forma) têm
   * sua hitbox/label destruídos.
   */
  private updateAreaHoverLabels() {
    const activeZoneIds = new Set(this.areaZones.filter((z) => z.type === "mesa-privada").map((z) => z.id));

    for (const [zoneId, hitZone] of this.areaHoverZones.entries()) {
      if (activeZoneIds.has(zoneId)) continue;
      hitZone.destroy();
      this.areaHoverZones.delete(zoneId);
      this.areaNameLabels.get(zoneId)?.destroy();
      this.areaNameLabels.delete(zoneId);
    }

    for (const zone of this.areaZones) {
      if (zone.type !== "mesa-privada") continue;
      const { minCol, maxCol, minRow, maxRow } = zoneBounds(zone);
      const topLeft = tileToWorld(minCol, minRow);
      const bottomRight = tileToWorld(maxCol, maxRow);
      const centerX = (topLeft.x + bottomRight.x) / 2;
      const centerY = (topLeft.y + bottomRight.y) / 2;
      const width = bottomRight.x - topLeft.x + TILE;
      const height = bottomRight.y - topLeft.y + TILE;
      const labelX = centerX;
      const labelY = topLeft.y - TILE / 2 - 4;

      let hitZone = this.areaHoverZones.get(zone.id);
      if (!hitZone) {
        hitZone = this.add
          .zone(centerX, centerY, width, height)
          .setDepth(DEPTH_AREA_HOVER)
          .setInteractive({ cursor: "pointer" });
        const zoneId = zone.id;
        hitZone.on("pointerover", () => this.setAreaLabelVisible(zoneId, true));
        hitZone.on("pointerout", () => this.setAreaLabelVisible(zoneId, false));
        hitZone.on("pointerdown", () => {
          // igual ao clique de avatar: nada durante a edição, nem com o
          // card de perfil já aberto por cima (ver avatarClicksLocked).
          if (this.editMode || this.avatarClicksLocked) return;
          const owner = this.areaOwnerByZoneId.get(zoneId);
          if (!owner) return;
          this.onAreaOwnerClick?.({ playerId: owner.playerId, isLocal: owner.playerId === "local" });
        });
        this.areaHoverZones.set(zone.id, hitZone);
      } else {
        hitZone.setPosition(centerX, centerY);
        hitZone.setSize(width, height);
      }

      const owner = this.areaOwnerByZoneId.get(zone.id);
      let label = this.areaNameLabels.get(zone.id);
      if (!label) {
        label = this.add
          .text(labelX, labelY, owner?.name ?? "", {
            fontFamily: "sans-serif",
            fontSize: "13px",
            color: "#ffffff",
            backgroundColor: "#00000099",
            padding: { x: 6, y: 2 },
          })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH_AREA_LABEL)
          .setVisible(false);
        this.areaNameLabels.set(zone.id, label);
      } else {
        label.setPosition(labelX, labelY);
        label.setText(owner?.name ?? "");
      }
    }
  }

  private setAreaLabelVisible(zoneId: string, visible: boolean) {
    const owner = this.areaOwnerByZoneId.get(zoneId);
    const label = this.areaNameLabels.get(zoneId);
    if (!label) return;
    label.setVisible(visible && !!owner);
  }

  /** Desenha o contorno de TODO tile colocável (mesmos limites que clampTile usa pro boneco) -- só visível durante o modo de edição. */
  private drawEditGrid() {
    const g = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(false);
    g.lineStyle(1, 0xffffff, 0.25);
    for (let col = 0; col <= GRID_COLS; col++) {
      for (let row = 0; row <= GRID_ROWS; row++) {
        const { x, y } = tileToWorld(col, row);
        g.strokeRect(x - TILE / 2, y - TILE / 2, TILE, TILE);
      }
    }
    this.gridGraphics = g;
  }

  /** Item (fixo OU rascunho) já ancorado nesse tile, se houver -- editor não deixa empilhar dois móveis na mesma âncora (evita duas sprites sobrepostas confundindo o preview). */
  private anyFurnitureAt(col: number, row: number): boolean {
    if (ROOM_FURNITURE.some((f) => f.col === col && f.row === row)) return true;
    for (const f of this.draftFurniture.values()) {
      if (f.col === col && f.row === row) return true;
    }
    return false;
  }

  private draftIdAt(col: number, row: number): string | null {
    for (const [id, f] of this.draftFurniture.entries()) {
      if (f.col === col && f.row === row) return id;
    }
    return null;
  }

  private handleEditPointerMove(pointer: Phaser.Input.Pointer) {
    if (!this.editMode || !this.hoverGraphics) return;
    // worldX/worldY (não pointer.x/y) -- pointer.x/y é a posição na TELA
    // (câmera), só bate com a posição no MUNDO por coincidência no zoom
    // padrão (1x, sem arrastar a câmera); com os controles de zoom/pan
    // do mapa (ver MapControls em GameRoom.tsx) os dois divergem, e o
    // tile calculado ficava errado assim que zoomava ou arrastava a
    // câmera -- inclusive plausivelmente a causa do piso "não pintar"
    // que o Douglas viu, se ele tinha zoomado/arrastado o mapa antes.
    const { col, row } = worldToTile(pointer.worldX, pointer.worldY);
    const inBounds = col >= 0 && col <= GRID_COLS && row >= 0 && row <= GRID_ROWS;
    if (!inBounds) {
      this.hoverGraphics.setVisible(false);
      return;
    }

    // arrastar com a ferramenta de piso armada pinta CADA tile novo que
    // o cursor entra durante o arrasto (não só onde o botão foi
    // pressionado) -- é o "arrastando" que o Douglas pediu, em vez de só
    // o clique único ("unitário"). paintFloorLine (não só paintFloorAt no
    // tile atual) preenche também os tiles PULADOS entre um evento de
    // pointermove e o outro -- o quadrado (60px) é grande o suficiente
    // pra um arrasto normal "pular" um inteiro sem disparar um evento
    // bem em cima dele, o que deixava buracos na pintura.
    if (this.isPaintingFloor && pointer.isDown && this.selectedFloorTool) {
      const key = `${col},${row}`;
      if (key !== this.lastPaintedFloorKey) {
        const [lastCol, lastRow] = this.lastPaintedFloorKey
          ? this.lastPaintedFloorKey.split(",").map(Number)
          : [col, row];
        this.lastPaintedFloorKey = key;
        this.paintFloorLine(lastCol, lastRow, col, row);
      }
    }

    // mesmo esquema de arrasto acima, só que pra ferramenta de área (ver
    // paintAreaLine).
    if (this.isPaintingArea && pointer.isDown && this.selectedAreaTool) {
      const key = `${col},${row}`;
      if (key !== this.lastPaintedAreaKey) {
        const [lastCol, lastRow] = this.lastPaintedAreaKey
          ? this.lastPaintedAreaKey.split(",").map(Number)
          : [col, row];
        this.lastPaintedAreaKey = key;
        this.paintAreaLine(lastCol, lastRow, col, row);
      }
    }

    const occupied = this.anyFurnitureAt(col, row);
    const { x, y } = tileToWorld(col, row);
    this.hoverGraphics
      .clear()
      .fillStyle(occupied ? EDIT_HOVER_COLOR_OCCUPIED : EDIT_HOVER_COLOR_FREE, 0.35)
      .fillRect(x - TILE / 2, y - TILE / 2, TILE, TILE)
      .setVisible(true);
  }

  /**
   * Clique num tile durante o modo de edição: se o tile já tem um item
   * RASCUNHO (colocado nesta sessão), remove ele -- senão, se tiver um
   * item da paleta selecionado e o tile estiver livre (sem móvel fixo
   * nem rascunho), coloca uma cópia nova ali. Clicar num tile ocupado
   * por móvel FIXO (ROOM_FURNITURE) não faz nada -- esses não são
   * editáveis por aqui.
   */
  /** Verdadeiro se o clique caiu em cima de QUALQUER avatar (local ou remoto) -- usado pra não colocar/remover móvel do editor por baixo de um clique que era pra abrir o card de perfil (ver onAvatarClick). */
  private isPointerOnAnyAvatar(pointer: Phaser.Input.Pointer): boolean {
    const containers: (Phaser.GameObjects.Container | undefined)[] = [
      this.localContainer,
      ...this.remoteContainers.values(),
    ];
    for (const c of containers) {
      if (!c) continue;
      const hitArea = c.input?.hitArea as Phaser.Geom.Rectangle | undefined;
      if (!hitArea) continue;
      // containers não têm rotação/escala própria aqui -- ponto local é
      // só a diferença direto, sem precisar de matriz de transformação.
      // worldX/worldY (não pointer.x/y) pelo mesmo motivo do
      // handleEditPointerMove -- c.x/c.y são posição no MUNDO, então o
      // ponteiro precisa estar no mesmo espaço pra diferença bater.
      const localX = pointer.worldX - c.x;
      const localY = pointer.worldY - c.y;
      if (Phaser.Geom.Rectangle.Contains(hitArea, localX, localY)) return true;
    }
    return false;
  }

  private handleEditPointerDown(pointer: Phaser.Input.Pointer) {
    if (!this.editMode) return;
    if (this.isPointerOnAnyAvatar(pointer)) return;
    const { col, row } = worldToTile(pointer.worldX, pointer.worldY);
    if (col < 0 || col > GRID_COLS || row < 0 || row > GRID_ROWS) return;

    // ferramenta de área armada: mesma ideia da ferramenta de piso logo
    // abaixo (clique único já pinta e entra em modo de arrasto) -- checa
    // ANTES do piso só por ordem de leitura, as duas são mutuamente
    // exclusivas mesmo (ver selectAreaTool/selectFloorTool), nunca as
    // duas armadas ao mesmo tempo.
    if (this.selectedAreaTool) {
      this.isPaintingArea = true;
      this.lastPaintedAreaKey = `${col},${row}`;
      this.paintAreaAt(col, row);
      return;
    }

    // ferramenta de piso armada: pinta/apaga esse tile (clique único --
    // "unitário") e já entra em modo de arrasto (ver
    // handleEditPointerMove) pra continuar pintando se o mouse continuar
    // pressionado e se mover; NÃO cai no fluxo de móvel abaixo.
    if (this.selectedFloorTool) {
      this.isPaintingFloor = true;
      this.lastPaintedFloorKey = `${col},${row}`;
      this.paintFloorAt(col, row);
      return;
    }

    const draftId = this.draftIdAt(col, row);
    if (draftId) {
      this.removeDraftFurniture(draftId);
      return;
    }

    const entry = this.selectedCatalogEntry;
    if (!entry || this.anyFurnitureAt(col, row)) return;

    const id = `${entry.type}-draft-${Date.now()}-${Math.round(Math.random() * 999)}`;
    const def: FurnitureDef = {
      id,
      type: entry.type,
      col,
      row,
      facing: entry.facing,
      seatOffsetY: entry.seatOffsetY,
      seatOffsetX: entry.seatOffsetX,
      baseOffsetY: entry.baseOffsetY,
    };
    const sprite = this.addFurnitureSprite(def);
    this.draftFurniture.set(id, def);
    this.draftSprites.set(id, sprite);
    this.onDraftChange?.(this.getDraftFurnitureList());
  }
}
