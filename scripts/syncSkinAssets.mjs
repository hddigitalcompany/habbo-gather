// Sincroniza tons de pele/corpo base (camada "base" do avatar) a partir
// de uma pasta de arte crua (ver AVATAR_SKIN_SRC_ROOT em
// scripts/avatarAssetsConfig.mjs) -- cada pasta de primeiro nível
// (Branco/Pardo/Negro...) é UM tom, com as 15 poses reais (diferente do
// cabelo: aqui cada pose é uma imagem DIFERENTE mesmo, sem repetir --
// frente/lado esq/lado dir/costas, cada um parado + andando A + andando
// B, mais frente/lado esq/lado dir sentado).
//
// Nomes de arquivo aceitos (ver POSE_FILE_ALIASES): "Frente parado",
// "Frente andando A/B", "Lado esq parado/andando A/B/sentado", "lado dir
// parado/andando A/B/sentado", "costas parado/andando A/B", "Frente
// sentado" -- sem diferenciar maiúscula/acento/espaço x hífen (ver
// normalizeBase em spriteSheetUtils.mjs).
//
// Gera public/assets/avatar_<slug>.png (mesmo formato 8x2/200x260 que
// avatar_visual1.png já usa) e game/skinCatalog.generated.ts com um
// SkinOption por pasta -- reescrito toda vez, não editar à mão.

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, AVATAR_SKIN_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import {
  imageFiles,
  findAllPoses,
  loadFrame,
  composeSheet,
  readOptionalLabel,
  slugify,
  humanize,
  normalizeBase,
  extractReferenceFrames,
} from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "skinCatalog.generated.ts");
const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");

// ordem dos 15 frames da grade 8x2 -- ver WALK_FRAMES/SENTADO_FRAMES em
// MainScene.ts ("up" sentado reusa o frame 9, não tem célula própria).
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

// cor do swatch selecionável (ver ProfileCard em GameRoom.tsx) -- o
// Douglas mandou esses 3 hex direto pelo chat. Nome de pasta normalizado
// -> hex; um tom novo sem nome batendo aqui simplesmente fica sem cor
// definida (swatch cai pro cinza neutro, ver CSS).
const SKIN_HEX_BY_NAME = {
  branco: "#fde6b5",
  pardo: "#d1a276",
  negro: "#765e48",
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

async function main() {
  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por tom de pele aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando tom de pele (${topDirs.length} pasta(s) encontrada(s) em ${SRC_ROOT})...`);

  const results = [];
  const takenIds = new Set();
  for (const entry of topDirs) {
    const dir = path.join(SRC_ROOT, entry.name);
    const id = slugify(entry.name);
    if (!id) {
      console.warn(`- "${entry.name}": nome inválido pra virar id, pulei.`);
      continue;
    }
    if (takenIds.has(id)) {
      console.warn(`- "${entry.name}" (id "${id}"): id repetido, pulei -- renomeie a pasta.`);
      continue;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const { found, missing } = findAllPoses(imageFiles(entries), POSE_FILE_ALIASES);
    if (missing.length > 0) {
      console.warn(`- "${entry.name}": faltam os arquivos [${missing.join(", ")}], pulei (item incompleto).`);
      continue;
    }

    console.log(`- "${entry.name}" -> id "${id}"`);
    try {
      const frameBuffers = {};
      for (const [poseKey, fileName] of Object.entries(found)) {
        frameBuffers[poseKey] = await loadFrame(path.join(dir, fileName), `${entry.name}/${fileName}`, path.relative(ROOT, REFERENCE_DIR));
      }
      const sheet = await composeSheet(frameBuffers, FRAME_SLOTS);
      const fileName = `avatar_${id}.png`;
      await writeFile(path.join(OUT_DIR, fileName), sheet);

      const label = (await readOptionalLabel(dir, entries)) || humanize(entry.name);
      const hex = SKIN_HEX_BY_NAME[normalizeBase(entry.name)];
      takenIds.add(id);
      results.push({ id, label, file: fileName, ...(hex ? { hex } : {}) });
    } catch (e) {
      console.error(`- "${entry.name}": erro processando -- ${e.message}`);
    }
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncSkinAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um tom de pele, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { SkinOption } from "./customization";\n\n';
  const body = `export const GENERATED_SKIN_CATALOG: SkinOption[] = ${JSON.stringify(results, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${results.length} tom(ns) de pele gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar tons de pele:", e);
  process.exitCode = 1;
});
