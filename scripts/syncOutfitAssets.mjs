// Sincroniza TRAJES (a roupa do pescoço pra baixo, camada única
// "traje" -- ver LAYER_DRAW_ORDER em game/MainScene.ts) a partir de
// uma pasta de arte crua (ver TRAJE_SRC_ROOT em
// scripts/avatarAssetsConfig.mjs).
//
// Esquema da pasta: cada pasta de primeiro nível é UM look (ex:
// "Linho") -- diferente de cabelo/barba/acessório, aqui NÃO tem opção
// "solta" sem subpasta: todo traje precisa de uma SUBPASTA POR TOM DE
// PELE dentro dele, com os MESMOS NOMES usados na pasta de tom de pele
// (ver AVATAR_SKIN_SRC_ROOT/syncSkinAssets.mjs -- "Branco"/"Pardo"/
// "Negro"/etc), porque a mão fica exposta e precisa bater com o tom
// escolhido no avatar (ver outfitFileForSkin/resolveOutfitSkinId em
// game/customization.ts, que troca a arte do traje sozinho conforme o
// tom de pele muda). Cada subpasta de tom leva as 15 poses completas
// (mesmas de frente/lado esq/lado dir/costas, parado+andando A+andando
// B, + sentado down/left/right -- MESMOS nomes de arquivo aceitos da
// pasta de Avatar, ver POSE_FILE_ALIASES abaixo).
//
// Gera public/assets/traje_<look>_<tom>.png (mesmo formato 8x2/200x260
// que os outros spritesheets de camada) e game/outfitCatalog.generated.ts
// com um OutfitOption por pasta de look (bySkin = {tomId: arquivo}) --
// reescrito toda vez, não editar à mão. Um traje sem NENHUM tom
// completo é ignorado (aviso no console); um tom faltando de um traje
// que já tem outro tom ok só fica de fora do bySkin dele
// (resolveOutfitSkinId cai pro primeiro tom que existir).
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, TRAJE_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import {
  imageFiles,
  findAllPoses,
  loadFrame,
  composeSheet,
  readOptionalLabel,
  slugify,
  humanize,
  extractReferenceFrames,
} from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "outfitCatalog.generated.ts");
const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");

// ordem dos 15 frames da grade 8x2 -- MESMA de syncSkinAssets.mjs (traje
// tem arte de verdade nas 15 poses, sem frame em branco, diferente de
// barba/acessório que não tem "costas").
const FRAME_SLOTS = [
  "down_parado", "down_passoA", "down_passoB",
  "left_parado", "left_passoA", "left_passoB",
  "right_parado", "right_passoA", "right_passoB",
  "up_parado", "up_passoA", "up_passoB",
  "down_sentado", "left_sentado", "right_sentado",
];

const POSE_FILE_ALIASES = {
  down_parado: ["frente parado"],
  down_passoA: ["frente andando a"],
  down_passoB: ["frente andando b"],
  left_parado: ["lado esq parado"],
  left_passoA: ["lado esq andando a"],
  left_passoB: ["lado esq andando b"],
  right_parado: ["lado dir parado"],
  right_passoA: ["lado dir andando a"],
  right_passoB: ["lado dir andando b"],
  up_parado: ["costas parado"],
  up_passoA: ["costas andando a"],
  up_passoB: ["costas andando b"],
  down_sentado: ["frente sentado"],
  left_sentado: ["lado esq sentado"],
  right_sentado: ["lado dir sentado"],
};

async function ensureReferenceTemplates() {
  const baseAvatarPath = path.join(OUT_DIR, "avatar_visual1.png");
  const need = Object.keys(POSE_FILE_ALIASES).some((k) => !existsSync(path.join(REFERENCE_DIR, `${k}.png`)));
  if (!need || !existsSync(baseAvatarPath)) return;
  const refPoses = {
    down_parado: 0, down_passoA: 1, down_passoB: 2,
    left_parado: 3, left_passoA: 4, left_passoB: 5,
    right_parado: 6, right_passoA: 7, right_passoB: 8,
    up_parado: 9, up_passoA: 10, up_passoB: 11,
    down_sentado: 12, left_sentado: 13, right_sentado: 14,
  };
  await extractReferenceFrames(baseAvatarPath, REFERENCE_DIR, refPoses);
  console.log(
    `Gerei referências de alinhamento em ${path.relative(ROOT, REFERENCE_DIR)}/ (recortadas do avatar base) -- use como guia no editor de imagem.`
  );
}

/** Compõe o spritesheet de UM traje NUM tom de pele -- devolve {skinId, fileName} ou null se incompleto. */
async function buildVariant({ lookName, skinFolderName, lookId, dir }) {
  const skinId = slugify(skinFolderName);
  if (!skinId) {
    console.warn(`- "${lookName}/${skinFolderName}": nome de tom inválido pra virar id, pulei esse tom.`);
    return null;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const { found, missing } = findAllPoses(imageFiles(entries), POSE_FILE_ALIASES);
  if (missing.length > 0) {
    console.warn(`- "${lookName}/${skinFolderName}": faltam os arquivos [${missing.join(", ")}], pulei esse tom (incompleto).`);
    return null;
  }

  const frameBuffers = {};
  for (const [poseKey, fileName] of Object.entries(found)) {
    frameBuffers[poseKey] = await loadFrame(
      path.join(dir, fileName),
      `${lookName}/${skinFolderName}/${fileName}`,
      path.relative(ROOT, REFERENCE_DIR)
    );
  }
  const sheet = await composeSheet(frameBuffers, FRAME_SLOTS);
  const fileName = `traje_${lookId}_${skinId}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);
  return { skinId, fileName };
}

async function main() {
  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(
      `Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por traje aí dentro, e dentro de cada uma, uma subpasta por tom de pele (mesmos nomes da pasta de Avatar/tom de pele).`
    );
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando traje (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const catalog = [];
  const takenIds = new Set(["nenhum"]);

  for (const entry of topDirs) {
    const lookName = entry.name;
    const lookId = slugify(lookName);
    if (!lookId) {
      console.warn(`- "${lookName}": nome inválido pra virar id, pulei.`);
      continue;
    }
    if (takenIds.has(lookId)) {
      console.warn(`- "${lookName}" (id "${lookId}"): id repetido/já usado no catálogo, pulei -- renomeie a pasta.`);
      continue;
    }

    const dir = path.join(SRC_ROOT, lookName);
    const children = await readdir(dir, { withFileTypes: true });
    const subDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith("_") && !c.name.startsWith("."));
    if (subDirs.length === 0) {
      console.warn(
        `- "${lookName}": nenhuma subpasta de tom de pele dentro (crie uma pasta por tom, ex: "Branco"/"Pardo"/"Negro" -- mesmos nomes da pasta de Avatar), pulei.`
      );
      continue;
    }

    const bySkin = {};
    for (const sub of subDirs) {
      try {
        const result = await buildVariant({ lookName, skinFolderName: sub.name, lookId, dir: path.join(dir, sub.name) });
        if (result) bySkin[result.skinId] = result.fileName;
      } catch (e) {
        console.error(`- "${lookName}/${sub.name}": erro processando -- ${e.message}`);
      }
    }

    if (Object.keys(bySkin).length === 0) {
      console.warn(`- "${lookName}": nenhum tom de pele completo, pulei o traje inteiro.`);
      continue;
    }

    console.log(`- "${lookName}" -> id "${lookId}" (${Object.keys(bySkin).length} tom(ns) de pele)`);
    const label = (await readOptionalLabel(dir, children)) || humanize(lookName);
    takenIds.add(lookId);
    catalog.push({ id: lookId, label, bySkin });
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncOutfitAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um traje, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { OutfitOption } from "./customization";\n\n';
  const body = `export const GENERATED_OUTFIT_CATALOG: OutfitOption[] = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${catalog.length} traje(s) gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar traje:", e);
  process.exitCode = 1;
});
