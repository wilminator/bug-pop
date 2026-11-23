// One device in a room: the room as the server last described it, each game's settings card, and a
// TableMatch for every game this device plays in or watches. No network code: the caller sends
// what `send` gets and hands every server message to receive().

import type { GameEnd, GameLobby, GameRules, RoomClientMsg, RoomServerMsg, RoomState, TourRules } from './messages';
import { TableMatch } from './table';

export class RoomSession {
  state: RoomState | null = null;
  readonly lobbies = new Map<number, GameLobby>();
  readonly tables = new Map<number, TableMatch>();
  readonly ended = new Map<number, GameEnd>();
  error: string | null = null;
  /** Something changed (redraw the room screen). */
  onChange?: () => void;
  /** A game's table was made (to hook up sounds and drawing). */
  onTable?: (g: number, t: TableMatch) => void;

  constructor(private send: (m: RoomClientMsg) => void) {}

  /** The people this device brought. */
  get mine() { return this.state?.people.filter(p => p.mine) ?? []; }

  private table(g: number, t: TableMatch) {
    this.tables.set(g, t);
    this.ended.delete(g);
    this.onTable?.(g, t);
  }

  private makeTable(g: number, start: ConstructorParameters<typeof TableMatch>[0]) {
    return new TableMatch(start, out => this.send({ t: 'g', g, m: out }));
  }

  receive(m: RoomServerMsg | null) {
    if (!m) return;
    switch (m.t) {
      case 'rstate': this.state = m; break;
      case 'globby': this.lobbies.set(m.g, m); break;
      case 'tstart': this.lobbies.delete(m.table); this.table(m.table, this.makeTable(m.table, m)); break;
      case 'g': if (m.m.t !== 'tdone' && m.m.t !== 'flag') this.tables.get(m.g)?.receive(m.m); break;
      case 'gdrop': { const t = this.tables.get(m.g); if (m.you) t?.takeOver(m.s); else t?.away(m.s); break; }
      case 'gback': this.tables.get(m.g)?.handOver(m.s); break;
      case 'gcatch': {
        const t = this.makeTable(m.g, m.start);
        for (const st of m.steps) { if (st.t === 'drop') t.away(st.s); else t.receive(st); }
        for (const s of m.claim) t.rejoin(s);
        this.lobbies.delete(m.g);
        this.table(m.g, t);
        break;
      }
      case 'gend': this.ended.set(m.g, m); break;
      case 'error': this.error = m.why; break;
    }
    this.onChange?.();
  }

  /** One tick of every game this device plays: `actions` by game, then by seat. */
  tick(actions: ReadonlyMap<number, ReadonlyMap<number, readonly import('@bug-pop/engine').Action[]>> = new Map()) {
    for (const [g, t] of this.tables) if (!this.ended.has(g)) t.tick(actions.get(g));
  }

  // What people on this device can do (each is checked again by the server).
  addPerson(name: string) { this.send({ t: 'radd', name }); }
  dropPerson(pid: string) { this.send({ t: 'rdel', pid }); }
  newGame(by: string, size: number, rules: GameRules) { this.send({ t: 'rnew', by, size, rules }); }
  newTour(by: string, rules: TourRules) { this.send({ t: 'rtnew', by, rules }); }
  signUp(pid: string, on: boolean) { this.send({ t: 'rtjoin', pid, on }); }
  invite(from: string, to: string, g: number | null) { this.send({ t: 'rinvite', from, to, g }); }
  answer(pid: string, g: number | null, yes: boolean) { this.send({ t: 'ranswer', pid, g, yes }); }
  watchOnly(pid: string, watch: boolean) { this.send({ t: 'rwatch', pid, watch }); }
  giveUp(pid: string) { this.send({ t: 'rfree', pid }); }
  takeSeat(pid: string, g: number, s: number) { this.send({ t: 'rtake', pid, g, s }); }
  view(g: number | null) { this.send({ t: 'rview', g }); }
  startTour(by: string) { this.send({ t: 'rtour', by }); }
  set(g: number, pid: string, c: { level: number; speed: 0 | 1 | 2 | 3; power: boolean; ready: boolean }) { this.send({ t: 'gset', g, pid, ...c }); }
  quit() { this.send({ t: 'quit' }); }
}
