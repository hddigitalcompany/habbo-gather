// Preferência de mic/câmera escolhida no LOBBY (28/set, pedido do
// Douglas vendo a av-bar de dentro da sala: "cade o restante,
// configuracoes, audio, video, tela" -- ele testa/ajusta mic e câmera
// ANTES de entrar, igual Gather/Zoom/Meet, ver components/Lobby.tsx).
// Guardado aqui (client-only, mesmo padrão de lib/identity.ts) pra
// GameRoom.tsx entrar JÁ com a mesma escolha (mic mudo se mutou no
// Lobby, mesma câmera/mic/saída de áudio escolhidos) em vez de sempre
// abrir com tudo ligado no padrão do navegador de novo -- ver
// requestMedia em GameRoom.tsx e os toggles/switches em Lobby.tsx.
// Nada crítico: se o localStorage falhar (Safari privado, etc) cada
// lado só usa o padrão de sempre (tudo ligado, dispositivo padrão).

const KEYS = {
  micOn: "habbo-gather-mic-on",
  camOn: "habbo-gather-cam-on",
  micDeviceId: "habbo-gather-mic-device",
  camDeviceId: "habbo-gather-cam-device",
  speakerDeviceId: "habbo-gather-speaker-device",
};

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage indisponível (aba anônima etc) -- só não persiste
  }
}

function readString(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeString(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // idem acima
  }
}

export function getStoredMicOn(): boolean {
  return readBool(KEYS.micOn, true);
}
export function setStoredMicOn(value: boolean) {
  writeBool(KEYS.micOn, value);
}
export function getStoredCamOn(): boolean {
  return readBool(KEYS.camOn, true);
}
export function setStoredCamOn(value: boolean) {
  writeBool(KEYS.camOn, value);
}
export function getStoredMicDeviceId(): string {
  return readString(KEYS.micDeviceId);
}
export function setStoredMicDeviceId(deviceId: string) {
  writeString(KEYS.micDeviceId, deviceId);
}
export function getStoredCamDeviceId(): string {
  return readString(KEYS.camDeviceId);
}
export function setStoredCamDeviceId(deviceId: string) {
  writeString(KEYS.camDeviceId, deviceId);
}
export function getStoredSpeakerDeviceId(): string {
  return readString(KEYS.speakerDeviceId);
}
export function setStoredSpeakerDeviceId(deviceId: string) {
  writeString(KEYS.speakerDeviceId, deviceId);
}
