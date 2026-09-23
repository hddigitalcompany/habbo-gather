// Sincroniza itens de cabelo a partir de uma pasta de "arte crua" (ver
// scripts/avatarAssetsConfig.mjs pra onde essa pasta fica) -- o Douglas
// organiza uma pasta por item, com 4 imagens dentro (frente, lado
// esquerdo, lado direito, costas -- aceita vários jeitos de nomear, ver
// POSE_FILE_ALIASES/normalizeBase em scripts/spriteSheetUtils.mjs), e
// esse script:
//
//   1. monta o spritesheet final (grade 8x2, 200x260 por frame, 2px de
//      espaço -- MESMO layout que MainScene.ts espera) repetindo cada
//      pose crua nos frames de andar+sentado que usam aquela direção
//      (ver FRAME_SLOTS embaixo -- cabelo não anima diferente por passo);
//   2. salva em public/assets/cabelo_<slug>.png;
//   3. gera game/customizationCatalog.generated.ts -- esse arquivo é
//      reescrito TODA VEZ (não edite à mão), e game/customization.ts
//      importa ele e junta com os itens manuais (ondulado,
//      vorcarinho-do-roi).
//
// Duas formas de organizar as pastas são aceitas:
//   a) "plana": <origem>/<item>/{frente,lado esq,lado dir,costas}.png
//      -> vira UM item novo e independente no catálogo (grade principal).
//   b) "aninhada" (estilo -> cor), do jeito que o Douglas já organiza em
//      Cabelos/: <origem>/<Estilo>/<Cor>/{...as 4 poses...} -- quando uma
//      pasta de primeiro nível NÃO tem as 4 poses direto mas tem
//      subpastas, cada subpasta é uma VARIAÇÃO DE COR daquele estilo
//      (não um item novo -- ver MANUAL_STYLE_MATCH embaixo):
//        - se o nome da pasta de estilo bate com um item que JÁ existe à
//          mão em game/customization.ts (ex: "Cabelinho pra trás"), as
//          cores entram dentro do `colors` DESSE item (não cria tile
//          novo na grade -- é a cor que aparece selecionável, dentro do
//          penteado já existente);
//        - senão, cria um item novo com aquele nome, já com as cores
//          encontradas dentro de `colors`.
//
// Roda uma vez com `npm run sync-assets`, ou automaticamente sempre que
// algo muda na pasta de origem (ver scripts/watchAvatarAssets.mjs, que já
// sobe junto com `npm run dev`) -- assim o item aparece no jogo só de
// criar a pasta, sem precisar mandar as imagens pra mim (Claude) nem
// mexer em código.
//
// Pra alinhar a arte nova com a cabeça do avatar base, use os arquivos-
// referência em <origem>/_referencia/ (recortados direto do
// avatar_visual1.png) como fundo/guia no seu editor de imagem -- exporte
// cada pose já no tamanho 200x260, na mesma posição da referência.

import { readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { ROOT, CABELO_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";
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
const CATALOG_OUT = path.join(ROOT, "game", "customizationCatalog.generated.ts");
const REFERENCE_DIR = path.join(SRC_ROOT, "_referencia");

// índice do frame (0-14, ver WALK_FRAMES/SENTADO_FRAMES em MainScene.ts)
// -> qual das 4 poses cruas entra ali. O frame 15 (última célula da
// grade 8x2) fica em branco, igual aos spritesheets já existentes
// (avatar_visual1.png/cabelo_1.png) -- não é usado por ninguém.
const FRAME_SLOTS = [
  "frente", "frente", "frente", // down: parado, passoA, passoB
  "lado_esq", "lado_esq", "lado_esq", // left
  "lado_dir", "lado_dir", "lado_dir", // right
  "costas", "costas", "costas", // up
  "frente", "lado_esq", "lado_dir", // sentado: down, left, right (sentado "up" reusa o frame 9, ver SENTADO_FRAMES)
];

// nome normalizado (ver normalizeBase) que cada pose aceita -- cobre os
// jeitos que já apareceram na prática: "frente"/"Cabelo Frente", "lado
// esq"/"lado_esq"/"lado-esq"/"Lado esq", "lado dir"/"lado_dir"/"lado-dir",
// "costas" (inclusive com sufixo tipo "costas (1)", tratado no
// normalizeBase).
const POSE_FILE_ALIASES = {
  frente: ["frente", "cabelo frente"],
  lado_esq: ["lado esq", "lado esquerdo", "cabelo lado esq"],
  lado_dir: ["lado dir", "lado direito", "cabelo lado dir"],
  costas: ["costas", "cabelo costas"],
};

// nome de pasta de ESTILO (normalizado) -> id do item manual correspondente
// em game/customization.ts -- quando uma pasta aninhada (estilo/cor) bate
// com um desses, as cores entram dentro do item manual em vez de criar um
// item novo (ver comentário grande no topo do arquivo).
const MANUAL_STYLE_MATCH = {
  "cabelinho pra tras": "ondulado",
  "vorcarinho do roi": "vorcarinho-do-roi",
};

async function ensureReferenceTemplates() {
  const need = ["frente", "lado_esq", "lado_dir", "costas"].some(
    (k) => !existsSync(path.join(REFERENCE_DIR, `${k}.png`))
  );
  if (!need) return;
  const baseAvatarPath = path.join(OUT_DIR, "avatar_visual1.png");
  if (!existsSync(baseAvatarPath)) return;
  await extractReferenceFrames(baseAvatarPath, REFERENCE_DIR, { frente: 0, lado_esq: 3, lado_dir: 6, costas: 9 });
  console.log(
    `Gerei referências de alinhamento em ${path.relative(ROOT, REFERENCE_DIR)}/ (recortadas do avatar base) -- use como guia no editor de imagem.`
  );
}

/** Compõe o spritesheet de UM conjunto de 4 poses (uma pasta) -- devolve {id, label, file} ou null se inválido/incompleto. idLabel decide o id/arquivo (precisa ser único no catálogo inteiro); defaultLabel é o nome mostrado quando não tem label.txt. */
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
  const frameBuffers = {};
  for (const [poseKey, fileName] of Object.entries(found)) {
    frameBuffers[poseKey] = await loadFrame(path.join(dir, fileName), `${idLabel}/${fileName}`, path.relative(ROOT, REFERENCE_DIR));
  }

  const sheet = await composeSheet(frameBuffers, FRAME_SLOTS);
  const fileName = `cabelo_${id}.png`;
  await writeFile(path.join(OUT_DIR, fileName), sheet);

  const label = (await readOptionalLabel(dir, entries)) || humanize(defaultLabel);
  takenIds.add(id);
  return { id, label, file: fileName };
}

async function main() {
  // itens manuais já existentes em game/customization.ts -- não deixa um
  // item gerado roubar o id de nenhum dos dois.
  const takenIds = new Set(["ondulado", "vorcarinho-do-roi"]);

  if (!existsSync(SRC_ROOT)) {
    await mkdir(SRC_ROOT, { recursive: true });
    console.log(`Criei ${SRC_ROOT} (estava vazia) -- crie uma pasta por item de cabelo aí dentro.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const topEntries = await readdir(SRC_ROOT, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando cabelo (${topDirs.length} pasta(s) de primeiro nível em ${SRC_ROOT})...`);

  const flatCatalog = []; // GENERATED_HAIR_CATALOG -- itens novos e independentes
  const colorsByStyle = {}; // GENERATED_HAIR_COLORS_BY_STYLE -- cores de um item manual já existente

  for (const entry of topDirs) {
    const dir = path.join(SRC_ROOT, entry.name);
    const children = await readdir(dir, { withFileTypes: true });
    const { missing } = findAllPoses(imageFiles(children), POSE_FILE_ALIASES);

    if (missing.length === 0) {
      // pasta "plana" -- as 4 poses direto dentro dela, vira um item
      // isolado (sem variação de cor).
      try {
        const result = await buildOne({ idLabel: entry.name, defaultLabel: entry.name, dir }, takenIds);
        if (result) flatCatalog.push(result);
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

    // pasta de ESTILO com subpastas de COR.
    const manualId = MANUAL_STYLE_MATCH[normalizeBase(entry.name)];
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

    if (manualId) {
      colorsByStyle[manualId] = (colorsByStyle[manualId] ?? []).concat(colorResults);
    } else {
      const styleId = slugify(entry.name);
      if (takenIds.has(styleId)) {
        console.warn(`- "${entry.name}" (id "${styleId}"): id repetido/já usado no catálogo, pulei o item de estilo (as cores já foram geradas).`);
        continue;
      }
      takenIds.add(styleId);
      flatCatalog.push({ id: styleId, label: humanize(entry.name), file: colorResults[0].file, colors: colorResults });
    }
  }

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncAvatarAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um item, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { HairOption, ColorOption } from "./customization";\n\n';
  const body =
    `export const GENERATED_HAIR_CATALOG: HairOption[] = ${JSON.stringify(flatCatalog, null, 2)};\n\n` +
    `export const GENERATED_HAIR_COLORS_BY_STYLE: Record<string, ColorOption[]> = ${JSON.stringify(colorsByStyle, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  const totalColors = Object.values(colorsByStyle).reduce((n, arr) => n + arr.length, 0);
  console.log(
    `Pronto: ${flatCatalog.length} item(ns) novo(s) e ${totalColors} cor(es) de item(ns) manual(is), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`
  );
}

main().catch((e) => {
  console.error("Falha ao sincronizar cabelo:", e);
  process.exitCode = 1;
});
