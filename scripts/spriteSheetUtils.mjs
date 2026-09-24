// Utilidades compartilhadas pelos pipelines de sincronização de arte do
// avatar (cabelo: scripts/syncAvatarAssets.mjs; tom de pele/corpo base:
// scripts/syncSkinAssets.mjs) -- monta um spritesheet no formato que
// MainScene.ts espera (grade 8x2, 200x260 por frame, 2px de espaço) a
// partir de poses cruas soltas numa pasta.

import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";

export const FRAME_W = 200;
export const FRAME_H = 260;
export const SPACING = 2;
export const COLS = 8;
export const ROWS = 2;
export const SHEET_W = COLS * FRAME_W + (COLS - 1) * SPACING; // 1614
export const SHEET_H = ROWS * FRAME_H + (ROWS - 1) * SPACING; // 522

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

export function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function humanize(name) {
  return name
    .replace(/[-_]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// normaliza um nome de arquivo (sem extensão) pra comparar apesar de
// maiúscula/minúscula, acento, espaço x hífen x underscore, e sufixos
// tipo " (1)"/" copy" que o macOS gruda em arquivo duplicado.
export function normalizeBase(fileName) {
  const noExt = fileName.replace(/\.[a-z0-9]+$/i, "");
  return noExt
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+copy\s*$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function imageFiles(entries) {
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);
}

/** Acha, entre os nomes de arquivo dados, qual bate com a pose pedida (poseAliases[poseKey] = lista de nomes normalizados aceitos). */
export function matchPoseFile(fileNames, poseKey, poseAliases) {
  const targets = new Set(poseAliases[poseKey]);
  for (const name of fileNames) {
    if (targets.has(normalizeBase(name))) return name;
  }
  return null;
}

export function findAllPoses(fileNames, poseAliases) {
  const found = {};
  const missing = [];
  for (const poseKey of Object.keys(poseAliases)) {
    const hit = matchPoseFile(fileNames, poseKey, poseAliases);
    if (hit) found[poseKey] = hit;
    else missing.push(poseKey);
  }
  return { found, missing };
}

export async function readOptionalLabel(dir, entries) {
  const hit = entries.find((e) => e.isFile() && /^(label|nome)\.txt$/i.test(e.name));
  if (!hit) return null;
  const raw = await readFile(path.join(dir, hit.name), "utf8");
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : null;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Alguns exports do Douglas vêm sem canal alpha de verdade -- só um PNG
// opaco, com um fundo de cor sólida (geralmente branco) atrás do desenho,
// em vez de transparência real (`sharp().ensureAlpha()` sozinho não
// resolve isso -- ele só GARANTE que existe um canal alpha, preenchido
// 100% opaco quando não havia nenhum, não faz o fundo virar transparente).
// detectFlatBackground()/floodFillRemoveBackground() abaixo corrigem esse
// caso sozinhos dentro de loadFrame(), sem precisar reexportar o arquivo.

/** Detecta se a BORDA do quadro é opaca e de cor uniforme (um fundo chapado, sem alpha de verdade) -- devolve a cor de referência {r,g,b} ou null se não for o caso (a imagem já tem alpha de verdade, ou a arte chega até a borda do quadro). */
function detectFlatBackground(data, width, height) {
  const borderPixels = [];
  const pushPixel = (x, y) => {
    const idx = (y * width + x) * 4;
    borderPixels.push([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]);
  };
  for (let x = 0; x < width; x++) {
    pushPixel(x, 0);
    pushPixel(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushPixel(0, y);
    pushPixel(width - 1, y);
  }

  // se algum pixel de borda já não for 100% opaco, a imagem já tem alpha
  // de verdade -- não mexe em nada.
  if (borderPixels.some(([, , , a]) => a < 250)) return null;

  const [r0, g0, b0] = borderPixels[0];
  let sumR = 0, sumG = 0, sumB = 0, uniform = 0;
  for (const [r, g, b] of borderPixels) {
    if (colorDistance(r, g, b, r0, g0, b0) < 40) uniform++;
    sumR += r;
    sumG += g;
    sumB += b;
  }
  // pelo menos 90% da borda tem que bater com a cor de referência --
  // senão a arte provavelmente chega até a borda do quadro (pé/ombro
  // encostando, por exemplo), não é um fundo chapado.
  if (uniform / borderPixels.length < 0.9) return null;

  return {
    r: Math.round(sumR / borderPixels.length),
    g: Math.round(sumG / borderPixels.length),
    b: Math.round(sumB / borderPixels.length),
  };
}

/** Remove um fundo chapado (ver detectFlatBackground) via flood-fill a partir da borda do quadro -- só mexe nos pixels CONECTADOS à borda dentro do limite de cor, então uma parte branca DENTRO do desenho (dente, brilho no cabelo) que não toca a borda nunca é afetada. Transição suave (despill) na franja em vez de corte seco, pra não sobrar halo esbranquiçado ao redor do desenho. Modifica `data` (RGBA) direto. */
function floodFillRemoveBackground(data, width, height, bg) {
  const THRESHOLD = 18; // até essa distância: fundo puro, vira 100% transparente
  const SOFT_THRESHOLD = 70; // até essa distância, se conectado à borda: franja em transição
  const visited = new Uint8Array(width * height);
  const queue = [];
  const pushIfBackground = (x, y) => {
    const i = y * width + x;
    if (visited[i]) return;
    const idx = i * 4;
    const d = colorDistance(data[idx], data[idx + 1], data[idx + 2], bg.r, bg.g, bg.b);
    if (d > SOFT_THRESHOLD) return;
    visited[i] = 1;
    queue.push(x, y);
  };
  for (let x = 0; x < width; x++) {
    pushIfBackground(x, 0);
    pushIfBackground(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfBackground(0, y);
    pushIfBackground(width - 1, y);
  }

  let qi = 0;
  while (qi < queue.length) {
    const x = queue[qi++];
    const y = queue[qi++];
    if (x > 0) pushIfBackground(x - 1, y);
    if (x < width - 1) pushIfBackground(x + 1, y);
    if (y > 0) pushIfBackground(x, y - 1);
    if (y < height - 1) pushIfBackground(x, y + 1);
  }

  for (let i = 0; i < width * height; i++) {
    if (!visited[i]) continue;
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const d = colorDistance(r, g, b, bg.r, bg.g, bg.b);
    const t = Math.max(0, Math.min(1, (d - THRESHOLD) / (SOFT_THRESHOLD - THRESHOLD)));
    const alpha = Math.round(255 * t);
    data[idx + 3] = alpha;
    if (alpha > 0 && alpha < 255) {
      // descontamina a franja (desfaz a mistura com o fundo que sobra na
      // borda) -- sem isso ficaria um halo meio esbranquiçado ao redor do
      // desenho quando colocado sobre um fundo escuro no jogo.
      const a = alpha / 255;
      data[idx] = Math.max(0, Math.min(255, Math.round(bg.r + (r - bg.r) / a)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(bg.g + (g - bg.g) / a)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(bg.b + (b - bg.b) / a)));
    }
  }
}

/** Se a imagem carregada não tiver alpha de verdade e a borda for um fundo chapado (ver detectFlatBackground), remove esse fundo sozinho (ver floodFillRemoveBackground) -- corrige exports que saem sem transparência real. Se não detectar esse caso (já tem alpha, ou a arte encosta na borda), devolve a imagem sem mexer. */
async function autoRemoveFlatBackground(img, label) {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const bg = detectFlatBackground(data, info.width, info.height);
  if (!bg) return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  floodFillRemoveBackground(data, info.width, info.height, bg);
  console.warn(
    `  aviso: ${label} não tinha transparência de verdade (fundo chapado rgb(${bg.r},${bg.g},${bg.b})) -- removi o fundo sozinho. Se puder, exporte já com fundo transparente da próxima vez.`
  );
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
}

/** Carrega uma pose crua, removendo fundo chapado sem alpha de verdade se detectar esse caso (ver autoRemoveFlatBackground), e redimensionando (com aviso) se não vier exatamente no tamanho de um frame. */
export async function loadFrame(filePath, label, referenceDirRelative) {
  let img = sharp(filePath).ensureAlpha();
  img = await autoRemoveFlatBackground(img, label);
  const meta = await img.metadata();
  if (meta.width === FRAME_W && meta.height === FRAME_H) {
    return img.png().toBuffer();
  }
  console.warn(
    `  aviso: ${label} tem ${meta.width}x${meta.height}, esperado ${FRAME_W}x${FRAME_H} -- ` +
      `redimensionando automaticamente (encaixado, sem cortar), mas o ideal é exportar já no tamanho certo ` +
      `usando a referência em ${referenceDirRelative}/ como guia.`
  );
  return img
    .resize(FRAME_W, FRAME_H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// buffer cacheado (uma promise só, reusada) de um frame 200x260
// totalmente transparente -- usado pelos itens que não têm arte de
// "costas" (barba, óculos: não dá pra ver de trás mesmo, não faz
// sentido pedir esse arquivo pro Douglas) pra preencher os frames de
// "up" (ver POSE_KEY_BLANK/FRAME_SLOTS em syncBeardAssets.mjs e
// syncAccessoryAssets.mjs) sem precisar de nenhum arquivo de origem.
let _blankFramePromise = null;
export function blankFrame() {
  if (!_blankFramePromise) {
    _blankFramePromise = sharp({
      create: { width: FRAME_W, height: FRAME_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
  }
  return _blankFramePromise;
}

/** Monta o PNG final (grade 8x2) a partir de {poseKey: buffer} + a lista ordenada de 15 poseKeys (um por frame, ver FRAME_SLOTS em cada pipeline). */
export async function composeSheet(frameBuffersByPose, frameSlots) {
  const composites = [];
  for (let idx = 0; idx < frameSlots.length; idx++) {
    const poseKey = frameSlots[idx];
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    composites.push({
      input: frameBuffersByPose[poseKey],
      left: col * (FRAME_W + SPACING),
      top: row * (FRAME_H + SPACING),
    });
  }
  return sharp({
    create: { width: SHEET_W, height: SHEET_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/** Recorta os frames de referência (pra alinhar arte nova) direto de um spritesheet base já existente (ex: avatar_visual1.png). refPoses = {poseKey: frameIndex}. */
export async function extractReferenceFrames(baseSheetPath, outDir, refPoses) {
  const { mkdir } = await import("fs/promises");
  await mkdir(outDir, { recursive: true });
  for (const [poseKey, idx] of Object.entries(refPoses)) {
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    await sharp(baseSheetPath)
      .extract({ left: col * (FRAME_W + SPACING), top: row * (FRAME_H + SPACING), width: FRAME_W, height: FRAME_H })
      .png()
      .toFile(path.join(outDir, `${poseKey}.png`));
  }
}
