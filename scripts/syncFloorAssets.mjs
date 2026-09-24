// Sincroniza os modelos de PISO (porcelanato, laminado) a partir de uma
// pasta de "arte crua" (ver PISO_SRC_ROOT em scripts/avatarAssetsConfig.mjs)
// -- bem mais simples que os pipelines de avatar (cabelo/pele/barba/
// acessório): piso não tem poses (é uma textura PLANA, sem direção) nem
// cores aninhadas, só subpastas FIXAS (a categoria) e, dentro de cada
// uma, um arquivo de imagem por modelo/padrão:
//
//   Piso/
//     Porcelanato/
//       Branco fosco.png
//       Cinza acetinado.jpg
//     Laminado/
//       Carvalho.png
//       ...
//     Natural/
//       Grama.png
//       ...
//
// O nome do ARQUIVO (sem extensão) vira o rótulo do modelo -- não
// precisa de subpasta nem de arquivo label.txt/nome.txt como nos outros
// pipelines. Categorias com nome diferente de "Porcelanato"/"Laminado"/
// "Natural" são ignoradas (avisa no console) -- são as únicas que o
// editor de piso (ver FLOOR_CATEGORIES em game/floor.ts) sabe mostrar
// por enquanto. Uma subpasta "_raw" (ou qualquer uma começando com "_")
// dentro de uma categoria é ignorada também -- útil pra guardar imagem
// de referência/fonte crua que não deve virar opção no editor (ver
// Piso/Natural/_raw/ -- não confundir com Piso/_to_delete/, que é o
// mesmo esquema só que na raiz de Piso, não dentro de uma categoria).
//
// Gera public/assets/piso_<categoria>-<slug>.png (recortado/redimensionado
// pra um quadrado, ver FLOOR_TEXTURE_SIZE) e game/floorCatalog.generated.ts
// -- reescrito toda vez, não editar à mão.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { ROOT, PISO_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import { imageFiles, slugify, humanize } from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "floorCatalog.generated.ts");

// quadrado -- múltiplo do TILE (60px, ver game/grid.ts) pra ficar nítido
// tanto no jogo (desenhado em 60x60) quanto na miniatura maior da paleta
// do editor. "cover" (não "contain"): textura de piso não pode ter
// bordas transparentes/vazadas, prefere cortar o excesso a sobrar vazio.
const FLOOR_TEXTURE_SIZE = 240;

// só essas categorias por enquanto (ver FLOOR_CATEGORIES em
// game/floor.ts) -- pasta de primeiro nível com outro nome é ignorada.
const CATEGORY_BY_FOLDER = {
  porcelanato: "porcelanato",
  laminado: "laminado",
  natural: "natural",
};

async function buildOne(category, filePath, idLabel, takenIds) {
  const slug = slugify(idLabel);
  const id = `${category}-${slug}`;
  if (!slug) {
    console.warn(`  - "${idLabel}": nome inválido pra virar id, pulei.`);
    return null;
  }
  if (takenIds.has(id)) {
    console.warn(`  - "${idLabel}" (id "${id}"): id repetido/já usado no catálogo, pulei -- renomeie o arquivo.`);
    return null;
  }

  const fileName = `piso_${id}.png`;
  await sharp(filePath)
    .ensureAlpha()
    .resize(FLOOR_TEXTURE_SIZE, FLOOR_TEXTURE_SIZE, { fit: "cover" })
    .png()
    .toFile(path.join(OUT_DIR, fileName));

  takenIds.add(id);
  console.log(`  - "${idLabel}" -> id "${id}"`);
  return { id, category, label: humanize(idLabel), file: fileName };
}

async function main() {
  // cria as duas subpastas de categoria se ainda não existirem -- tanto
  // faz se SRC_ROOT em si já existia (ex: watchAvatarAssets.mjs cria a
  // pasta vazia antes de chamar este script) ou não, mkdir com
  // recursive:true não reclama se já existir.
  const alreadyHadRoot = existsSync(SRC_ROOT);
  await mkdir(path.join(SRC_ROOT, "Porcelanato"), { recursive: true });
  await mkdir(path.join(SRC_ROOT, "Laminado"), { recursive: true });
  await mkdir(path.join(SRC_ROOT, "Natural"), { recursive: true });
  if (!alreadyHadRoot) {
    console.log(`Criei ${SRC_ROOT} com as pastas Porcelanato/, Laminado/ e Natural/ -- solte um arquivo de imagem por modelo aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando piso (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const takenIds = new Set();
  const catalog = [];

  for (const dirEntry of topDirs) {
    const category = CATEGORY_BY_FOLDER[slugify(dirEntry.name)];
    if (!category) {
      console.warn(`- "${dirEntry.name}": categoria desconhecida (esperado "Porcelanato" ou "Laminado"), pulei a pasta inteira.`);
      continue;
    }
    console.log(`- ${dirEntry.name}:`);
    const dir = path.join(SRC_ROOT, dirEntry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const files = imageFiles(children);
    if (files.length === 0) {
      console.log(`  (nenhum arquivo de imagem ainda)`);
      continue;
    }
    for (const file of files) {
      const idLabel = file.replace(/\.[a-z0-9]+$/i, "");
      try {
        const result = await buildOne(category, path.join(dir, file), idLabel, takenIds);
        if (result) catalog.push(result);
      } catch (e) {
        console.error(`  - "${file}": erro processando -- ${e.message}`);
      }
    }
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncFloorAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um modelo, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { FloorCatalogEntry } from "./floor";\n\n';
  const body = `export const GENERATED_FLOOR_CATALOG: FloorCatalogEntry[] = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${catalog.length} modelo(s) de piso gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar piso:", e);
  process.exitCode = 1;
});
