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
} from "./avatarAssetsConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  { label: "cabelo", srcRoot: CABELO_SRC_ROOT, script: path.join(__dirname, "syncAvatarAssets.mjs") },
  { label: "tom de pele", srcRoot: AVATAR_SKIN_SRC_ROOT, script: path.join(__dirname, "syncSkinAssets.mjs") },
  { label: "barba", srcRoot: BARBA_SRC_ROOT, script: path.join(__dirname, "syncBeardAssets.mjs") },
  { label: "acessório", srcRoot: ACESSORIO_SRC_ROOT, script: path.join(__dirname, "syncAccessoryAssets.mjs") },
  { label: "traje", srcRoot: TRAJE_SRC_ROOT, script: path.join(__dirname, "syncOutfitAssets.mjs") },
  { label: "piso", srcRoot: PISO_SRC_ROOT, script: path.join(__dirname, "syncFloorAssets.mjs") },
  { label: "poltrona", srcRoot: POLTRONAS_SRC_ROOT, script: path.join(__dirname, "syncFurnitureAssets.mjs") },
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
