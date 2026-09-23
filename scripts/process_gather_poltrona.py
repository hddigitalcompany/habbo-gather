"""
Processa a referência de poltrona estilo Gather (top-down simples, 4
cadeiras já pré-viradas numa imagem só, fundo de piso liso em vez de
magenta) -- separa cada cadeira automaticamente (componentes conexos),
remove o fundo por DISTÂNCIA DE COR até o piso (em vez de chroma-key
magenta, que não se aplica aqui) e identifica qual cadeira é qual
direção pela posição no layout em cruz (cima/baixo/esq/dir).

Uso: python3 scripts/process_gather_poltrona.py <imagem.png> <pasta_saida> [min_size]

min_size (opcional, padrão 150): tamanho mínimo (em px) de um componente
pra não ser descartado como ruído -- útil quando a imagem de referência
tem alguma sujeira/ícone de UI num canto (ex: print de tela) que também
passa no filtro de cor e vira um "componente" pequeno.
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage


def floor_color(arr):
    h, w, _ = arr.shape
    s = 50
    patches = [arr[0:s, 0:s], arr[0:s, w - s : w], arr[h - s : h, 0:s], arr[h - s : h, w - s : w]]
    allp = np.concatenate([p.reshape(-1, 3) for p in patches])
    return allp.mean(axis=0)


def remove_bg_by_distance(img: Image.Image, t0=28.0, t1=48.0) -> Image.Image:
    arr = np.array(img.convert("RGB")).astype(np.float64)
    bg = floor_color(arr)
    dist = np.linalg.norm(arr - bg[None, None, :], axis=-1)
    alpha = np.clip((dist - t0) / (t1 - t0), 0.0, 1.0)
    out = np.dstack([arr, (alpha * 255.0)[..., None]]).astype(np.uint8)
    return Image.fromarray(out, mode="RGBA"), bg


def main():
    src_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src_path).convert("RGB")
    keyed, bg = remove_bg_by_distance(img)
    print(f"cor do piso detectada: {bg}")

    arr = np.array(keyed)
    alpha = arr[..., 3]
    mask = alpha > 128

    # limpa ruído pequeno (grão do piso que passou do threshold) antes de
    # rotular componentes -- abre (erosão+dilatação) com estrutura pequena
    mask_clean = ndimage.binary_opening(mask, structure=np.ones((3, 3)))
    labeled, n = ndimage.label(mask_clean)
    print(f"{n} componentes encontrados")

    sizes = ndimage.sum(mask_clean, labeled, range(1, n + 1))
    # descarta manchas minúsculas (ruído/grão que sobrou, ou sujeira de UI
    # num canto do print) -- ajustável via 3º argumento da linha de comando
    min_size = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    components = [(i + 1, sizes[i]) for i in range(n) if sizes[i] >= min_size]
    print(f"{len(components)} componentes (>= {min_size}px)")

    boxes = []
    for label_id, size in components:
        ys, xs = np.where(labeled == label_id)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        boxes.append({"label": label_id, "size": size, "box": (x0, y0, x1, y1), "center": (cx, cy)})
        print(f"  componente {label_id}: size={size:.0f} bbox=({x0},{y0},{x1},{y1}) centro=({cx:.0f},{cy:.0f})")

    # cada cadeira fragmenta em VÁRIOS componentes (sombra/luz interna
    # quase da cor do piso separa a silhueta em pedaços) -- em vez de
    # exigir 1 componente = 1 cadeira, classifica cada PEDAÇO pela
    # direção (posição relativa ao centro geral) e funde (união de bbox)
    # todos os pedaços da mesma direção numa cadeira só.
    all_cx = [b["center"][0] for b in boxes]
    all_cy = [b["center"][1] for b in boxes]
    mid_x = (min(all_cx) + max(all_cx)) / 2
    mid_y = (min(all_cy) + max(all_cy)) / 2

    def classify(b):
        # as cadeiras da referência estão viradas pro CENTRO do círculo
        # (arrumação de "roda de conversa"), então a direção real que
        # cada uma encara é o OPOSTO da posição dela no layout -- a de
        # cima mostra o assento de frente (encara pra baixo, "frente"),
        # a de baixo mostra só o encosto por fora (encara pra cima,
        # "costas"), a da esquerda encara a direita ("lado_dir") e
        # vice-versa. Confirmado olhando a silhueta de cada uma.
        cx, cy = b["center"]
        dx, dy = cx - mid_x, cy - mid_y
        if abs(dx) > abs(dy):
            return "lado_esq" if dx > 0 else "lado_dir"
        else:
            return "frente" if dy < 0 else "costas"

    groups: dict[str, list] = {"frente": [], "costas": [], "lado_esq": [], "lado_dir": []}
    for b in boxes:
        groups[classify(b)].append(b["box"])

    PAD = 6
    for name, group_boxes in groups.items():
        if not group_boxes:
            print(f"AVISO: nenhum componente classificado como {name}")
            continue
        x0 = min(b[0] for b in group_boxes)
        y0 = min(b[1] for b in group_boxes)
        x1 = max(b[2] for b in group_boxes)
        y1 = max(b[3] for b in group_boxes)
        crop = keyed.crop((max(x0 - PAD, 0), max(y0 - PAD, 0), x1 + PAD, y1 + PAD))
        out_path = out_dir / f"{name}.png"
        crop.save(out_path)
        print(f"{name}: {crop.size} (uniao de {len(group_boxes)} pedaços), salvo em {out_path}")


if __name__ == "__main__":
    main()
