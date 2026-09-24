// Sincroniza tons de pele/corpo base (camada "base" do avatar) a partir
// de uma pasta de arte crua (ver AVATAR_SKIN_SRC_ROOT em
// scripts/avatarAssetsConfig.mjs) -- cada pasta de primeiro nível
// (Branco/Pardo/Negro...) é UM tom.
//
// Roda DUAS vezes, uma pra cada "sexo" (ver AvatarGender em
// customization.ts e o botão Masculino/Feminino em ProfileCard,
// GameRoom.tsx): a pasta de cima (AVATAR_SKIN_SRC_ROOT) pro masculino, e
// uma pasta IRMÃ (AVATAR_SKIN_SRC_ROOT_FEMININO, mesmo esquema -- uma
// subpasta por tom dentro) pro feminino. Os tons femininos ganham id
// prefixado "feminino-" (ex: pasta "Pardo" -> id "feminino-pardo") pra
// nunca colidir com um tom masculino de mesmo nome.
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
import {
  ROOT,
  AVATAR_SKIN_SRC_ROOT as SRC_ROOT,
  AVATAR_SKIN_SRC_ROOT_FEMININO as SRC_ROOT_FEMININO,
} from "./avatarAssetsConfig.mjs";
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

/**
 * Sincroniza UMA pasta-raiz de tom de pele (uma subpasta por tom dentro
 * dela) pro catálogo -- chamada uma vez pra cada "sexo" (ver AvatarGender
 * em game/customization.ts): a de cima (SRC_ROOT, sempre existiu) pro
 * masculino, a nova (SRC_ROOT_FEMININO) pro feminino. `idPrefix` evita
 * colisão de id entre as duas pastas quando o nome do tom é igual nas
 * duas (ex: "Pardo" nas duas -- vira "pardo" e "feminino-pardo"); o HEX
 * de cor do swatch (SKIN_HEX_BY_NAME) continua batendo pelo NOME da
 * pasta (sem prefixo), então funciona igual nos dois sexos. `takenIds`
 * é compartilhado entre as duas chamadas (ids finais, já com prefixo)
 * só pra pegar um erro de configuração bizarro (as duas pastas apontando
 * pro mesmo lugar), não deveria colidir em uso normal.
 *
 * `relaxMissingHeads` (pedido do Douglas, só a pasta feminino usa --
 * ver chamada em main()): em vez de PULAR um tom com cabeça faltando,
 * reaproveita uma cabeça já encontrada (de preferência "frente") nas
 * direções que faltam, só pra dar pra ver o resultado no jogo enquanto
 * as outras 3 não sobem -- fica com a MESMA arte de frente virada nas
 * costas/lados, não é resultado final. Só pula de vez se não achar
 * NENHUMA das 4.
 */
async function syncGenderRoot(srcRoot, gender, idPrefix, takenIds, { relaxMissingHeads = false } = {}) {
  if (!existsSync(srcRoot)) {
    await mkdir(srcRoot, { recursive: true });
    console.log(`Criei ${srcRoot} (estava vazia) -- crie uma pasta por tom de pele aí dentro.`);
  }

  const topEntries = await readdir(srcRoot, { withFileTypes: true });
  const topDirs = topEntries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));
  console.log(`Sincronizando tom de pele (${gender}, ${topDirs.length} pasta(s) encontrada(s) em ${srcRoot})...`);

  const results = [];
  for (const entry of topDirs) {
    const dir = path.join(srcRoot, entry.name);
    const rawId = slugify(entry.name);
    const id = rawId ? `${idPrefix}${rawId}` : "";
    if (!rawId) {
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
      if (!relaxMissingHeads || Object.keys(found).length === 0) {
        console.warn(`- "${entry.name}" (${gender}): faltam as cabeças [${missing.join(", ")}], pulei (item incompleto).`);
        continue;
      }
      const fallbackDirection = found.down ? "down" : Object.keys(found)[0];
      for (const missingDir of missing) found[missingDir] = found[fallbackDirection];
      console.warn(
        `- "${entry.name}" (${gender}): faltam as cabeças [${missing.join(", ")}] -- reaproveitando "${fallbackDirection}" nelas só pra prévia (troque pelos recortes certos depois).`
      );
    }

    console.log(`- "${entry.name}" (${gender}) -> id "${id}"`);
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
      results.push({ id, label, file: fileName, ...(hex ? { hex } : {}), gender });
    } catch (e) {
      console.error(`- "${entry.name}" (${gender}): erro processando -- ${e.message}`);
    }
  }

  return results;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await ensureReferenceTemplates();

  const takenIds = new Set();
  const masculino = await syncGenderRoot(SRC_ROOT, "masculino", "", takenIds);
  const feminino = await syncGenderRoot(SRC_ROOT_FEMININO, "feminino", "feminino-", takenIds, {
    relaxMissingHeads: true,
  });
  const results = [...masculino, ...feminino];

  const header =
    "// GERADO AUTOMATICAMENTE por scripts/syncSkinAssets.mjs -- NÃO EDITE À MÃO.\n" +
    "// Pra adicionar/mudar um tom de pele, mexa na pasta de origem configurada em\n" +
    "// scripts/avatarAssetsConfig.mjs -- com `npm run dev` rodando isso já roda sozinho.\n\n" +
    'import type { SkinOption } from "./customization";\n\n';
  const body = `export const GENERATED_SKIN_CATALOG: SkinOption[] = ${JSON.stringify(results, null, 2)};\n`;
  await writeFile(CATALOG_OUT, header + body, "utf8");

  console.log(
    `Pronto: ${masculino.length} tom(ns) masculino(s) + ${feminino.length} tom(ns) feminino(s) gerado(s), catálogo escrito em ${path.relative(ROOT, CATALOG_OUT)}.`
  );
}

main().catch((e) => {
  console.error("Falha ao sincronizar tons de pele:", e);
  process.exitCode = 1;
});
