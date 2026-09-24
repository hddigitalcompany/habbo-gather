// Configuração compartilhada pelos scripts de sincronização de arte do
// avatar (cabelo, tom de pele/corpo base, barba, acessório, traje) e do
// piso da sala -- principalmente ONDE ficam as pastas de origem.
//
// Por padrão essas pastas ficam DENTRO do projeto (assets-source/cabelo/,
// assets-source/avatar/, assets-source/barba/, assets-source/acessorio/,
// assets-source/traje/, assets-source/piso/), mas podem apontar pra
// qualquer pasta fora dele -- por exemplo uma pasta no Documentos onde
// você já organiza tudo -- criando um arquivo avatar-assets.local.json
// na raiz do projeto com:
//
//   {
//     "cabeloSourceRoot": "/caminho/completo/pra/pasta/Cabelos",
//     "avatarSkinSourceRoot": "/caminho/completo/pra/pasta/Avatar",
//     "avatarSkinSourceRootFeminino": "/caminho/completo/pra/pasta/Avatar feminino",
//     "barbaSourceRoot": "/caminho/completo/pra/pasta/Barba",
//     "acessorioSourceRoot": "/caminho/completo/pra/pasta/Acessório",
//     "trajeSourceRoot": "/caminho/completo/pra/pasta/Trajes",
//     "pisoSourceRoot": "/caminho/completo/pra/pasta/Piso",
//     "poltronasSourceRoot": "/caminho/completo/pra/pasta/Poltronas"
//   }
//
// Esse arquivo fica de fora do git (ver .gitignore) porque o caminho é
// específico da sua máquina.
//
// A pasta de TRAJE e a de BARBA têm o MESMO esquema aninhado: pasta de
// primeiro nível = o traje/look ou o estilo de barba; dentro dela, uma
// SUBPASTA POR TOM DE PELE, com os MESMOS NOMES da pasta de tom de
// pele/Avatar -- "Branco"/"Pardo"/"Negro"/etc -- cada uma com as poses
// completas daquela camada (15 no traje, 3 na barba -- ver
// scripts/syncOutfitAssets.mjs/syncBeardAssets.mjs). É isso que deixa
// escolher o tom de pele do avatar selecionar sozinho a arte certa do
// traje (a mão fica exposta) e da barba, sem escolha manual.
//
// A pasta de piso é mais simples que as de avatar: não tem poses nem
// cores aninhadas, só duas subpastas FIXAS (o nome vira a categoria) --
// "Porcelanato" e "Laminado" -- e dentro de cada uma, um arquivo de
// imagem por modelo/padrão (o nome do arquivo vira o rótulo). Ver
// scripts/syncFloorAssets.mjs.

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

// pasta IRMÃ da de cima (mesmo esquema, uma subpasta por tom de pele
// dentro) pro sexo "feminino" (ver AvatarGender em game/customization.ts
// e o botão Masculino/Feminino em ProfileCard, GameRoom.tsx) -- os tons
// gerados a partir daqui ganham id prefixado "feminino-" (ver
// scripts/syncSkinAssets.mjs) pra nunca colidir com um tom de mesmo nome
// vindo da pasta de cima (ex: "Pardo" nos dois -- "pardo" e
// "feminino-pardo"). Opcional: sem essa chave no avatar-assets.local.json,
// cai numa pasta padrão vazia dentro do projeto (fica sem nenhum tom
// feminino até você criar uma pasta lá dentro, mesmo comportamento de
// primeira-visita da pasta de cima).
export const AVATAR_SKIN_SRC_ROOT_FEMININO = cfg.avatarSkinSourceRootFeminino
  ? cfg.avatarSkinSourceRootFeminino
  : path.join(ROOT, "assets-source", "avatar-feminino");

export const BARBA_SRC_ROOT = cfg.barbaSourceRoot
  ? cfg.barbaSourceRoot
  : path.join(ROOT, "assets-source", "barba");

export const ACESSORIO_SRC_ROOT = cfg.acessorioSourceRoot
  ? cfg.acessorioSourceRoot
  : path.join(ROOT, "assets-source", "acessorio");

export const TRAJE_SRC_ROOT = cfg.trajeSourceRoot
  ? cfg.trajeSourceRoot
  : path.join(ROOT, "assets-source", "traje");

export const PISO_SRC_ROOT = cfg.pisoSourceRoot
  ? cfg.pisoSourceRoot
  : path.join(ROOT, "assets-source", "piso");

// pasta de móveis "Poltrona" -- esquema PRÓPRIO, mais fundo que o de piso:
// pasta de primeiro nível = MODELO (ex: "Gamer", "Poltrona Lecce"), dentro
// dela uma subpasta por COR, e dentro de cada cor os 4 arquivos de direção
// (frente/esquerda/direita/costas). Ver scripts/syncFurnitureAssets.mjs.
// Chave "poltronasSourceRoot" no avatar-assets.local.json (mesmo esquema
// das outras acima) pra apontar pra fora do projeto.
export const POLTRONAS_SRC_ROOT = cfg.poltronasSourceRoot
  ? cfg.poltronasSourceRoot
  : path.join(ROOT, "assets-source", "poltronas");
