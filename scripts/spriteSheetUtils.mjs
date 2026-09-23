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

/** Carrega uma pose crua, redimensionando (com aviso) se não vier exatamente no tamanho de um frame. */
export async function loadFrame(filePath, label, referenceDirRelative) {
  const img = sharp(filePath).ensureAlpha();
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
