import type * as Party from "partykit/server";

/**
 * Servidor multiplayer (roda no PartyKit / Cloudflare).
 *
 * Responsabilidades:
 *  - Guardar a posição de cada jogador conectado nesta sala.
 *  - Avisar todo mundo quando alguém entra, se move ou sai.
 *  - Servir de "correio" (relay) para a sinalização WebRTC entre pares
 *    (o vídeo/áudio em si NÃO passa por aqui — só o handshake inicial).
 */

type PlayerState = {
  id: string;
  x: number;
  y: number;
  name: string;
  color: string;
};

const COLORS = [
  "#ff5c7a",
  "#5c9bff",
  "#5cffb0",
  "#ffd75c",
  "#c45cff",
  "#5cf0ff",
  "#ff9a5c",
];

export default class GameServer implements Party.Server {
  players = new Map<string, PlayerState>();

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const player: PlayerState = {
      id: conn.id,
      x: 360 + Math.floor(Math.random() * 5) * 20,
      y: 480 + Math.floor(Math.random() * 3) * 20,
      name: `Visitante-${conn.id.slice(0, 4)}`,
      color,
    };
    this.players.set(conn.id, player);

    conn.send(
      JSON.stringify({
        type: "init",
        selfId: conn.id,
        players: Array.from(this.players.values()),
      })
    );

    this.room.broadcast(JSON.stringify({ type: "join", player }), [conn.id]);
  }

  onMessage(message: string, sender: Party.Connection) {
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    switch (data?.type) {
      case "move": {
        const p = this.players.get(sender.id);
        if (!p) return;
        p.x = data.x;
        p.y = data.y;
        this.room.broadcast(
          JSON.stringify({ type: "move", id: sender.id, x: p.x, y: p.y }),
          [sender.id]
        );
        break;
      }

      case "signal": {
        // repassa a mensagem de sinalização WebRTC só para o destinatário
        const target = this.room.getConnection(data.to);
        if (target) {
          target.send(
            JSON.stringify({ type: "signal", from: sender.id, data: data.data })
          );
        }
        break;
      }

      case "chat": {
        const text = String(data.text ?? "").slice(0, 300);
        if (!text.trim()) return;
        this.room.broadcast(
          JSON.stringify({ type: "chat", id: sender.id, text })
        );
        break;
      }
    }
  }

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: "leave", id: conn.id }));
  }

  onError(conn: Party.Connection, error: Error) {
    console.error("Erro de conexão", conn.id, error);
  }
}
