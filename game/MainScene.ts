import Phaser from "phaser";

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
 * Cada avatar é composto por DUAS sprites empilhadas: "avatar-skin" (pele,
 * cabelo, rosto, sapato — sempre igual pra todo mundo) e "avatar-clothes"
 * (tronco, braços, pernas — recebe um tint com a cor do jogador). Assim a
 * cor de identificação de cada jogador só pinta a roupa, não a cabeça toda.
 */
export default class MainScene extends Phaser.Scene {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

  private localContainer!: Phaser.GameObjects.Container;
  private remoteContainers: Map<string, Phaser.GameObjects.Container> = new Map();

  private lastSent = 0;
  private readonly speed = 150;
  private readonly bounds = { minX: 40, maxX: 760, minY: 108, maxY: 570 };

  /** Definido de fora (GameRoom.tsx) após a cena ficar pronta. */
  onLocalMove?: (x: number, y: number) => void;

  localColor = "#5c9bff";
  localName = "Você";

  constructor() {
    super("main");
  }

  preload() {
    this.load.spritesheet("avatar-skin", "/assets/avatar_skin.png", {
      frameWidth: 72,
      frameHeight: 72,
    });
    this.load.spritesheet("avatar-clothes", "/assets/avatar_clothes.png", {
      frameWidth: 72,
      frameHeight: 72,
    });
    this.load.image("room", "/assets/room.png");
  }

  create() {
    this.add.image(400, 300, "room").setOrigin(0.5);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

    this.createAnimations();

    this.localContainer = this.createAvatar(400, 470, this.localColor, this.localName);
  }

  private createAnimations() {
    if (this.anims.exists("walk-down-skin")) return;
    const dirs: Array<[string, number]> = [
      ["down", 0],
      ["left", 4],
      ["right", 8],
      ["up", 12],
    ];
    for (const [dir, start] of dirs) {
      for (const layer of ["skin", "clothes"] as const) {
        this.anims.create({
          key: `walk-${dir}-${layer}`,
          frames: this.anims.generateFrameNumbers(`avatar-${layer}`, { start, end: start + 3 }),
          frameRate: 8,
          repeat: -1,
        });
      }
    }
  }

  private createAvatar(
    x: number,
    y: number,
    color: string,
    name: string
  ): Phaser.GameObjects.Container {
    // a pele fica embaixo, sem tint (sempre a mesma cor pra todo mundo)
    const skinSprite = this.add.sprite(0, 0, "avatar-skin", 0);
    // a roupa fica em cima, com o tint da cor do jogador
    const clothesSprite = this.add.sprite(0, 0, "avatar-clothes", 0);
    clothesSprite.setTint(Phaser.Display.Color.HexStringToColor(color).color);

    const label = this.add
      .text(0, -46, name, {
        fontSize: "11px",
        color: "#ffffff",
        fontFamily: "monospace",
        backgroundColor: "#00000088",
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5);

    const container = this.add.container(x, y, [skinSprite, clothesSprite, label]);
    container.setSize(48, 48);
    container.setData("skinSprite", skinSprite);
    container.setData("clothesSprite", clothesSprite);
    container.setData("label", label);
    return container;
  }

  private playWalk(container: Phaser.GameObjects.Container, dir: "down" | "left" | "right" | "up") {
    const skinSprite = container.getData("skinSprite") as Phaser.GameObjects.Sprite;
    const clothesSprite = container.getData("clothesSprite") as Phaser.GameObjects.Sprite;
    skinSprite.anims.play(`walk-${dir}-skin`, true);
    clothesSprite.anims.play(`walk-${dir}-clothes`, true);
  }

  private stopWalk(container: Phaser.GameObjects.Container) {
    const skinSprite = container.getData("skinSprite") as Phaser.GameObjects.Sprite;
    const clothesSprite = container.getData("clothesSprite") as Phaser.GameObjects.Sprite;
    skinSprite.anims.stop();
    clothesSprite.anims.stop();
  }

  update(_time: number, delta: number) {
    const left = this.cursors.left?.isDown || this.wasd.left.isDown;
    const right = this.cursors.right?.isDown || this.wasd.right.isDown;
    const up = this.cursors.up?.isDown || this.wasd.up.isDown;
    const down = this.cursors.down?.isDown || this.wasd.down.isDown;

    let vx = 0;
    let vy = 0;
    if (left) vx -= 1;
    if (right) vx += 1;
    if (up) vy -= 1;
    if (down) vy += 1;

    if (vx !== 0 || vy !== 0) {
      const len = Math.hypot(vx, vy);
      vx /= len;
      vy /= len;
      const dt = delta / 1000;

      let nx = this.localContainer.x + vx * this.speed * dt;
      let ny = this.localContainer.y + vy * this.speed * dt;
      nx = Phaser.Math.Clamp(nx, this.bounds.minX, this.bounds.maxX);
      ny = Phaser.Math.Clamp(ny, this.bounds.minY, this.bounds.maxY);
      this.localContainer.setPosition(nx, ny);

      if (Math.abs(vx) > Math.abs(vy)) {
        this.playWalk(this.localContainer, vx > 0 ? "right" : "left");
      } else {
        this.playWalk(this.localContainer, vy > 0 ? "down" : "up");
      }
    } else {
      this.stopWalk(this.localContainer);
    }

    if (_time - this.lastSent > 50) {
      this.lastSent = _time;
      this.onLocalMove?.(this.localContainer.x, this.localContainer.y);
    }
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
