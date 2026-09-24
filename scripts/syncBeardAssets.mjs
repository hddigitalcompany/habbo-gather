// Sincroniza itens de barba a partir de uma pasta de "arte crua" (ver
// BARBA_SRC_ROOT em scripts/avatarAssetsConfig.mjs) -- MESMO esquema do
// traje (scripts/syncOutfitAssets.mjs: pasta de ESTILO com uma SUBPASTA
// POR TOM DE PELE dentro, mesmos nomes da pasta de tom de pele/Avatar --
// "Branco"/"Pardo"/"Negro"/etc), com uma diferença: barba só tem 3 poses
// (frente, lado esq, lado dir) -- NÃO existe "costas", porque não dá
// pra ver a barba de trás da cabeça mesmo. O frame de "up" (andando de
// costas) fica com o item invisível (frame transparente, ver
// blankFrame em spriteSheetUtils.mjs), sem precisar desse arquivo.
//
// Gera public/assets/barba_<estilo>_<tom>.png e
// game/beardCatalog.generated.ts (um BeardOption por pasta de estilo,
// com `bySkin = {tomId: arquivo}`) -- reescrito toda vez, não editar à
// mão. Como não existe nenhuma barba manual pré-existente em
// game/customization.ts (só a opção "Nenhuma", ver DEFAULT_BEARD_ID),
// toda pasta de estilo com subpastas de tom vira um item novo já com os
// tons dentro de `bySkin`. Uma barba sem NENHUM tom completo é
// ignorada; um tom faltando de uma barba que já tem outro tom ok só
// fica de fora do `bySkin` dela (resolveBeardSkinId cai pro primeiro
// tom que existir).
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

/** Compõe o spritesheet de UMA barba NUM tom de pele (3 poses) -- devolve {skinId, fileName} ou null se incompleto. */
async function buildVariant({ styleName, skinFolderName, styleId, dir }) {
  const skinId = slugify(skinFolderName);
  if (!skinId) {
    console.warn(`- "${styleName}/${skinFolderName}": nome de tom inválido pra virar id, pulei esse tom.`);
    return null;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const { found, missing } = findAllPoses(imageFiles(entries), POSE_FILE_ALIASES);
  if (missing.length > 0) {
    console.warn(`- "${styleName}/${skinFolderName}": faltam os arquivos [${missing.join(", ")}], pulei esse tom (incompleto).`);
    return null;
  }

  const frameBuffers = { blank: await blankFrame() };
  for (const [poseKey, fileName] of Object.entries(found)) {
    frameBuffers[poseKey] = await loadFrame(
      path.join(dir, fileName),
      `${styleName}/${skinFolderName}/${fileName}`,
      path.relative(ROOT, REFERENCE_DIR)
    );
  }

  const sheet = await composeSheet(frameBuffers, FRAME_SLOTS);
  const fileName = `barba_${styleId}_${skinId}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);
  return { skinId, fileName };
}

async function main() {
  // "nenhuma" já existe manualmente em game/customization.ts (opção
  // padrão, sem barba) -- não deixa um item gerado roubar esse id.
  const takenIds = new Set(["nenhuma"]);

  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(
      `Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por barba aí dentro, e dentro de cada uma, uma subpasta por tom de pele (mesmos nomes da pasta de Avatar/tom de pele).`
    );
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando barba (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const catalog = [];

  for (const entry of topDirs) {
    const styleName = entry.name;
    const styleId = slugify(styleName);
    if (!styleId) {
      console.warn(`- "${styleName}": nome inválido pra virar id, pulei.`);
      continue;
    }
    if (takenIds.has(styleId)) {
      console.warn(`- "${styleName}" (id "${styleId}"): id repetido/já usado no catálogo, pulei -- renomeie a pasta.`);
      continue;
    }

    const dir = path.join(SRC_ROOT, styleName);
    const children = await readdir(dir, { withFileTypes: true });
    const subDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith("_") && !c.name.startsWith("."));
    if (subDirs.length === 0) {
      console.warn(
        `- "${styleName}": nenhuma subpasta de tom de pele dentro (crie uma pasta por tom, ex: "Branco"/"Pardo"/"Negro" -- mesmos nomes da pasta de Avatar), pulei.`
      );
      continue;
    }

    const bySkin = {};
    for (const sub of subDirs) {
      try {
        const result = await buildVariant({ styleName, skinFolderName: sub.name, styleId, dir: path.join(dir, sub.name) });
        if (result) bySkin[result.skinId] = result.fileName;
      } catch (e) {
        console.error(`- "${styleName}/${sub.name}": erro processando -- ${e.message}`);
      }
    }

    if (Object.keys(bySkin).length === 0) {
      console.warn(`- "${styleName}": nenhum tom de pele completo, pulei a barba inteira.`);
      continue;
    }

    console.log(`- "${styleName}" -> id "${styleId}" (${Object.keys(bySkin).length} tom(ns) de pele)`);
    const label = (await readOptionalLabel(dir, children)) || humanize(styleName);
    takenIds.add(styleId);
    catalog.push({ id: styleId, label, bySkin });
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
