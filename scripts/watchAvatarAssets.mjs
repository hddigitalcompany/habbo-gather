// Fica de olho na pasta de origem do cabelo (ver scripts/avatarAssetsConfig.mjs)
// e roda scripts/syncAvatarAssets.mjs de novo toda vez que algo muda lá
// dentro (pasta nova, arquivo trocado, item apagado) -- é isso que faz um
// item de cabelo aparecer no jogo só de criar a pasta com as 4 imagens,
// sem precisar rodar nada na mão nem mandar as imagens pelo chat. Sobe
// junto com `npm run dev` (ver package.json, processo "assets" no
// concurrently).
//
// Usa fs.watch com recursive:true (suportado no macOS/Windows -- roda
// bem na máquina do Douglas; em Linux essa opção não existe, então nesse
// caso cai pra um fallback sem recursividade, olhando só a pasta de
// primeiro nível, que ainda cobre "criei uma pasta nova").

import { watch, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { CABELO_SRC_ROOT as SRC_ROOT } from "./avatarAssetsConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = path.join(__dirname, "syncAvatarAssets.mjs");

let pending = false;
let running = false;

function runSync() {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  const child = spawn(process.execPath, [SYNC_SCRIPT], { stdio: "inherit" });
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

if (!existsSync(SRC_ROOT)) {
  mkdirSync(SRC_ROOT, { recursive: true });
}

console.log(`[assets] observando ${SRC_ROOT} pra sincronizar itens de cabelo automaticamente...`);
runSync();

try {
  watch(SRC_ROOT, { recursive: true }, () => scheduleSync());
} catch {
  console.warn("[assets] recursive:true não suportado nesse sistema, observando só o primeiro nível.");
  watch(SRC_ROOT, () => scheduleSync());
}
