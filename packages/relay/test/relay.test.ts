// The reference relay over real WebSockets: two bots find each other, play, and agree on a winner.
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Bot, BOT_SKILLS } from '@bug-pop/engine';
import { OnlineMatch, PROTOCOL_VERSION, parseServer, type ServerMsg } from '@bug-pop/protocol';
import { startRelay } from '../src/relay';

// The test plays far faster than real time, so the messages-per-second limit is lifted.
const wss = startRelay({ port: 0, maxPerSecond: 1e9 });
const url = () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
afterAll(() => new Promise<void>(r => wss.close(() => r())));

/** A client: say hello, then keep every message from the relay. */
async function client(level: number) {
  const ws = new WebSocket(url());
  const inbox: ServerMsg[] = [];
  const listeners: ((m: ServerMsg) => void)[] = [];
  ws.on('message', d => { const m = parseServer(d.toString()); if (m) { inbox.push(m); listeners.forEach(l => l(m)); } });
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, level, speed: 1 }));
  const next = (t: ServerMsg['t']) => new Promise<ServerMsg>(res => {
    const found = inbox.find(m => m.t === t);
    if (found) return res(found);
    listeners.push(m => { if (m.t === t) res(m); });
  });
  return { ws, inbox, next, listeners };
}

describe('reference relay', () => {
  it('pairs two players and passes their moves until both agree on the winner', async () => {
    const a = await client(2);
    expect((await a.next('wait')).t).toBe('wait');
    const b = await client(4);
    const sa = await a.next('start'), sb = await b.next('start');
    if (sa.t !== 'start' || sb.t !== 'start') throw new Error('no start');
    expect(sa.seed).toBe(sb.seed);
    expect([sa.seat, sb.seat]).toEqual([0, 1]);
    expect(sb.players[0].level).toBe(2);

    const ma = new OnlineMatch(sa, m => a.ws.send(JSON.stringify(m)));
    const mb = new OnlineMatch(sb, m => b.ws.send(JSON.stringify(m)));
    a.listeners.push(m => ma.receive(m));
    b.listeners.push(m => mb.receive(m));
    const bots = [new Bot(BOT_SKILLS.hard, 1), new Bot(BOT_SKILLS.hard, 2)];
    const ends = [a.next('end'), b.next('end')];
    // Play in bursts, letting the network catch up between them (faster than real time).
    for (let i = 0; i < 60 * 60 * 10 && !(ma.result && mb.result); i++) {
      ma.tick(bots[0]!.act(ma.me));
      mb.tick(bots[1]!.act(mb.me));
      if (i % 30 === 0) await new Promise(r => setTimeout(r, 1));
    }
    const [ea, eb] = await Promise.all(ends);
    expect(ea).toEqual(eb);
    expect(ea).toMatchObject({ t: 'end', why: 'result' });
    expect(ma.flagged ?? mb.flagged).toBeNull();
    a.ws.close(); b.ws.close();
  }, 30000);

  it('leaving a match gives the other player the win', async () => {
    const a = await client(1), b = await client(1);
    await a.next('start'); await b.next('start');
    const end = b.next('end');
    a.ws.close();
    expect(await end).toEqual({ t: 'end', why: 'left', winner: 1 });
    b.ws.close();
  });

  it('a flag ends the match with a notice for both', async () => {
    const a = await client(1), b = await client(1);
    await a.next('start'); await b.next('start');
    const ends = [a.next('end'), b.next('end')];
    a.ws.send(JSON.stringify({ t: 'flag', why: 'test' }));
    expect(await Promise.all(ends)).toEqual([{ t: 'end', why: 'flag', winner: null }, { t: 'end', why: 'flag', winner: null }]);
    a.ws.close(); b.ws.close();
  });
});
