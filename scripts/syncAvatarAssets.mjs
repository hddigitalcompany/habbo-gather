// Sincroniza itens de cabelo a partir de uma pasta de "arte crua" (ver
// scripts/avatarAssetsConfig.mjs pra onde essa pasta fica) -- o Douglas
// organiza uma pasta por item, com 4 imagens dentro (frente, lado
// esquerdo, lado direito, costas -- aceita vários jeitos de nomear, ver
// POSE_FILE_ALIASES/normalizeBase embaixo), e esse script:
//
//   1. monta o spritesheet final (grade 8x2, 200x260 por frame, 2px de
//      espaço -- MESMO layout que MainScene.ts espera, ver FRAME_W/
//      FRAME_H/spacing lá) repetindo cada pose crua nos frames de
//      andar+sentado que usam aquela direção (ver FRAME_SLOTS embaixo);
//   2. salva em public/assets/cabelo_<slug>.png;
//   3. gera game/customizationCatalog.generated.ts com um HairOption pra
//      cada item válido -- esse arquivo é reescrito TODA VEZ (não edite
//      à mão), e game/customization.ts importa ele e junta com os itens
//      manuais (ondulado, vorcarinho-do-roi).
//
// Duas formas de organizar as pastas são aceitas:
//   a) "plana": <pasta-da-origem>/<item>/{frente,lado esq,lado dir,costas}.png
//      -> vira UM item no catálogo.
//   b) "aninhada" (estilo -> cor), do jeito que o Douglas já organizou em
//      Cabelos/: <pasta-da-origem>/<Estilo>/<Cor>/{...as 4 poses...} --
//      quando uma pasta de primeiro nível NÃO tem as 4 poses direto mas
//      tem subpastas, cada subpasta vira um item separado, com o nome
//      "<Estilo> <Cor>" (ex: "Cabelinho pra trás Loiro").
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`) -- assim o item aparece no jogo só de
// criar a pasta, sem precisar mandar as imagens pra mim (Claude) nem
// mexer em código.
//
// Pra alinhar a arte nova com a cabeça do avatar base, use os arquivos-
// referência em <pasta-da-origem>/_referencia/ (recortados direto do
// avatar_visual1.png) como fundo/guia no seu editor de imagem -- exporte
// cada pose já no tamanho 200x260, na mesma posição da referência.

import { readdir, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { ROOT, CABELO_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "customizationCatalog.generated.ts");

const FRAME_W = 200;
const FRAME_H = 260;
const SPACING = 2;
const COLS = 8;
const ROWS = 2;
const SHEET_W = COLS * FRAME_W + (COLS - 1) * SPACING; // 1614
const SHEET_H = ROWS * FRAME_H + (ROWS - 1) * SPACING; // 522

const FRAME_SLOTS = [
  "frente", "frente", "frente",
  "lado_esq", "lado_esq", "lado_esq",
  "lado_dir", "lado_dir", "lado_dir",
  "costas", "costas", "costas",
  "frente", "lado_esq", "lado_dir",
];

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

const POSE_FILE_ALIASES = {
  frente: ["frente", "cabelo frente"],
  lado_esq: ["lado esq", "lado esquerdo", "cabelo lado esq"],
  lado_dir: ["lado dir", "lado direito", "cabelo lado dir"],
  costas: ["costas", "cabelo costas"],
};

function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanize(name) {
  return name
    .replace(/[-_]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeBase(fileName) {
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

function imageFiles(entries) {
  return entries.filter((e) => e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())).map((e) => e.name);
}

function matchPoseFile(fileNames, poseKey) {
  const targets = new Set(POSE_FILE_ALIASES[poseKey]);
  for (const name of fileNames) {
    if (targets.has(normalizeBase(name))) return name;
  }
  return null;
}

function findAllPoses(fileNames) {
  const found = {};
  const missing = [];
  for (const poseKey of Object.keys(POSE_FILE_ALIASES)) {
    const hit = matchPoseFile(fileNames, poseKey);
    if (hit) found[poseKey] = hit;
    else missing.push(poseKey);
  }
  return { found, missing };
}

async function loadFrame(filePath, label) {
  const img = sharp(filePath).ensureAlpha();
  const meta = await img.metadata();
  if (meta.width === FRAME_W && meta.height === FRAME_H) {
    return img.png().toBuffer();
  }
  console.warn(
    `  aviso: ${label} tem ${meta.width}x${meta.height}, esperado ${FRAME_W}x${FRAME_H} -- ` +
      `redimensionando automaticamente (encaixado, sem cortar), mas o ideal é exportar já no tamanho certo ` +
      `usando a referência em ${path.relative(ROOT, path.join(SRC_ROOT, "_referencia"))}/ como guia.`
  );
  return img
    .resize(FRAME_W, FRAME_H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function readOptionalLabel(dir, entries) {
  const hit = entries.find((e) => e.isFile() && /^(label|nome)\.txt$/i.test(e.name));
  if (!hit) return null;
  const raw = await readFile(path.join(dir, hit.name), "utf8");
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : null;
}

async function collectCandidateItems() {
  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const items = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = path.join(SRC_ROOT, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const { missing } = findAllPoses(imageFiles(children));

    if (missing.length === 0) {
      items.push({ label: entry.name, dir });
      continue;
    }

    const subDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith("."));
    if (subDirs.length === 0) {
      items.push({ label: entry.name, dir, forceMissing: missing });
      continue;
    }
    for (const sub of subDirs) {
      items.push({ label: `${entry.name} ${sub.name}`.replace(/\s+/g, " ").trim(), dir: path.join(dir, sub.name) });
    }
  }

  return items;
}

async function processItem({ label, dir, forceMissing }, manualIds) {
  const id = slugify(label);
  if (!id) {
    console.warn(`- "${label}": nome inválido pra virar id, pulei.`);
    return null;
  }
  if (manualIds.has(id)) {
    console.warn(`- "${label}" (id "${id}"): já existe um item manual com esse id no catálogo, pulei -- renomeie a pasta.`);
    return null;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const { found, missing } = forceMissing ? { found: {}, missing: forceMissing } : findAllPoses(imageFiles(entries));
  if (missing.length > 0) {
    console.warn(`- "${label}": faltam os arquivos [${missing.join(", ")}], pulei (item incompleto).`);
    return null;
  }

  console.log(`- "${label}" -> id "${id}"`);
  const frameBuffers = {};
  for (const [poseKey, fileName] of Object.entries(found)) {
    frameBuffers[poseKey] = await loadFrame(path.join(dir, fileName), `${label}/${fileName}`);
  }

  const composites = [];
  for (let idx = 0; idx < FRAME_SLOTS.length; idx++) {
    const poseKey = FRAME_SLOTS[idx];
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    composites.push({
      input: frameBuffers[poseKey],
      left: col * (FRAME_W + SPACING),
      top: row * (FRAME_H + SPACING),
    });
  }

  const sheet = await sharp({
    create: { width: SHEET_W, height: SHEET_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const fileName = `cabelo_${id}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);

  const label2 = (await readOptionalLabel(dir, entries)) || humanize(label);
  return { id, label: label2, file: fileName };
}

const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");
const REFERENCE_POSES = { frente: 0, lado_esq: 3, lado_dir: 6, costas: 9 };

async function ensureReferenceTemplates() {
  const missing = [];
  for (const poseKey of Object.keys(REFERENCE_POSES)) {
    if (!existsSync(path.join(REFERENCE_DIR, `${poseKey}.png`))) missing.push(poseKey);
  }
  if (missing.length === 0) return;

  const baseAvatarPath = path.join(OUT_DIR, "avatar_visual1.png");
  if (!existsSync(baseAvatarPath)) return;

  await mkdir(REFERENCE_DIR, { recursive: true });
  for (const poseKey of missing) {
    const idx = REFERENCE_POSES[poseKey];
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    await sharp(baseAvatarPath)
      .extract({ left: col * (FRAME_W + SPACING), top: row * (FRAME_H + SPACING), width: FRAME_W, height: FRAME_H })
      .png()
      .toFile(path.join(REFERENCE_DIR, `${poseKey}.png`));
  }
  console.log(
    `Gerei referências de alinhamento em ${path.relative(ROOT, REFERENCE_DIR)}/ (recortadas do avatar base) -- use como guia no editor de imagem.`
  );
}

async function main() {
  const manualIds = new Set(["ondulado", "vorcarinho-do-roi"]);

  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por item de cabelo aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const candidates = await collectCandidateItems();
  console.log(`Sincronizando cabelo (${candidates.length} pasta(s) encontrada(s) em ${SRC_ROOT})...`);

  const results = [];
  for (const candidate of candidates) {
    try {
      const result = await processItem(candidate, manualIds);
      if (result) results.push(result);
    } catch (e) {
      console.error(`- "${candidate.label}": erro processando -- ${e.message}`);
    }
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncAvatarAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um item, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { HairOption } from "./customization";\n\n';
  const body = `export const GENERATED_HAIR_CATALOG: HairOption[] = ${JSON.stringify(results, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${results.length} item(ns) de cabelo gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar assets de avatar:", e);
  process.exitCode = 1;
});
