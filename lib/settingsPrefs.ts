// Preferências de volume/notificação (ver SettingsPanel.tsx) -- pedido
// do Douglas, 30/set (5): "Volume do espaco, deixe ele alterar mesmo
// fora de um [espaço], pra que quando entre ja esteja no volume
// certo" + "volume de chamadas" (separado -- ver comentário grande em
// ChatCallVideoTile/GameRoom.tsx: a chamada de voz/vídeo de uma
// conversa, tipo Discord, é um canal de áudio TOTALMENTE diferente do
// "Som do espaço", que só multiplica o áudio de proximidade de quem
// tá perto no mapa) + toggles de notificação (conversas privadas/de
// empresa/agenda).
//
// Mora num arquivo À PARTE (não duplicado dentro de GameRoom.tsx/
// Lobby.tsx, diferente do padrão de sempre desse app) porque as DUAS
// telas leem/escrevem a MESMA preferência -- precisa ser o MESMO
// código, não uma cópia que pode desalinhar (localStorage é o que já
// compartilha o valor entre telas do mesmo navegador; o código que
// lê/escreve ele também precisa ser um só).
export const SPACE_VOLUME_STORAGE_KEY = "xtower.settings.spaceVolume";
export const CALL_VOLUME_STORAGE_KEY = "xtower.settings.callVolume";
export const NOTIFICATION_PREFS_STORAGE_KEY = "xtower.settings.notifications";

export function getStoredVolume(key: string, fallback = 1): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  } catch {
    return fallback;
  }
}

export function setStoredVolume(key: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.max(0, Math.min(1, value))));
  } catch {
    // localStorage indisponível (modo privado, etc.) -- segue só em memória
  }
}

export type NotificationPrefs = {
  privateChats: boolean;
  companyChats: boolean;
  agenda: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  privateChats: true,
  companyChats: true,
  agenda: true,
};

export function getStoredNotificationPrefs(): NotificationPrefs {
  if (typeof window === "undefined") return DEFAULT_NOTIFICATION_PREFS;
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      privateChats: parsed.privateChats !== false,
      companyChats: parsed.companyChats !== false,
      agenda: parsed.agenda !== false,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

export function setStoredNotificationPrefs(prefs: NotificationPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // segue só em memória
  }
}

// dispara uma notificação de verdade do navegador (Notification API,
// funciona até com a aba em segundo plano) -- só chamada depois de
// conferir o toggle da categoria (ver call sites em GameRoom.tsx).
// Sem permissão concedida ainda, não faz nada (silencioso -- quem quer
// notificação primeiro autoriza em Configurações > Notificações).
export function fireNotification(title: string, body: string): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // navegador recusou por algum motivo -- sem tratamento especial
  }
}
