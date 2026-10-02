// Fica de olho nas pastas de origem de cabelo e de tom de pele (ver
// scripts/avatarAssetsConfig.mjs) e roda os scripts de sincronização de
// novo toda vez que algo muda em qualquer uma delas (pasta nova, arquivo
// trocado, item apagado) -- é isso que faz um item aparecer no jogo só
// de criar a pasta com as imagens, sem precisar rodar nada na mão nem
// mandar as imagens pelo chat. Sobe junto com `npm run dev` (ver
// package.json, processo "assets" no concurrently).
//
// Usa fs.watch com recursive:true (suportado no macOS/Windows -- roda
// bem na máquina do Douglas; em Linux essa opção não existe, então nesse
// caso cai pra um fallback sem recursividade, olhando só a pasta de
// primeiro nível, que ainda cobre "criei uma pasta nova").

import { watch, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
  CABELO_SRC_ROOT,
  AVATAR_SKIN_SRC_ROOT,
  BARBA_SRC_ROOT,
  ACESSORIO_SRC_ROOT,
  TRAJE_SRC_ROOT,
  PISO_SRC_ROOT,
  POLTRONAS_SRC_ROOT,
  PAREDES_SRC_ROOT,
} from "./avatarAssetsConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DESLIGADOS (achado investigando "ta lentao"/travamento, Douglas
// testando a sala): cabelo/tom de pele/barba/acessório/traje geram
// GENERATED_HAIR_CATALOG/GENERATED_SKIN_CATALOG/GENERATED_BEARD_CATALOG/
// GENERATED_ACCESSORY_CATALOG/GENERATED_OUTFIT_CATALOG (ver
// game/*Catalog.generated.ts), mas NENHUM desses é importado em
// HAIR_CATALOG/SKIN_CATALOG/BEARD_CATALOG/ACCESSORY_CATALOG/
// OUTFIT_CATALOG (game/customization.ts) desde que o Douglas decidiu
// "rapa tudo que tem de item, vou subir tudo pela plataforma" (tudo via
// Editor de Itens > Criar Avatar, registerCustomXxx em tempo de
// execução, não mais pasta local) -- ou seja, essa metade do vigia
// processava (sharp: recorte/trim/resize) DEZENAS de imagens grandes
// pra escrever um arquivo que nada no jogo lê, SEMPRE que algo mexia em
// qualquer uma dessas 5 pastas de origem (incluindo o iCloud mexendo
// sozinho por baixo dos panos, ver histórico do chat) -- CPU torrada à
// toa, sem nenhum efeito no jogo. piso/poltrona/parede continuam
// ligados porque esses SÃO importados de verdade (FLOOR_CATALOG/
// FURNITURE_MODELS/WALL_CATALOG, ver game/floor.ts, game/furniture.ts,
// game/wall.ts). Pra religar um dos 5 de volta (se o Douglas voltar a
// usar a pasta local pra avatar), é só: (1) descomentar a linha dele
// aqui embaixo, e (2) reimportar o GENERATED_X_CATALOG correspondente
// dentro de game/customization.ts (comentário grande explicando onde,
// em cada catálogo).
const TARGETS = [
  // { label: "cabelo", srcRoot: CABELO_SRC_ROOT, script: path.join(__dirname, "syncAvatarAssets.mjs") },
  // { label: "tom de pele", srcRoot: AVATAR_SKIN_SRC_ROOT, script: path.join(__dirname, "syncSkinAssets.mjs") },
  // { label: "barba", srcRoot: BARBA_SRC_ROOT, script: path.join(__dirname, "syncBeardAssets.mjs") },
  // { label: "acessório", srcRoot: ACESSORIO_SRC_ROOT, script: path.join(__dirname, "syncAccessoryAssets.mjs") },
  // { label: "traje", srcRoot: TRAJE_SRC_ROOT, script: path.join(__dirname, "syncOutfitAssets.mjs") },
  { label: "piso", srcRoot: PISO_SRC_ROOT, script: path.join(__dirname, "syncFloorAssets.mjs") },
  { label: "poltrona", srcRoot: POLTRONAS_SRC_ROOT, script: path.join(__dirname, "syncFurnitureAssets.mjs") },
  { label: "parede", srcRoot: PAREDES_SRC_ROOT, script: path.join(__dirname, "syncWallAssets.mjs") },
];

function watchTarget({ label, srcRoot, script }) {
  let pending = false;
  let running = false;

  function runSync() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const child = spawn(process.execPath, [script], { stdio: "inherit" });
    child.on("exit", () => {
      running = false;
      if (pending) {
        pending = false;
        runSync();
      }
    });
  }

  let debounceTimer = null;
  function scheduleSync() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSync, 400);
  }

  if (!existsSync(srcRoot)) {
    mkdirSync(srcRoot, { recursive: true });
  }

  console.log(`[assets] observando ${srcRoot} (${label}) pra sincronizar automaticamente...`);
  runSync(); // roda uma vez já de cara, pra pegar pastas que já existiam antes de subir o dev

  try {
    watch(srcRoot, { recursive: true }, () => scheduleSync());
  } catch {
    console.warn(`[assets] recursive:true não suportado nesse sistema pra ${label}, observando só o primeiro nível.`);
    watch(srcRoot, () => scheduleSync());
  }
}

for (const target of TARGETS) watchTarget(target);
