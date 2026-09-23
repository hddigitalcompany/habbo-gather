// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import {
  ROOM_FURNITURE,
  FurnitureDef,
  furnitureWorldPos,
  furnitureTextureKey,
  furnitureArtFile,
} from "./furniture";
import { clampTile, tileToWorld, worldToTile, Direction } from "./grid";

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

// profundidade (z-order) do móvel e do boneco -- normalmente o boneco
// desenha NA FRENTE do móvel (sentado "aparecendo" na cadeira). Só quando
// senta virado "up" (de costas pra câmera, encosto da poltrona entre ele
// e quem olha) é que isso inverte: o móvel vai pra frente, escondendo o
// corpo e deixando só a cabeça à mostra por cima do encosto -- ver sitAt.
const DEPTH_FURNITURE = 5;
const DEPTH_AVATAR_FRONT = 10;
const DEPTH_AVATAR_BEHIND_FURNITURE = 1;

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

  constructor() {
    super("main");
  }

  preload() {
    // carrega o spritesheet de cada camada que já tem arte definida em
    // LAYER_TEXTURE_FILE (as com valor `null` ficam de fora até a arte
    // chegar -- ver createAvatar, que também só desenha as camadas
    // carregadas).
    for (const layer of LAYER_DRAW_ORDER) {
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
    this.load.image("room", "/assets/room.png");

    // carrega a arte de cada móvel: uma imagem por tipo+direção (ex:
    // "poltrona" virada "left" usa poltrona_lado_esq.png), uma vez só
    // por combinação mesmo que vários móveis repitam tipo/direção.
    const loadedFurniture = new Set<string>();
    for (const f of ROOM_FURNITURE) {
      const key = furnitureTextureKey(f.type, f.facing);
      if (loadedFurniture.has(key)) continue;
      loadedFurniture.add(key);
      const file = furnitureArtFile(f.type, f.facing);
      if (!file) continue;
      this.load.image(key, `/assets/${file}`);
    }
  }

  create() {
    this.add.image(400, 300, "room").setOrigin(0.5);

    for (const f of ROOM_FURNITURE) {
      // origem embaixo-centro, igual ao avatar: a posição do móvel é o
      // pontinho onde ele "toca o chão", alinhado ao tile dele
      const pos = furnitureWorldPos(f);
      this.add
        .image(pos.x, pos.y, furnitureTextureKey(f.type, f.facing))
        .setOrigin(0.5, 1)
        .setDepth(DEPTH_FURNITURE);
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

    const spawn = tileToWorld(6, 4);
    this.localContainer = this.createAvatar(spawn.x, spawn.y, this.localColor, this.localName);
  }

  private createAvatar(
    x: number,
    y: number,
    color: string,
    name: string
  ): Phaser.GameObjects.Container {
    // uma Sprite por camada EQUIPADA (só as que já têm arte carregada em
    // LAYER_TEXTURE_FILE), empilhadas na ordem de LAYER_DRAW_ORDER --
    // todas na mesma posição/frame, então de longe parecem um boneco só.
    const layerSprites: Phaser.GameObjects.Sprite[] = [];
    for (const layer of LAYER_DRAW_ORDER) {
      if (!LAYER_TEXTURE_FILE[layer]) continue;
      const sprite = this.add.sprite(0, 0, layerTextureKey(layer), WALK_FRAMES.down[0]);
      // origem embaixo-centro: o "pé" do boneco fica no (0,0) do
      // container, que é a posição lógica dele na sala (chão)
      sprite.setOrigin(0.5, 1);
      sprite.setScale(AVATAR_SCALE);
      layerSprites.push(sprite);
    }

    const label = this.add
      .text(0, -layerSprites[0].displayHeight - 8, name, {
        fontSize: "11px",
        color: "#ffffff",
        fontFamily: "monospace",
        backgroundColor: "#00000088",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5);

    const container = this.add.container(x, y, [...layerSprites, label]);
    container.setSize(layerSprites[0].displayWidth, layerSprites[0].displayHeight);
    container.setDepth(DEPTH_AVATAR_FRONT);
    container.setData("layers", layerSprites);
    container.setData("label", label);
    container.setData("dir", "down" as Direction);
    container.setData("stepToggle", false);
    return container;
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
    this.localContainer.setDepth(DEPTH_AVATAR_FRONT);
    this.stopWalk(this.localContainer);
  }

  /** Senta automaticamente no móvel passado (chamado ao PARAR no tile dele). */
  private sitAt(furniture: FurnitureDef) {
    const pos = furnitureWorldPos(furniture);
    this.localActivity = "sentado";
    this.seatedAt = furniture;
    this.localContainer.setPosition(pos.x, pos.y + (furniture.seatOffsetY ?? 0));
    // a pose sentada segue a direção que o móvel "olha" (facing), não a
    // direção que o jogador estava andando antes de sentar
    this.localContainer.setData("dir", furniture.facing);
    this.setPoseFrame(this.localContainer, SENTADO_FRAMES[furniture.facing]);
    // virado "up" (de costas pra câmera): o móvel fica NA FRENTE do
    // boneco, então só a cabeça aparece por cima do encosto -- nas
    // outras direções o boneco continua na frente, sentado "visível"
    // dentro/sobre o móvel normalmente.
    this.localContainer.setDepth(
      furniture.facing === "up" ? DEPTH_AVATAR_BEHIND_FURNITURE : DEPTH_AVATAR_FRONT
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
      if (f.col === col && f.row === row) return f;
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

  /** Tecla de direção pressionada agora, só uma por vez (sem diagonal). */
  private readInputDir(): Direction | null {
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

    // bateu na borda do mapa (destino = posição atual) -- só vira de
    // frente pra direção pedida, sem "andar" de verdade
    if (targetPos.x === this.localContainer.x && targetPos.y === this.localContainer.y) {
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

    this.reportPosition(_time);
  }

  upsertRemotePlayer(id: string, x: number, y: number, color: string, name: string) {
    let container = this.remoteContainers.get(id);
    if (!container) {
      container = this.createAvatar(x, y, color, name);
      this.remoteContainers.set(id, container);
    } else {
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
}
