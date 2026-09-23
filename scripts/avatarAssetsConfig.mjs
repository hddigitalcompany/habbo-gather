// Configuração compartilhada pelos scripts de sincronização de arte do
// avatar (cabelo e tom de pele/corpo base) -- principalmente ONDE ficam
// as pastas de origem.
//
// Por padrão essas pastas ficam DENTRO do projeto (assets-source/cabelo/,
// assets-source/avatar/), mas podem apontar pra qualquer pasta fora dele
// -- por exemplo uma pasta no Documentos onde você já organiza tudo --
// criando um arquivo avatar-assets.local.json na raiz do projeto com:
//
//   {
//     "cabeloSourceRoot": "/caminho/completo/pra/pasta/Cabelos",
//     "avatarSkinSourceRoot": "/caminho/completo/pra/pasta/Avatar"
//   }
//
// Esse arquivo fica de fora do git (ver .gitignore) porque o caminho é
// específico da sua máquina.

import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");

const CONFIG_PATH = path.join(ROOT, "avatar-assets.local.json");

function readLocalConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn(`aviso: não consegui ler ${path.relative(ROOT, CONFIG_PATH)} (${e.message}), usando padrão.`);
    return {};
  }
}

const cfg = readLocalConfig();

export const CABELO_SRC_ROOT = cfg.cabeloSourceRoot
  ? cfg.cabeloSourceRoot
  : path.join(ROOT, "assets-source", "cabelo");

export const AVATAR_SKIN_SRC_ROOT = cfg.avatarSkinSourceRoot
  ? cfg.avatarSkinSourceRoot
  : path.join(ROOT, "assets-source", "avatar");
