// Sincroniza os modelos de PAREDE de sistema a partir de uma pasta de
// "arte crua" (ver PAREDES_SRC_ROOT em scripts/avatarAssetsConfig.mjs) --
// pedido do Douglas: "paredes de sistema igual o piso, mesma ideia do
// habbo assim". Esquema mais simples ainda que o de piso: uma pasta só,
// sem categoria/subpasta nenhuma, até 4 arquivo de imagem por ESTILO:
//
//   Paredes/
//     Tijolo vermelho.png
//     Tijolo branco.png
//     Vidro Liso.png                  (base -- poste nas 2 pontas)
//     Vidro Liso - meio.png           (variante opcional -- sem poste)
//     Vidro Liso - ponta esquerda.png (variante opcional -- poste só esquerda)
//     Vidro Liso - ponta direita.png  (variante opcional -- poste só direita)
//
// O nome do ARQUIVO (sem extensão, sem o sufixo de variante quando tem
// um) vira o rótulo do modelo.
//
// Variantes (ver WallCatalogEntry.fileMiddle/fileLeftEnd/fileRightEnd em
// game/wall.ts) -- pedido do Douglas (3 prints): "vidros que e pra dar
// seguimentacao, para vidracas longas, onde so tera perfil nos cantos".
// Detectadas pelo SUFIXO do nome do arquivo (" - meio"/" - ponta
// esquerda"/" - ponta direita", sem diferenciar maiúscula/minúscula) --
// todo arquivo com um desses sufixos junta no mesmo estilo do arquivo
// SEM sufixo de mesmo nome base (ex: "Vidro Liso.png" +
// "Vidro Liso - meio.png" = 1 estilo só, com `file` e `fileMiddle`
// preenchidos). Estilo sem nenhum arquivo de variante (a maioria) =
// só a base, comportamento idêntico a antes dessas variantes existirem.
// Variante(s) sem nenhum arquivo BASE junto = erro (pulei o grupo
// inteiro, avisando) -- `file` é obrigatório em WallCatalogEntry, não
// dá pra montar um estilo só de variante.
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
// Gera public/assets/parede_<slug>[-meio|-ponta-esquerda|-ponta-direita].png
// e game/wallCatalog.generated.ts -- reescrito toda vez, não editar à
// mão.
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

// sufixo (minúsculo, pra comparar) -> { campo no catálogo, "tag" usada
// no nome do arquivo gerado em public/assets/ }
const VARIANT_SUFFIXES = [
  { suffix: " - meio", field: "fileMiddle", outTag: "meio" },
  { suffix: " - ponta esquerda", field: "fileLeftEnd", outTag: "ponta-esquerda" },
  { suffix: " - ponta direita", field: "fileRightEnd", outTag: "ponta-direita" },
];

/** Separa o sufixo de variante (se tiver um) do nome do arquivo (sem
 * extensão) -- devolve null quando é um arquivo BASE (sem sufixo). */
function splitVariant(idLabel) {
  const lower = idLabel.toLowerCase();
  for (const v of VARIANT_SUFFIXES) {
    if (lower.endsWith(v.suffix)) {
      return { baseLabel: idLabel.slice(0, idLabel.length - v.suffix.length).trim(), field: v.field, outTag: v.outTag };
    }
  }
  return null;
}

async function processImage(filePath, outName) {
  await sharp(filePath).ensureAlpha().trim().png().toFile(path.join(OUT_DIR, outName));
  return outName;
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

  // agrupa os arquivos por estilo (slug do nome SEM sufixo de variante)
  // -- cada grupo vira 1 entrada do catálogo, com até 4 arquivos.
  const groups = new Map(); // slug -> { label, base?, fileMiddle?, fileLeftEnd?, fileRightEnd? }
  for (const file of files) {
    const idLabel = file.replace(/\.[a-z0-9]+$/i, "");
    const variant = splitVariant(idLabel);
    const baseLabel = variant ? variant.baseLabel : idLabel;
    const slug = slugify(baseLabel);
    if (!slug) {
      console.warn(`  - "${file}": nome inválido pra virar id, pulei.`);
      continue;
    }
    if (!groups.has(slug)) groups.set(slug, { label: baseLabel });
    const group = groups.get(slug);
    if (variant) {
      if (group[variant.field]) {
        console.warn(`  - "${baseLabel}": mais de um arquivo pra variante "${variant.outTag}", usando o último encontrado (${file}).`);
      }
      group[variant.field] = file;
    } else {
      if (group.base) {
        console.warn(`  - "${baseLabel}": mais de um arquivo BASE, usando o último encontrado (${file}).`);
      }
      group.base = file;
      group.label = baseLabel; // o nome do arquivo BASE manda no rótulo quando existir
    }
  }

  const catalog = [];
  for (const [slug, group] of groups) {
    const id = `sistema-${slug}`;
    if (!group.base) {
      console.warn(`  - "${group.label}": tem variante (meio/ponta) mas nenhum arquivo BASE (sem sufixo) junto -- pulei, \`file\` é obrigatório.`);
      continue;
    }
    try {
      const entry = { id, label: humanize(group.label), file: await processImage(path.join(SRC_ROOT, group.base), `parede_${slug}.png`) };
      if (group.fileMiddle) entry.fileMiddle = await processImage(path.join(SRC_ROOT, group.fileMiddle), `parede_${slug}-meio.png`);
      if (group.fileLeftEnd) entry.fileLeftEnd = await processImage(path.join(SRC_ROOT, group.fileLeftEnd), `parede_${slug}-ponta-esquerda.png`);
      if (group.fileRightEnd) entry.fileRightEnd = await processImage(path.join(SRC_ROOT, group.fileRightEnd), `parede_${slug}-ponta-direita.png`);
      const variantNote = [group.fileMiddle && "meio", group.fileLeftEnd && "ponta-esq", group.fileRightEnd && "ponta-dir"]
        .filter(Boolean)
        .join(" + ");
      console.log(`  - "${group.label}" -> id "${id}"${variantNote ? ` (+ ${variantNote})` : ""}`);
      catalog.push(entry);
    } catch (e) {
      console.error(`  - "${group.label}": erro processando -- ${e.message}`);
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
