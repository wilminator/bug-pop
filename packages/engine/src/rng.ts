// Seeded random numbers (mulberry32).
//
// The whole generator state is one 32-bit integer, so it fits in a save file
// and two machines that start from the same seed produce the same sequence.
// That property is what makes replays and online lockstep possible.

/** Advance the generator stored in `holder.rng` and return a uint32. */
export function nextU32(holder: { rng: number }): number {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** A random integer in [0, n). */
export function randInt(holder: { rng: number }, n: number): number {
  return nextU32(holder) % n;
}
