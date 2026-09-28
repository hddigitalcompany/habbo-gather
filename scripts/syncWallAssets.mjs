// Sincroniza os modelos de PAREDE de sistema a partir de uma pasta de
// "arte crua" (ver PAREDES_SRC_ROOT em scripts/avatarAssetsConfig.mjs) --
// pedido do Douglas: "paredes de sistema igual o piso, mesma ideia do
// habbo assim". Esquema mais simples ainda que o de piso: uma pasta só,
// sem categoria/subpasta nenhuma, um arquivo de imagem por estilo:
//
//   Paredes/
//     Tijolo vermelho.png
//     Tijolo branco.png
//     Madeira.png
//
// O nome do ARQUIVO (sem extensão) vira o rótulo do modelo.
//
// Diferente do piso (que redimensiona pra um quadrado "cover", sem
// transparência -- faz sentido pra uma textura que cobre o losango
// inteiro do tile), a arte de parede é RECORTADA (sharp.trim(), mesma
// convenção de scripts/syncFurnitureAssets.mjs) sem redimensionar --
// cada parede é um painel desenhado já na proporção/inclinação
// isométrica certa (ver o desenho de referência do Douglas: um painel
// de tijolo "deitado" acompanhando o ângulo da aresta do tile, não um
// retângulo reto) e fica ancorada pelo CENTRO-BAIXO (ver
// wallWorldAnchor em game/wall.ts) -- a ALTURA da parede em jogo é
// literalmente o tanto de pixel que o arquivo tem, sem nenhum campo de
// "altura" guardado em lugar nenhum (mesma ideia de móvel: sem campo de
// altura, só o tamanho da imagem).
//
// Gera public/assets/parede_<slug>.png e game/wallCatalog.generated.ts
// -- reescrito toda vez, não editar à mão.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`).

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { ROOT, PAREDES_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
import { imageFiles, slugify, humanize } from "./spriteSheetUtils.mjs";

const OUT_DIR = path.join(ROOT, "public", "assets");
const CATALOG_OUT = path.join(ROOT, "game", "wallCatalog.generated.ts");

async function buildOne(filePath, idLabel, takenIds) {
  const slug = slugify(idLabel);
  const id = `sistema-${slug}`;
  if (!slug) {
    console.warn(`  - "${idLabel}": nome inválido pra virar id, pulei.`);
    return null;
  }
  if (takenIds.has(id)) {
    console.warn(`  - "${idLabel}" (id "${id}"): id repetido/já usado no catálogo, pulei -- renomeie o arquivo.`);
    return null;
  }

  const fileName = `parede_${slug}.png`;
  await sharp(filePath).ensureAlpha().trim().png().toFile(path.join(OUT_DIR, fileName));

  takenIds.add(id);
  console.log(`  - "${idLabel}" -> id "${id}"`);
  return { id, label: humanize(idLabel), file: fileName };
}

async function main() {
  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- solte um arquivo de imagem por ESTILO de parede aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });

  const entries = await readdir(SRC_ROOT, { withFileTypes: true });
  const files = imageFiles(entries);
  console.log(`Sincronizando parede (${files.length} arquivo(s) encontrado(s) em ${SRC_ROOT})...`);

  const takenIds = new Set();
  const catalog = [];
  for (const file of files) {
    const idLabel = file.replace(/\.[a-z0-9]+$/i, "");
    try {
      const result = await buildOne(path.join(SRC_ROOT, file), idLabel, takenIds);
      if (result) catalog.push(result);
    } catch (e) {
      console.error(`  - "${file}": erro processando -- ${e.message}`);
    }
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncWallAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um modelo, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { WallCatalogEntry } from "./wall";\n\n';
  const body = `export const GENERATED_WALL_CATALOG: WallCatalogEntry[] = ${JSON.stringify(catalog, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(`Pronto: ${catalog.length} modelo(s) de parede gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`);
}

main().catch((e) => {
  console.error("Falha ao sincronizar parede:", e);
  process.exitCode = 1;
});
