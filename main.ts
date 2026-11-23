// sokoban-solver-01-run-20261121 — a push-optimal Sokoban solver.
//
// Strategy: the generated levels are a hallway with 1-4 rooms off it (3-4 boxes
// per room), and no box can ever leave its room, so the level's push-optimum P*
// is the sum of the rooms' optima. Each room is solved independently with an A*
// over pushes (one push = one box moved one square), which is push-optimal, and
// the room solutions are joined by walking the player between doors.
//
// A* details (all deterministic, work-budgeted, never the wall clock):
//   - state: the boxes' squares (sorted) + the player's reachable region,
//     named by its lowest square (any square the player can reach is equivalent)
//   - heuristic: min-cost assignment of boxes to goals over per-goal BFS push
//     distances through live squares; admissible and consistent, so A* is optimal
//   - pruning: a box on a dead square (no pull path to any goal, ignoring other
//     boxes) can never be solved; a frozen 2x2 block of walls/boxes with a box
//     off its goal can never be unfrozen
//   - expansion cap per search (work, not time): the search gives up past it
//   - fallback: if a level is not a set of rooms, A* over the whole level
//
// Input:  /input/<id>/level.txt (XSB) — or MAKEFUN_INPUT_DIR
// Output: /output/<id>/solution.txt (LURD moves) — or MAKEFUN_OUTPUT_DIR
// License: MIT
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budget (states) for one room search; rooms are validated by the generator to solve far below this. */
const ROOM_MAX_STATES = 400_000;
/** Work budget for the whole-level fallback search. */
const WHOLE_MAX_STATES = 1_000_000;

/** The four directions: [dx, dy, step letter, push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can be pulled onto some goal (reverse reachability from the goals). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * For each goal, the push-distance from every square to that goal: BFS over live
 * squares (a box travels one square per push and only ever stands on live ones).
 * dist[g][cell] = fewest pushes for a lone box to reach goal g from cell.
 */
function goalDistances(level: Level, live: Uint8Array): Int32Array[] {
  const { w, wall, goals } = level;
  const size = wall.length;
  return goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const y = x + dy * w + dx;
        if (live[y] && dist[y] < 0) {
          dist[y] = dist[x]! + 1;
          queue.push(y);
        }
      }
    }
    return dist;
  });
}

/**
 * Min-cost assignment of boxes to goals (brute-force permutations; at most 4
 * boxes/goals per room). Admissible: one push moves one box one square, so the
 * true push count is at least the sum of the boxes' lone distances.
 */
function heuristic(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  // Cost matrix, Infinity when a box cannot reach a goal at all.
  const cost: number[][] = boxes.map((b) => dist.map((d) => (d[b]! < 0 ? Infinity : d[b]!)));
  // Quick prune: a box with no reachable goal kills the state.
  if (cost.some((row) => row.every((c) => c === Infinity))) return Infinity;
  let best = Infinity;
  const perm = dist.map((_, i) => i);
  const assign = (k: number, sum: number): void => {
    if (sum >= best) return;
    if (k === n) {
      best = sum;
      return;
    }
    for (let j = k; j < n; j++) {
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
      const c = cost[k]![perm[k]!]!;
      if (c !== Infinity) assign(k + 1, sum + c);
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
    }
  };
  assign(0, 0);
  return best;
}

/** A binary heap of [f, -g, seq, state] — smallest f first, deeper g first on ties, then oldest. */
class Heap {
  private a: [number, number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1]!, a[c]!)) c++;
        if (!less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

function less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
  return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
}

/** Flood-fill the player's reachable region from `from` with `occupied` in the way; returns its lowest square. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls/boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** A state's key: region low + sorted boxes (numeric while small, string for big levels). */
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length > 5) return `${low}|${boxes.join(',')}`;
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/**
 * Push-optimal solution of `level`: {pushes, moves} (moves in LURD, upper letter
 * = a push), or null when the search gives up or the level has no solution.
 * A* over pushes with the assignment heuristic; optimal when it finds one.
 */
function solvePushes(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level, live);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const statesLow: number[] = [];
  const parent: number[] = [-1];
  const movedFrom: number[] = [-1];
  const movedTo: number[] = [-1];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  statesLow.push(reach(level, occupied, level.player, seen, ++stamp, stack));
  best.set(keyOf(level.boxes, statesLow[0]!, size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  const heap = new Heap();
  const h0 = heuristic(level.boxes, dist);
  if (h0 === Infinity) return null;
  let seq = 0;
  heap.push([h0, 0, seq++, 0]);
  let found = solved(level.boxes) ? 0 : -1;

  while (heap.size > 0 && found < 0) {
    const [, negG, , s] = heap.pop();
    const g = -negG;
    const boxes = statesBoxes[s]!;
    if (best.get(keyOf(boxes, statesLow[s]!, size)) !== g) continue; // stale heap entry
    // Recompute the region stamp for push generation below.
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = heuristic(next, dist);
          if (h !== Infinity) {
            low = reach(level, occupied, b, mark, ++stamp, stack);
            key = keyOf(next, low, size);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g + 1) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const ns = statesBoxes.length;
        statesBoxes.push(next!);
        statesPlayer.push(b);
        statesLow.push(low);
        parent.push(s);
        movedFrom.push(b);
        movedTo.push(t);
        if (solved(next!)) {
          found = ns;
          break;
        }
        heap.push([g + 1 + h, -(g + 1), seq++, ns]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Reconstruct: walk the player to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = movedFrom[s]!;
    const to = movedTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor; each remaining part holding a box
 * is a room. Null when some part holds more/fewer boxes than goals, or a box
 * starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve room by room: each room's push-optimal solution in turn, the other
 * rooms' boxes standing as walls (on their goals once their room is done), the
 * player walking on from where the last room left it. A box never leaves its
 * room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushes(level, WHOLE_MAX_STATES);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_MAX_STATES);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Solve one level's text; '' when no solution was found (still a valid answer). */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    const r = solveByRooms(level);
    if (r === null) return '';
    return r.moves;
  } catch (e) {
    console.error(`solve failed: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
  const pushes = moves.split('').filter((c) => c >= 'A' && c <= 'Z').length;
  console.error(`${id}: ${moves.length} moves, ${pushes} pushes`);
}
