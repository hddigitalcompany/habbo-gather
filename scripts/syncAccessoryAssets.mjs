// Sincroniza itens de acessório (óculos etc) a partir de uma pasta de
// "arte crua" (ver ACESSORIO_SRC_ROOT em scripts/avatarAssetsConfig.mjs)
// -- MESMO esquema da barba (scripts/syncBeardAssets.mjs): pasta "plana"
// com as poses direto vira item isolado; pasta de ESTILO com subpastas
// de COR vira as cores daquele item; só 3 poses (frente, lado esq, lado
// dir) -- sem "costas" (acessório de rosto não aparece de trás), frame
// de "up" fica transparente (ver blankFrame em spriteSheetUtils.mjs).
//
// Gera public/assets/acessorio_<slug>.png e
// game/accessoryCatalog.generated.ts -- reescrito toda vez, não editar
// à mão.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, ACESSORIO_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
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
const CATALOG_OUT = path.join(ROOT, "game", "accessoryCatalog.generated.ts");
const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");

const FRAME_SLOTS = [
  "frente", "frente", "frente",
  "lado_esq", "lado_esq", "lado_esq",
  "lado_dir", "lado_dir", "lado_dir",
  "blank", "blank", "blank", // up -- sem arte de costas, fica invisível
  "frente", "lado_esq", "lado_dir",
];

const POSE_FILE_ALIASES = {
  frente: ["frente", "acessorio frente", "acessório frente"],
  lado_esq: ["lado esq", "lado esquerdo", "acessorio lado esq", "acessório lado esq"],
  lado_dir: ["lado dir", "lado direito", "acessorio lado dir", "acessório lado dir"],
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

/** Compõe o spritesheet de UM acessório (3 poses) -- devolve {id, label, file} ou null se inválido/incompleto. */
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
  const fileName = `acessorio_${id}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);

  const label = (await readOptionalLabel(dir, entries)) || humanize(defaultLabel);
  takenIds.add(id);
  return { id, label, file: fileName };
}

async function main() {
  // "nenhum" já existe manualmente em game/customization.ts (opção
  // padrão, sem acessório) -- não deixa um item gerado roubar esse id.
  const takenIds = new Set(["nenhum"]);

  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por acessório aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando acessório (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const catalog = [];

  for (const entry of topDirs) {
    const dir = path.join(SRC_ROOT, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const { missing } = findAllPoses(imageFiles(children), POSE_FILE_ALIASES);

    if (missing.length === 0) {
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
    "// GERADO AUTOMATICAMENTE por scripts/syncAccessoryAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um item, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { AccessoryOption } from "./customization";\n\n';
  const body = `export const GENERATED_ACCESSORY_CATALOG: AccessoryOption[] = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${catalog.length} item(ns) de acessório gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar acessório:", e);
  process.exitCode = 1;
});
