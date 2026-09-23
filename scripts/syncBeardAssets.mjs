// Sincroniza itens de barba a partir de uma pasta de "arte crua" (ver
// BARBA_SRC_ROOT em scripts/avatarAssetsConfig.mjs) -- MESMO esquema do
// cabelo (scripts/syncAvatarAssets.mjs: pasta "plana" com as poses
// direto vira item isolado; pasta de ESTILO com subpastas de COR vira
// as cores daquele item), com uma diferença: barba só tem 3 poses
// (frente, lado esq, lado dir) -- NÃO existe "costas", porque não dá
// pra ver a barba de trás da cabeça mesmo. O frame de "up" (andando de
// costas) fica com o item invisível (frame transparente, ver
// blankFrame em spriteSheetUtils.mjs), sem precisar desse arquivo.
//
// Gera public/assets/barba_<slug>.png e game/beardCatalog.generated.ts
// -- reescrito toda vez, não editar à mão. Como não existe nenhuma
// barba manual pré-existente em game/customization.ts (só a opção
// "Nenhuma", ver DEFAULT_BEARD_ID), TODA pasta de estilo com subpastas
// de cor vira um item novo já com as cores dentro de `colors` -- não
// tem equivalente ao MANUAL_STYLE_MATCH do cabelo aqui.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, BARBA_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import {
  imageFiles,
  findAllPoses,
  loadFrame,
  blankFrame,
  composeSheet,
  readOptionalLabel,
  slugify,
  humanize,
  extractReferenceFrames,
} from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "beardCatalog.generated.ts");
const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");

// "up" (frames 9-11, andando de costas) fica com o frame BRANCO/vazio
// -- ver comentário no topo do arquivo. sentado "up" nem existe no
// sistema (reusa o frame 9, ver SENTADO_FRAMES em MainScene.ts).
const FRAME_SLOTS = [
  "frente", "frente", "frente", // down: parado, passoA, passoB
  "lado_esq", "lado_esq", "lado_esq", // left
  "lado_dir", "lado_dir", "lado_dir", // right
  "blank", "blank", "blank", // up -- sem arte de costas, fica invisível
  "frente", "lado_esq", "lado_dir", // sentado: down, left, right
];

const POSE_FILE_ALIASES = {
  frente: ["frente", "barba frente"],
  lado_esq: ["lado esq", "lado esquerdo", "barba lado esq"],
  lado_dir: ["lado dir", "lado direito", "barba lado dir"],
};

async function ensureReferenceTemplates() {
  const need = ["frente", "lado_esq", "lado_dir"].some((k) => !existsSync(path.join(REFERENCE_DIR, `${k}.png`)));
  if (!need) return;
  const baseAvatarPath = path.join(OUT_DIR, "avatar_visual1.png");
  if (!existsSync(baseAvatarPath)) return;
  await extractReferenceFrames(baseAvatarPath, REFERENCE_DIR, { frente: 0, lado_esq: 3, lado_dir: 6 });
  console.log(
    `Gerei referências de alinhamento em ${path.relative(ROOT, REFERENCE_DIR)}/ (recortadas do avatar base) -- use como guia no editor de imagem.`
  );
}

/** Compõe o spritesheet de UMA barba (3 poses) -- devolve {id, label, file} ou null se inválido/incompleto. */
async function buildOne({ idLabel, defaultLabel, dir }, takenIds) {
  const id = slugify(idLabel);
  if (!id) {
    console.warn(`- "${idLabel}": nome inválido pra virar id, pulei.`);
    return null;
  }
  if (takenIds.has(id)) {
    console.warn(`- "${idLabel}" (id "${id}"): id repetido/já usado no catálogo, pulei -- renomeie a pasta.`);
    return null;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const { found, missing } = findAllPoses(imageFiles(entries), POSE_FILE_ALIASES);
  if (missing.length > 0) {
    console.warn(`- "${idLabel}": faltam os arquivos [${missing.join(", ")}], pulei (item incompleto).`);
    return null;
  }

  console.log(`- "${idLabel}" -> id "${id}"`);
  const frameBuffers = { blank: await blankFrame() };
  for (const [poseKey, fileName] of Object.entries(found)) {
    frameBuffers[poseKey] = await loadFrame(path.join(dir, fileName), `${idLabel}/${fileName}`, path.relative(ROOT, REFERENCE_DIR));
  }

  const sheet = await composeSheet(frameBuffers, FRAME_SLOTS);
  const fileName = `barba_${id}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);

  const label = (await readOptionalLabel(dir, entries)) || humanize(defaultLabel);
  takenIds.add(id);
  return { id, label, file: fileName };
}

async function main() {
  // "nenhuma" já existe manualmente em game/customization.ts (opção
  // padrão, sem barba) -- não deixa um item gerado roubar esse id.
  const takenIds = new Set(["nenhuma"]);

  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por barba aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando barba (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const catalog = [];

  for (const entry of topDirs) {
    const dir = path.join(SRC_ROOT, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const { missing } = findAllPoses(imageFiles(children), POSE_FILE_ALIASES);

    if (missing.length === 0) {
      // pasta "plana" -- as poses direto dentro dela, item isolado (sem cor).
      try {
        const result = await buildOne({ idLabel: entry.name, defaultLabel: entry.name, dir }, takenIds);
        if (result) catalog.push(result);
      } catch (e) {
        console.error(`- "${entry.name}": erro processando -- ${e.message}`);
      }
      continue;
    }

    const subDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith("."));
    if (subDirs.length === 0) {
      console.warn(`- "${entry.name}": faltam os arquivos [${missing.join(", ")}], pulei (item incompleto, sem subpastas de cor).`);
      continue;
    }

    // pasta de ESTILO com subpastas de COR -- vira UM item novo com as
    // cores dentro de `colors` (não existe equivalente manual pra
    // "roubar" as cores aqui, diferente do cabelo).
    const colorResults = [];
    for (const sub of subDirs) {
      const combined = `${entry.name} ${sub.name}`.replace(/\s+/g, " ").trim();
      try {
        const result = await buildOne({ idLabel: combined, defaultLabel: sub.name, dir: path.join(dir, sub.name) }, takenIds);
        if (result) colorResults.push(result);
      } catch (e) {
        console.error(`- "${combined}": erro processando -- ${e.message}`);
      }
    }
    if (colorResults.length === 0) continue;

    const styleId = slugify(entry.name);
    if (takenIds.has(styleId)) {
      console.warn(`- "${entry.name}" (id "${styleId}"): id repetido/já usado no catálogo, pulei o item de estilo (as cores já foram geradas).`);
      continue;
    }
    takenIds.add(styleId);
    catalog.push({ id: styleId, label: humanize(entry.name), file: colorResults[0].file, colors: colorResults });
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncBeardAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um item, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { BeardOption } from "./customization";\n\n';
  const body = `export const GENERATED_BEARD_CATALOG: BeardOption[] = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${catalog.length} item(ns) de barba gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar barba:", e);
  process.exitCode = 1;
});
