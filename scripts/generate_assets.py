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
px, py = 80, 160
draw.rectangle([px - 4, py + 30, px + 20, py + 50], fill=(90, 60, 40))
for dx, dy in [(-14, -10), (0, -24), (14, -10), (-6, -18), (8, -18)]:
    draw.ellipse([px + dx, py + dy, px + dx + 22, py + dy + 22], fill=(40, 120, 70))

# mesa (direita)
tx, ty = 640, 200
draw.rectangle([tx - 40, ty, tx + 40, ty + 12], fill=(110, 75, 45))
draw.rectangle([tx - 34, ty + 12, tx - 24, ty + 50], fill=(80, 55, 32))
draw.rectangle([tx + 24, ty + 12, tx + 34, ty + 50], fill=(80, 55, 32))

room.save(os.path.join(OUT_DIR, "room.png"))

# ---------- SPRITESHEET DO AVATAR ----------
FRAME = 32
sheet = Image.new("RGBA", (FRAME * 4, FRAME * 4), (0, 0, 0, 0))

BODY = (235, 230, 245, 255)
OUTLINE = (25, 20, 35, 255)
SHOE = (30, 25, 40, 255)
EYE = (20, 15, 30, 255)


def draw_avatar(canvas, ox, oy, direction, frame_idx):
    d = ImageDraw.Draw(canvas)
    bob = [0, -1, 0, 1][frame_idx % 4]
    leg_offset = [4, 0, -4, 0][frame_idx % 4]

    cx = ox + FRAME // 2
    head_r = 7
    head_y = oy + 10 + bob

    d.rectangle(
        [cx - 6, oy + 24 + bob, cx - 2, oy + 29 + bob + (2 if leg_offset > 0 else 0)],
        fill=SHOE,
    )
    d.rectangle(
        [cx + 2, oy + 24 + bob, cx + 6, oy + 29 + bob + (2 if leg_offset < 0 else 0)],
        fill=SHOE,
    )

    d.rounded_rectangle(
        [cx - 8, oy + 15 + bob, cx + 8, oy + 26 + bob], radius=4, fill=BODY, outline=OUTLINE, width=1
    )

    d.ellipse([cx - head_r, head_y - head_r, cx + head_r, head_y + head_r], fill=BODY, outline=OUTLINE, width=1)

    if direction == "down":
        d.point([(cx - 3, head_y - 1), (cx + 3, head_y - 1)], fill=EYE)
    elif direction == "left":
        d.point([(cx - 4, head_y - 1)], fill=EYE)
    elif direction == "right":
        d.point([(cx + 4, head_y - 1)], fill=EYE)
    # "up" = de costas, sem rosto


for row, direction in enumerate(["down", "left", "right", "up"]):
    for col in range(4):
        ox, oy = col * FRAME, row * FRAME
        draw_avatar(sheet, ox, oy, direction, col)

sheet.save(os.path.join(OUT_DIR, "avatar.png"))

print("Assets gerados em", OUT_DIR)
