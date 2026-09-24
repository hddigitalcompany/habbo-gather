// Sincroniza MODELOS de poltrona a partir de uma pasta de arte crua (ver
// POLTRONAS_SRC_ROOT em scripts/avatarAssetsConfig.mjs) -- esquema
// próprio, mais fundo que o de piso e diferente do de traje/barba:
//
//   Poltronas/
//     Gamer/
//       Rosa/
//         Frente.png
//         esquerda.png
//         direita.png
//         Costas.png
//       azul/
//         ...
//     Poltrona Lecce/
//       dourada/
//         ...
//
// Pasta de primeiro nível = MODELO (o desenho/formato da peça -- vira um
// FurnitureModelDef, ver game/furniture.ts). Dentro de cada modelo, uma
// subpasta por COR, com os 4 arquivos de direção (mesmos nomes aceitos
// de sempre, sem diferenciar maiúscula/acento/espaço x hífen nem sufixo
// tipo " (1)" -- ver normalizeBase em spriteSheetUtils.mjs): "frente",
// "esquerda", "direita", "costas" (NÃO é "lado esq"/"lado dir" como no
// avatar -- a nomenclatura que o Douglas já usou nessa pasta é outra).
// Uma cor sem os 4 arquivos é pulada (aviso no console); um modelo sem
// NENHUMA cor completa é pulado inteiro.
//
// Diferente do avatar (cabelo/pele/traje), aqui NÃO tem grade 8x2 nem
// pose -- cada arquivo já vira uma imagem solta em public/assets/ (igual
// poltrona_frente.png etc já funcionava, ver FURNITURE_ART em
// game/furniture.ts), só que agora uma POR MODELO+COR. Aparada
// (sharp.trim()) pra tirar qualquer sobra de fundo transparente ao redor
// do desenho, mesma convenção das artes de móvel já existentes (que são
// recortadas rente ao contorno da peça, não um quadro fixo).
//
// A posição em que o boneco senta em cada modelo (seatOffsetX/Y) NÃO
// vem daqui -- isso é ajustado depois, direto no jogo, pelo Douglas (ver
// "Assento" no editor de espaço, GameRoom.tsx) e fica salvo à parte no
// servidor (ver roomStore.js). Um modelo novo, recém-sincronizado, já
// senta numa posição padrão razoável (ver resolveSeatOffset em
// game/furniture.ts) até alguém ajustar fino.
//
// Gera public/assets/poltrona_<modelo>_<cor>_<direcao>.png e
// game/furnitureModels.generated.ts com um FurnitureModelDef por modelo
// (cada um com a lista de cores, ver GENERATED_FURNITURE_MODELS) --
// reescrito toda vez, não editar à mão.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { ROOT, POLTRONAS_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import { imageFiles, readOptionalLabel, slugify, humanize, normalizeBase } from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "furnitureModels.generated.ts");

// pasta -> direção do jogo (down/left/right/up, ver game/grid.ts) --
// nomes diferentes dos usados no avatar de propósito, ver comentário no
// topo do arquivo.
const DIRECTION_FILE_ALIASES = {
  down: ["frente"],
  left: ["esquerda"],
  right: ["direita"],
  up: ["costas"],
};

const DIRECTION_SUFFIX = { down: "frente", left: "lado_esq", right: "lado_dir", up: "costas" };

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

/** Processa UM arquivo de direção -- apara a sobra transparente ao redor (sharp.trim()) e garante alpha, sem redimensionar (a arte de móvel não segue um quadro fixo, ver comentário no topo). */
async function buildDirectionFile(filePath, outFile) {
  await sharp(filePath).ensureAlpha().trim().png().toFile(path.join(OUT_DIR, outFile));
}

/** Sincroniza UMA cor dentro de um modelo -- devolve {id, label, art} ou null se faltar alguma direção. */
async function buildColor({ modelName, modelId, colorFolderName, dir, entries }) {
  const colorId = slugify(colorFolderName);
  if (!colorId) {
    console.warn(`  - "${colorFolderName}": nome de cor inválido pra virar id, pulei.`);
    return null;
  }

  const { found, missing } = findDirectionFiles(imageFiles(entries));
  if (missing.length > 0) {
    console.warn(
      `  - "${colorFolderName}": faltam os arquivos [${missing.join(", ")}] (frente/esquerda/direita/costas), pulei essa cor (incompleta).`
    );
    return null;
  }

  const art = {};
  for (const [direction, fileName] of Object.entries(found)) {
    const outFile = `poltrona_${modelId}_${colorId}_${DIRECTION_SUFFIX[direction]}.png`;
    try {
      await buildDirectionFile(path.join(dir, fileName), outFile);
      art[direction] = outFile;
    } catch (e) {
      console.error(`  - "${colorFolderName}/${fileName}": erro processando -- ${e.message}`);
      return null;
    }
  }

  const label = (await readOptionalLabel(dir, entries)) || humanize(colorFolderName);
  return { id: colorId, label, art };
}

async function main() {
  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(
      `Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por MODELO aí dentro, e dentro de cada uma, uma subpasta por COR com frente/esquerda/direita/costas.`
    );
  }
  await mkdir(OUT_DIR, { recursive: true });

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando poltrona (${topDirs.length} modelo(s) encontrado(s) em ${SRC_ROOT})...`);

  const models = [];
  const takenModelIds = new Set();

  for (const modelEntry of topDirs) {
    const modelName = modelEntry.name;
    const modelId = slugify(modelName);
    if (!modelId) {
      console.warn(`- "${modelName}": nome de modelo inválido pra virar id, pulei.`);
      continue;
    }
    if (takenModelIds.has(modelId)) {
      console.warn(`- "${modelName}" (id "${modelId}"): id repetido/já usado, pulei -- renomeie a pasta.`);
      continue;
    }

    const modelDir = path.join(SRC_ROOT, modelName);
    const children = await readdir(modelDir, { withFileTypes: true });
    const colorDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith("_") && !c.name.startsWith("."));
    if (colorDirs.length === 0) {
      console.warn(`- "${modelName}": nenhuma subpasta de cor dentro, pulei.`);
      continue;
    }

    console.log(`- "${modelName}" -> id "${modelId}":`);
    const colors = [];
    const takenColorIds = new Set();
    for (const colorEntry of colorDirs) {
      const colorDir = path.join(modelDir, colorEntry.name);
      const colorEntries = await readdir(colorDir, { withFileTypes: true });
      try {
        const result = await buildColor({
          modelName,
          modelId,
          colorFolderName: colorEntry.name,
          dir: colorDir,
          entries: colorEntries,
        });
        if (!result) continue;
        if (takenColorIds.has(result.id)) {
          console.warn(`  - "${colorEntry.name}" (id "${result.id}"): cor repetida/já usada, pulei -- renomeie a pasta.`);
          continue;
        }
        takenColorIds.add(result.id);
        colors.push(result);
        console.log(`    - "${colorEntry.name}" -> cor "${result.id}" ok`);
      } catch (e) {
        console.error(`  - "${colorEntry.name}": erro processando -- ${e.message}`);
      }
    }

    if (colors.length === 0) {
      console.warn(`- "${modelName}": nenhuma cor completa, pulei o modelo inteiro.`);
      continue;
    }

    const label = (await readOptionalLabel(modelDir, children)) || humanize(modelName);
    takenModelIds.add(modelId);
    models.push({ id: modelId, type: "poltrona", label, colors });
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncFurnitureAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um modelo de poltrona, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { FurnitureModelDef } from "./furniture";\n\n';
  const body = `export const GENERATED_FURNITURE_MODELS: FurnitureModelDef[] = ${JSON.stringify(models, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  const totalColors = models.reduce((n, m) => n + m.colors.length, 0);
  console.log(
    `Pronto: ${models.length} modelo(s) de poltrona (${totalColors} cor(es) no total) gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`
  );
}

main().catch((e) => {
  console.error("Falha ao sincronizar poltrona:", e);
  process.exitCode = 1;
});
