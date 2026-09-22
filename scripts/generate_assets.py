"""Gera assets placeholder em pixel art (piso da sala + spritesheets do avatar).
Rode com: python3 scripts/generate_assets.py

O avatar é feito de DUAS spritesheets separadas, do jeito que o Habbo faz:
uma camada de "pele" (cabelo, rosto, nariz, pescoço, sapato — sempre igual
pra todo mundo) e uma camada de "roupa" (tronco, braços, pernas — recebe a
cor de cada jogador via tint). A grade lógica é 24x24, escalada sem
suavização pra manter o visual "pixel art" nítido, com uma coluna de
dithering na transição luz/sombra e detalhes de gola/punho/barra na roupa.
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

# ---------- SPRITESHEETS DO AVATAR ----------
GRID = 24               # grade lógica: 24x24 "pixels" por frame
SCALE = 3                # cada pixel lógico vira um quadrado de 3x3 pixels reais
FRAME = GRID * SCALE     # 72x72 por frame

# pele (fixa — não muda com a cor do jogador)
SKIN = (255, 213, 170, 255)
SKIN_SHADOW = (219, 176, 138, 255)
HAIR = (58, 40, 30, 255)
HAIR_SHADOW = (42, 28, 20, 255)
EYE = (22, 16, 20, 255)
SHOE = (40, 30, 26, 255)
SHOE_HI = (72, 58, 50, 255)

# roupa (recebe a cor do jogador via tint)
CLOTHES_LIGHT = (242, 242, 246, 255)
CLOTHES_SHADOW = (172, 172, 186, 255)
CLOTHES_TRIM = (120, 120, 134, 255)  # gola/punho/barra — uma terceira tonalidade, mais escura

HAIR_SPIKE_COLS = {5, 6, 9, 10, 13, 14, 17, 18}  # colunas que "sobem" um pixel a mais (franja irregular)


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


def dither_col(grid, x, y0, y1, color_a, color_b):
    """Preenche uma coluna alternando duas cores por linha — cria uma
    transição "granulada" entre luz e sombra em vez de um corte reto,
    suavizando um pouco o degradê (efeito parecido com dithering)."""
    for y in range(y0, y1 + 1):
        if 0 <= x < GRID and 0 <= y < GRID:
            grid[y][x] = color_a if y % 2 == 0 else color_b


def build_frame(direction, step):
    """Retorna (grade_pele, grade_roupa) pro frame pedido.
    step 0/2 = parado, 1/3 = meio-passo (pernas e braços alternando)."""
    skin = new_grid()
    clothes = new_grid()

    # --- cabelo (com franja irregular pra não ficar um bloco liso) ---
    fill(skin, 4, 1, 19, 4, HAIR)
    for x in range(4, 20):
        if x in HAIR_SPIKE_COLS:
            dot(skin, x, 0, HAIR)
        else:
            dot(skin, x, 1, HAIR_SHADOW)  # "vale" entre os picos, um pouco mais escuro
    dot(skin, 4, 1, None)
    dot(skin, 19, 1, None)

    # --- cabeça (grande, estilo chibi/Habbo) ---
    fill(skin, 4, 5, 19, 13, SKIN)
    fill(skin, 12, 5, 19, 13, SKIN_SHADOW)  # sombra do lado direito da cabeça
    dither_col(skin, 12, 5, 13, SKIN, SKIN_SHADOW)  # transição suave luz/sombra
    dot(skin, 4, 13, None)
    dot(skin, 19, 13, None)

    # pescoço
    fill(skin, 9, 14, 14, 14, SKIN_SHADOW)

    if direction == "up":
        # de costas: cabelo cobre bem mais a cabeça, com uma leve risca ao meio
        fill(skin, 4, 3, 19, 8, HAIR)
        fill(skin, 11, 5, 12, 8, HAIR_SHADOW)
    else:
        if direction == "down":
            fill(skin, 8, 7, 9, 7, HAIR_SHADOW)     # sobrancelha esquerda
            fill(skin, 14, 7, 15, 7, HAIR_SHADOW)    # sobrancelha direita
            fill(skin, 8, 8, 9, 9, EYE)              # olho esquerdo
            fill(skin, 14, 8, 15, 9, EYE)             # olho direito
            fill(skin, 11, 11, 12, 11, SKIN_SHADOW)   # nariz
        elif direction == "left":
            fill(skin, 7, 7, 8, 7, HAIR_SHADOW)
            fill(skin, 7, 8, 8, 9, EYE)
            fill(skin, 1, 9, 3, 11, SKIN)             # narigão projetado pra fora
            fill(skin, 1, 10, 2, 10, SKIN_SHADOW)
        elif direction == "right":
            fill(skin, 15, 7, 16, 7, HAIR_SHADOW)
            fill(skin, 15, 8, 16, 9, EYE)
            fill(skin, 20, 9, 22, 11, SKIN)           # narigão projetado pra fora
            fill(skin, 21, 10, 22, 10, SKIN_SHADOW)

    # --- tronco (roupa) ---
    fill(clothes, 6, 15, 17, 19, CLOTHES_LIGHT)
    fill(clothes, 12, 15, 17, 19, CLOTHES_SHADOW)
    dither_col(clothes, 12, 15, 19, CLOTHES_LIGHT, CLOTHES_SHADOW)
    fill(clothes, 6, 15, 17, 15, CLOTHES_TRIM)   # gola
    fill(clothes, 6, 19, 17, 19, CLOTHES_TRIM)   # barra da camisa (cinto)

    # --- braços (roupa) — balançam alternadamente durante o passo ---
    arm_bob_l = 1 if step == 1 else 0
    arm_bob_r = 1 if step == 3 else 0
    fill(clothes, 4, 15 + arm_bob_l, 5, 18 + arm_bob_l, CLOTHES_LIGHT)
    fill(clothes, 18, 15 + arm_bob_r, 19, 18 + arm_bob_r, CLOTHES_SHADOW)
    fill(clothes, 4, 18 + arm_bob_l, 5, 18 + arm_bob_l, CLOTHES_TRIM)  # punho esquerdo
    fill(clothes, 18, 18 + arm_bob_r, 19, 18 + arm_bob_r, CLOTHES_TRIM)  # punho direito
    dot(skin, 4, 19 + arm_bob_l, SKIN)   # mãozinha
    dot(skin, 19, 19 + arm_bob_r, SKIN)

    # --- pernas (roupa) + sapato (pele/fixo) ---
    left_fwd = step == 1
    right_fwd = step == 3
    leg_l_bottom = 21 if right_fwd else 23
    leg_r_bottom = 21 if left_fwd else 23

    fill(clothes, 7, 20, 9, leg_l_bottom - 1, CLOTHES_LIGHT)
    fill(clothes, 14, 20, 16, leg_r_bottom - 1, CLOTHES_SHADOW)
    fill(clothes, 7, leg_l_bottom - 1, 9, leg_l_bottom - 1, CLOTHES_TRIM)   # barra da calça
    fill(clothes, 14, leg_r_bottom - 1, 16, leg_r_bottom - 1, CLOTHES_TRIM)

    fill(skin, 7, leg_l_bottom, 9, leg_l_bottom, SHOE)
    dot(skin, 9, leg_l_bottom, SHOE_HI)
    fill(skin, 14, leg_r_bottom, 16, leg_r_bottom, SHOE)
    dot(skin, 16, leg_r_bottom, SHOE_HI)

    return skin, clothes


def rasterize(grid):
    img = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    for y in range(GRID):
        for x in range(GRID):
            color = grid[y][x]
            if color:
                img.paste(color, (x * SCALE, y * SCALE, x * SCALE + SCALE, y * SCALE + SCALE))
    return img


skin_sheet = Image.new("RGBA", (FRAME * 4, FRAME * 4), (0, 0, 0, 0))
clothes_sheet = Image.new("RGBA", (FRAME * 4, FRAME * 4), (0, 0, 0, 0))

for row, direction in enumerate(["down", "left", "right", "up"]):
    for col in range(4):
        skin_grid, clothes_grid = build_frame(direction, col)
        skin_img = rasterize(skin_grid)
        clothes_img = rasterize(clothes_grid)
        skin_sheet.paste(skin_img, (col * FRAME, row * FRAME), skin_img)
        clothes_sheet.paste(clothes_img, (col * FRAME, row * FRAME), clothes_img)

skin_sheet.save(os.path.join(OUT_DIR, "avatar_skin.png"))
clothes_sheet.save(os.path.join(OUT_DIR, "avatar_clothes.png"))

print("Assets gerados em", OUT_DIR, f"(avatar: {FRAME}x{FRAME} por frame, grade {GRID}x{GRID}, 2 camadas)")
