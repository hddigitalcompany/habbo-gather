"""Gera assets placeholder em pixel art (piso da sala + spritesheet do avatar).
Rode com: python3 scripts/generate_assets.py
"""
from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
os.makedirs(OUT_DIR, exist_ok=True)

# ---------- FUNDO DA SALA ----------
W, H = 800, 600
room = Image.new("RGB", (W, H), (26, 16, 41))
draw = ImageDraw.Draw(room)

TILE = 32
FLOOR_A = (58, 42, 82)
FLOOR_B = (68, 50, 96)
WALL = (32, 20, 52)
WALL_SHADOW = (22, 13, 38)
RUG = (120, 60, 130)
RUG_BORDER = (150, 90, 160)

wall_h = 96
for x in range(0, W, TILE):
    for y in range(wall_h, H, TILE):
        color = FLOOR_A if ((x // TILE) + (y // TILE)) % 2 == 0 else FLOOR_B
        draw.rectangle([x, y, x + TILE - 1, y + TILE - 1], fill=color)

draw.rectangle([0, 0, W, wall_h], fill=WALL)
draw.rectangle([0, wall_h - 6, W, wall_h], fill=WALL_SHADOW)
for x in range(0, W, TILE):
    draw.rectangle([x, 8, x + TILE - 6, wall_h - 12], outline=(45, 30, 68), width=2)

rug_x0, rug_y0, rug_x1, rug_y1 = 280, 260, 520, 420
draw.rectangle([rug_x0, rug_y0, rug_x1, rug_y1], fill=RUG)
draw.rectangle([rug_x0, rug_y0, rug_x1, rug_y1], outline=RUG_BORDER, width=4)

# planta (esquerda)
px_, py_ = 80, 160
draw.rectangle([px_ - 4, py_ + 30, px_ + 20, py_ + 50], fill=(90, 60, 40))
for dx, dy in [(-14, -10), (0, -24), (14, -10), (-6, -18), (8, -18)]:
    draw.ellipse([px_ + dx, py_ + dy, px_ + dx + 22, py_ + dy + 22], fill=(40, 120, 70))

# mesa (direita)
tx, ty = 640, 200
draw.rectangle([tx - 40, ty, tx + 40, ty + 12], fill=(110, 75, 45))
draw.rectangle([tx - 34, ty + 12, tx - 24, ty + 50], fill=(80, 55, 32))
draw.rectangle([tx + 24, ty + 12, tx + 34, ty + 50], fill=(80, 55, 32))

room.save(os.path.join(OUT_DIR, "room.png"))

# ---------- SPRITESHEET DO AVATAR ----------
# Estilo pixel art "blocado" (grade lógica pequena, escalada sem suavização —
# igual ao jeito que os avatares do Habbo são desenhados: cabeça grande,
# corpo pequeno, contornos nítidos).
GRID = 16              # grade lógica: 16x16 "pixels" por frame
SCALE = 3               # cada pixel lógico vira um quadrado de 3x3 pixels reais
FRAME = GRID * SCALE    # 48x48 por frame

BODY_LIGHT = (240, 240, 245, 255)   # lado claro do corpo/cabeça — recebe a cor do jogador
BODY_SHADOW = (176, 176, 188, 255)  # lado sombra — fica uma versão mais escura da mesma cor
HAIR = (42, 32, 27, 255)
EYE = (20, 16, 25, 255)
SHOE = (32, 25, 36, 255)


def new_grid():
    return [[None] * GRID for _ in range(GRID)]


def fill(grid, x0, y0, x1, y1, color):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= x < GRID and 0 <= y < GRID:
                grid[y][x] = color


def dot(grid, x, y, color):
    if 0 <= x < GRID and 0 <= y < GRID:
        grid[y][x] = color


def build_frame(direction, step):
    """step 0/2 = parado, 1/3 = meio-passo (pernas e braços alternando)."""
    g = new_grid()

    # cabeça (grande, estilo chibi) — metade direita sombreada pra dar volume
    fill(g, 4, 1, 11, 8, BODY_LIGHT)
    fill(g, 8, 1, 11, 8, BODY_SHADOW)
    for cx, cy in [(4, 1), (11, 1), (4, 8), (11, 8)]:
        dot(g, cx, cy, None)  # arredonda os 4 cantos da cabeça

    # cabelo
    fill(g, 4, 0, 11, 2, HAIR)
    dot(g, 4, 0, None)
    dot(g, 11, 0, None)
    fill(g, 4, 3, 4, 4, HAIR)   # costeleta esquerda
    fill(g, 11, 3, 11, 4, HAIR)  # costeleta direita

    if direction == "up":
        # de costas: cabelo cobre mais a cabeça, sem rosto
        fill(g, 4, 3, 11, 5, HAIR)
    elif direction == "down":
        dot(g, 6, 5, EYE)
        dot(g, 9, 5, EYE)
    elif direction == "left":
        dot(g, 6, 5, EYE)
    elif direction == "right":
        dot(g, 9, 5, EYE)

    # tronco
    fill(g, 4, 9, 11, 12, BODY_LIGHT)
    fill(g, 8, 9, 11, 12, BODY_SHADOW)

    # braços — balançam alternadamente durante o passo
    arm_l = 1 if step == 1 else 0
    arm_r = 1 if step == 3 else 0
    fill(g, 3, 9 + arm_l, 3, 11 + arm_l, BODY_LIGHT)
    fill(g, 12, 9 + arm_r, 12, 11 + arm_r, BODY_SHADOW)

    # pernas — uma "encolhe" (perna levantada) enquanto anda
    left_fwd = step == 1
    right_fwd = step == 3
    leg_l_bottom = 14 if right_fwd else 15
    leg_r_bottom = 14 if left_fwd else 15

    fill(g, 5, 13, 6, leg_l_bottom, BODY_LIGHT)
    fill(g, 9, 13, 10, leg_r_bottom, BODY_SHADOW)

    # sapatos
    fill(g, 5, leg_l_bottom, 6, leg_l_bottom, SHOE)
    fill(g, 9, leg_r_bottom, 10, leg_r_bottom, SHOE)

    return g


def rasterize(grid):
    img = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    for y in range(GRID):
        for x in range(GRID):
            color = grid[y][x]
            if color:
                img.paste(color, (x * SCALE, y * SCALE, x * SCALE + SCALE, y * SCALE + SCALE))
    return img


sheet = Image.new("RGBA", (FRAME * 4, FRAME * 4), (0, 0, 0, 0))
for row, direction in enumerate(["down", "left", "right", "up"]):
    for col in range(4):
        frame_img = rasterize(build_frame(direction, col))
        sheet.paste(frame_img, (col * FRAME, row * FRAME), frame_img)

sheet.save(os.path.join(OUT_DIR, "avatar.png"))

print("Assets gerados em", OUT_DIR, f"(avatar: {FRAME}x{FRAME} por frame)")
