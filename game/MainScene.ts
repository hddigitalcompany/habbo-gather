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
import { HAIR_CATALOG, DEFAULT_HAIR_ID } from "./customization";

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
 * camiseta, casaco, calça, tênis) é OUTRO spritesheet separado, desenhado
 * empilhado por cima, na mesma posição e MESMO frame que o base (ver
 * LAYER_DRAW_ORDER mais abaixo). Isso troca o sistema anterior de "um
 * visual = uma imagem só" pelo esquema modular pedido: cada peça pode
 * ser adicionada/trocada independente, e o boneco base fica padronizado.
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
 * Hoje só a camada "base" tem arte de verdade; as outras (cabelo, barba,
 * óculos, camiseta, casaco, calça, tênis) entram em LAYER_TEXTURE_FILE
 * conforme a arte for chegando -- cada uma precisa ser processada pelo
 * mesmo pipeline (chroma-key, normalização, alinhamento) do base, pra
 * bater exatamente o mesmo frame/pose/escala.
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
  "calca",
  "tenis",
  "camiseta",
  "casaco",
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
 * "cabelo" é DIFERENTE das outras -- não é mais um arquivo único, e sim
 * um CATÁLOGO de opções (ver game/customization.ts / HAIR_CATALOG),
 * porque dá pra trocar de penteado ao vivo (editor de personagem, ver
 * setLocalHairId). O valor `null` aqui continua só pra manter o record
 * completo/tipado -- a arte de cabelo de verdade é carregada à parte,
 * ver preload() e createAvatar().
 */
const LAYER_TEXTURE_FILE: Record<LayerKey, string | null> = {
  base: "avatar_visual1.png",
  calca: null,
  tenis: null,
  camiseta: null,
  casaco: null,
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

// depois de levantar (por movimento), ignora o auto-sentar por um
// instante -- senão sentaria de novo assim que parasse ainda em cima
// do mesmo tile da cadeira.
const STAND_COOLDOWN_MS = 350;

// tempo pra andar UM quadrado (grade tile a tile, não pixel livre)
const STEP_DURATION_MS = 180;

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

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em QUALQUER avatar (local ou remoto), pra abrir o card de perfil. */
  onAvatarClick?: (info: { playerId: string; isLocal: boolean; name: string; color: string }) => void;

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
    // (ver setLocalHairId, chamado pelo editor de personagem).
    for (const opt of HAIR_CATALOG) {
      this.load.spritesheet(hairTextureKey(opt.id), `/assets/${opt.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
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
  }

  create() {
    this.add.image(400, 300, "room").setOrigin(0.5);

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

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => this.handleEditPointerMove(pointer));
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handleEditPointerDown(pointer));
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
    // "cabelo" é especial: sempre entra (tem catálogo de verdade agora,
    // ver HAIR_CATALOG), começando na opção padrão -- guarda a própria
    // Sprite à parte (hairSprite) pra dar pra trocar de textura DEPOIS
    // sem recriar o boneco inteiro (ver setLocalHairId).
    const layerSprites: Phaser.GameObjects.Sprite[] = [];
    let hairSprite: Phaser.GameObjects.Sprite | null = null;
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

    const container = this.add.container(x, y, [...layerSprites, label, statusDot]);
    const dispW = layerSprites[0].displayWidth;
    const dispH = layerSprites[0].displayHeight;
    container.setSize(dispW, dispH);
    container.setDepth(avatarDepthForY(y));
    container.setData("layers", layerSprites);
    container.setData("label", label);
    container.setData("statusDot", statusDot);
    container.setData("dir", "down" as Direction);
    container.setData("stepToggle", false);
    container.setData("hairSprite", hairSprite);
    container.setData("hairId", DEFAULT_HAIR_ID);
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
      this.onAvatarClick?.({ playerId, isLocal, name, color });
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

  /** Troca o penteado do jogador LOCAL ao vivo (ver HAIR_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalHairId(hairId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("hairSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(hairTextureKey(hairId), currentFrame);
    this.localContainer.setData("hairId", hairId);
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
        // conforme a fileira. Remoto ainda não sincroniza "sentado" pela
        // rede, então sempre usa a regra geral aqui.
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
  }

  getLocalPosition() {
    return { x: this.localContainer.x, y: this.localContainer.y };
  }

  // ------------------------------------------------------------------
  // Editor de espaço -- API pública chamada de fora (GameRoom.tsx),
  // igual ao onLocalMove/upsertRemotePlayer já existentes.
  // ------------------------------------------------------------------

  /** Liga/desliga o modo de edição (mostra/esconde a grade, some com a seleção da paleta). Os itens já colocados continuam na cena dos dois jeitos. */
  setEditMode(active: boolean) {
    this.editMode = active;
    this.selectedCatalogEntry = null;
    this.gridGraphics?.setVisible(active);
    if (!active) this.hoverGraphics?.setVisible(false);
  }

  /** Escolhe qual item da paleta o próximo clique num tile livre vai colocar (null = nenhum selecionado, clique não faz nada em tile livre). */
  selectCatalogEntry(entry: FurnitureCatalogEntry | null) {
    this.selectedCatalogEntry = entry;
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
    const { col, row } = worldToTile(pointer.x, pointer.y);
    const inBounds = col >= 0 && col <= GRID_COLS && row >= 0 && row <= GRID_ROWS;
    if (!inBounds) {
      this.hoverGraphics.setVisible(false);
      return;
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
      // só a diferença direto, sem precisar de matriz de transformação
      const localX = pointer.x - c.x;
      const localY = pointer.y - c.y;
      if (Phaser.Geom.Rectangle.Contains(hitArea, localX, localY)) return true;
    }
    return false;
  }

  private handleEditPointerDown(pointer: Phaser.Input.Pointer) {
    if (!this.editMode) return;
    if (this.isPointerOnAnyAvatar(pointer)) return;
    const { col, row } = worldToTile(pointer.x, pointer.y);
    if (col < 0 || col > GRID_COLS || row < 0 || row > GRID_ROWS) return;

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
