// The reference relay: the smallest server that lets two people play Bug Pop online.
//
// Quick match only, 1 against 1, no accounts, no rooms, no friends (those live in the hosted
// server). It pairs the first two players who say hello, gives them a shared random seed, and
// passes each one's moves to the other. It never runs a game itself: each device plays its own
// board and rebuilds the opponent's from their moves (see packages/protocol).
//
// If a device flags the other (its copy of the game broke a rule), this relay just ends the match
// with a notice. Checking who was right, strikes and bans are the hosted server's job.

import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, parseClient, type End, type Hello, type ServerMsg, type Start } from '@bug-pop/protocol';

/** Each player's colors are the same in a quick match: the everyday 3. */
const COLORS = 3;
/** More messages than this in a second is not a game client (moves go out 20 times a second). */
const MAX_PER_SECOND = 60;

type Player = { ws: WebSocket; hello: Hello; match: Match | null; seat: 0 | 1; done: (0 | 1 | null) | undefined };
type Match = { players: [Player, Player]; over: boolean };

export type RelayOptions = { port?: number; server?: import('node:http').Server; path?: string; log?: (line: string) => void; maxPerSecond?: number };

export function startRelay(opts: RelayOptions = {}) {
  const log = opts.log ?? (() => undefined);
  const limit = opts.maxPerSecond ?? MAX_PER_SECOND;
  const wss = new WebSocketServer({ port: opts.server ? undefined : opts.port ?? 8080, server: opts.server, path: opts.path, maxPayload: MAX_MESSAGE_BYTES });
  let waiting: Player | null = null;
  const send = (ws: WebSocket, m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };

  const end = (match: Match, why: End['why'], winner: 0 | 1 | null) => {
    if (match.over) return;
    match.over = true;
    for (const p of match.players) { send(p.ws, { t: 'end', why, winner }); p.match = null; }
    log(`match ended: ${why}, winner ${winner}`);
  };

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let me: Player | null = null;
    let second = 0, count = 0;
    ws.on('message', (data, isBinary) => {
      // A few cheap limits: text only, not too big, not too often.
      const now = Math.floor(Date.now() / 1000);
      if (now !== second) { second = now; count = 0; }
      if (isBinary || ++count > limit) { ws.close(1008, 'too much'); return; }
      const msg = parseClient(data.toString());
      if (!msg) { send(ws, { t: 'error', why: 'bad message' }); return; }
      if (msg.t === 'hello') {
        if (me) return;
        if (msg.v !== PROTOCOL_VERSION) { send(ws, { t: 'error', why: 'update the game to play online' }); ws.close(); return; }
        if (msg.room !== undefined) { send(ws, { t: 'error', why: 'this server has quick match only' }); ws.close(); return; }
        me = { ws, hello: msg, match: null, seat: 0, done: undefined };
        if (!waiting || waiting.ws.readyState !== waiting.ws.OPEN) { waiting = me; send(ws, { t: 'wait' }); return; }
        const other: Player = waiting;
        waiting = null;
        const match: Match = { players: [other, me], over: false };
        other.match = me.match = match;
        other.seat = 0; me.seat = 1;
        const seed = randomInt(0, 0x7fffffff);
        const players: Start['players'] = [
          { level: other.hello.level, speed: other.hello.speed, name: 'Player 1' },
          { level: me.hello.level, speed: me.hello.speed, name: 'Player 2' },
        ];
        for (const p of match.players) send(p.ws, { t: 'start', seat: p.seat, seed, colors: COLORS, rule: 'race', players, round: 1, wins: [0, 0] });
        log('match started');
        return;
      }
      const match = me?.match;
      if (!me || !match || match.over) return;
      const other = match.players[1 - me.seat]!;
      switch (msg.t) {
        case 'in': case 'took': send(other.ws, msg); break; // passed on as checked, nothing added
        case 'flag': end(match, 'flag', null); break;
        case 'quit': end(match, 'left', (1 - me.seat) as 0 | 1); break;
        case 'done': {
          me.done = msg.winner;
          if (other.done === undefined) break;
          if (other.done === me.done) end(match, 'result', me.done);
          else end(match, 'disagree', null);
          break;
        }
      }
    });
    ws.on('close', () => {
      if (!me) return;
      if (waiting === me) waiting = null;
      const match = me.match;
      // Leaving a match hands the win to the other player.
      if (match && !match.over) end(match, 'left', (1 - me.seat) as 0 | 1);
    });
  });
  return wss;
}
