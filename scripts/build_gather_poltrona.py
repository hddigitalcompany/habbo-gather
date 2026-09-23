"""
Escala as 4 poltronas (estilo Gather, top-down simples) extraídas por
process_gather_poltrona.py pra um tamanho consistente com o resto do
jogo.

IMPORTANTE: a escala é calibrada pela LARGURA (não mais pela altura) --
cada view escalada pra não passar da largura do tile. Uma leva anterior
escalava pela altura (mesma altura pras 4), o que deixava frente/costas
mais LARGA que o tile (72px de largura vs tile de 60px), "vazando" pro
lado -- errado mesmo a altura tendo ficado igual entre as views.
Overflow VERTICAL continua normal (como no Habbo, um móvel pode passar
pra cima do próprio tile), só o horizontal não pode.
"""
from pathlib import Path
import numpy as np
from PIL import Image

SRC = Path("assets_src/poltrona_gather_black_keyed")
OUT_DIR = Path("public/assets")

TILE = 60
# um pouco menor que o tile (60px) de propósito, pra sobrar uma margem
# visual e garantir que a silhueta da poltrona nunca encoste/passe da
# borda do quadrado -- "não deixa ela passar na lateral em relação ao
# tile".
TARGET_W = 58


def bbox(img):
    arr = np.array(img)
    alpha = arr[..., 3]
    ys, xs = np.where(alpha > 10)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def bbox_w(img):
    x0, y0, x1, y1 = bbox(img)
    return x1 - x0


def main():
    # cada view escalada pra SUA PRÓPRIA largura bater em TARGET_W --
    # assim nenhuma delas passa da largura do tile, não importa o quão
    # "larga" a silhueta seja de cada ângulo. Isso deixa a ALTURA
    # diferente entre frente/lado (lado sai mais alta, já que de lado a
    # cadeira mostra a profundidade frente-trás) -- só que isso é
    # aceitável, overflow vertical é o normal aqui.
    scales = {}
    for name in ["frente", "lado_esq", "lado_dir"]:
        img = Image.open(SRC / f"{name}.png")
        scales[name] = TARGET_W / bbox_w(img)

    # costas usa a MESMA escala de frente (não a própria largura) --
    # frente e costas são a mesma peça vista de frente/trás, a LARGURA
    # crua das duas bate quase exata (232 vs 232px nessa leva preta),
    # confirmando mesma câmera/zoom -- reaproveitar a escala de frente
    # também garante que costas não passa do tile (sai até mais estreita
    # de verdade, já que a poltrona é mais "curta" de trás).
    scales["costas"] = scales["frente"]

    for name, scale in scales.items():
        img = Image.open(SRC / f"{name}.png")
        new_w, new_h = round(img.width * scale), round(img.height * scale)
        resized = img.resize((new_w, new_h), Image.LANCZOS)
        out_path = OUT_DIR / f"poltrona_{name}.png"
        resized.save(out_path)
        x0, y0, x1, y1 = bbox(resized)
        print(f"poltrona_{name}: escala {scale:.4f} -> {resized.size}, bbox {x1-x0}x{y1-y0}, salvo em {out_path}")


if __name__ == "__main__":
    main()
