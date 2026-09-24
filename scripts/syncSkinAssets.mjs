// Sincroniza tons de pele/corpo base (camada "base" do avatar) a partir
// de uma pasta de arte crua (ver AVATAR_SKIN_SRC_ROOT em
// scripts/avatarAssetsConfig.mjs) -- cada pasta de primeiro nível
// (Branco/Pardo/Negro...) é UM tom.
//
// Convenção NOVA (desde que todo avatar sempre usa um traje, ver
// OUTFIT_CATALOG/DEFAULT_OUTFIT_ID em customization.ts -- o traje já
// desenha o corpo inteiro do pescoço pra baixo, com a mão exposta na cor
// certa, ver LAYER_DRAW_ORDER em MainScene.ts): a camada base só
// aparece na parte que o traje deixa de fora, ou seja, só a CABEÇA. Por
// isso agora só pede 4 arquivos por tom -- uma cabeça por direção, SEM
// variação de passo/sentado (a mesma cabeça é reusada nos 4-5 frames
// daquela direção: parado + andando A + andando B, e também sentado nas
// direções que têm, já que sentado só muda o corpo, não a cabeça):
//
//   frente / lado esq / lado dir / costas
//
// Nomes de arquivo aceitos (ver DIRECTION_FILE_ALIASES) -- sem
// diferenciar maiúscula/acento/espaço x hífen nem sufixo tipo " (1)"
// que o macOS gruda em arquivo duplicado (ver normalizeBase em
// spriteSheetUtils.mjs): "Frente", "Lado esq", "lado dir", "costas".
//
// As poses antigas de corpo inteiro (frente/lado/costas andando A/B,
// parado, sentado) que ainda sobrarem na pasta são simplesmente
// ignoradas -- o Douglas disse que vai manter esses arquivos por
// enquanto só de precaução, não fazem mais parte do pipeline.
//
// Gera public/assets/avatar_<slug>.png (mesmo formato 8x2/200x260 que
// avatar_visual1.png já usa, com a cabeça reaproveitada nos frames de
// cada direção) e game/skinCatalog.generated.ts com um SkinOption por
// pasta -- reescrito toda vez, não editar à mão.

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, AVATAR_SKIN_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import {
  imageFiles,
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

// pra cada direção, quais slots da grade acima reusam a MESMA cabeça --
// "up" (costas) não tem slot de sentado (ver FRAME_SLOTS/comentário no
// topo do arquivo, MESMA observação de sempre: "up" sentado reusa o
// frame 9 direto em MainScene.ts, nunca teve célula própria).
const SLOTS_BY_DIRECTION = {
  down: ["down_parado", "down_passoA", "down_passoB", "down_sentado"],
  left: ["left_parado", "left_passoA", "left_passoB", "left_sentado"],
  right: ["right_parado", "right_passoA", "right_passoB", "right_sentado"],
  up: ["up_parado", "up_passoA", "up_passoB"],
};

const DIRECTION_FILE_ALIASES = {
  down: ["frente"],
  left: ["lado esq"],
  right: ["lado dir"],
  up: ["costas"],
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

/** Acha, entre os arquivos de uma pasta de tom, qual bate com cada direção (ver DIRECTION_FILE_ALIASES) -- devolve {found: {direction: fileName}, missing: [direction]}. */
function findDirectionFiles(fileNames) {
  const found = {};
  const missing = [];
  for (const [direction, aliases] of Object.entries(DIRECTION_FILE_ALIASES)) {
    const targets = new Set(aliases);
    const hit = fileNames.find((name) => targets.has(normalizeBase(name)));
    if (hit) found[direction] = hit;
    else missing.push(direction);
  }
  return { found, missing };
}

async function ensureReferenceTemplates() {
  const baseAvatarPath = path.join(OUT_DIR, "avatar_visual1.png");
  const need = Object.keys(DIRECTION_FILE_ALIASES).some(
    (dir) => !existsSync(path.join(REFERENCE_DIR, `${DIRECTION_FILE_ALIASES[dir][0]}.png`))
  );
  if (!need || !existsSync(baseAvatarPath)) return;
  // recorta o frame "parado" de cada direção do avatar base antigo (full
  // body) só como guia de ONDE a cabeça cai dentro do quadro 200x260 --
  // o arquivo novo (cabeça só) não precisa preencher o quadro inteiro,
  // só ficar na mesma posição/escala da cabeça que aparecia aqui.
  const refPoses = { frente: 0, "lado esq": 3, "lado dir": 6, costas: 9 };
  await extractReferenceFrames(baseAvatarPath, REFERENCE_DIR, refPoses);
  console.log(
    `Gerei referências de alinhamento em ${path.relative(ROOT, REFERENCE_DIR)}/ (recortadas do avatar base) -- use como guia de onde a cabeça cai no quadro.`
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
    const { found, missing } = findDirectionFiles(imageFiles(entries));
    if (missing.length > 0) {
      console.warn(`- "${entry.name}": faltam as cabeças [${missing.join(", ")}], pulei (item incompleto).`);
      continue;
    }

    console.log(`- "${entry.name}" -> id "${id}"`);
    try {
      // carrega cada cabeça UMA vez só, depois reusa o mesmo buffer nos
      // 3-4 slots da direção dela (ver SLOTS_BY_DIRECTION) -- não
      // precisa recarregar/reprocessar a mesma imagem várias vezes.
      const frameBuffers = {};
      for (const [direction, fileName] of Object.entries(found)) {
        const buffer = await loadFrame(
          path.join(dir, fileName),
          `${entry.name}/${fileName}`,
          path.relative(ROOT, REFERENCE_DIR)
        );
        for (const slot of SLOTS_BY_DIRECTION[direction]) {
          frameBuffers[slot] = buffer;
        }
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
