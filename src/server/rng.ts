// Every random draw in the game goes through `roll()`. In normal play that's
// Math.random. A test can queue fixed values through POST /api/test (see
// testHooks below), so damage, crits, drops and refines are reproducible.

let queue: number[] = [];
let forced: number | null = null;

export function roll(): number {
  if (queue.length) return queue.shift()!;
  if (forced !== null) return forced;
  return Math.random();
}

export function setRolls(values: number[], fixed: number | null): void {
  queue = values.filter((v) => Number.isFinite(v) && v >= 0 && v < 1);
  forced = fixed !== null && Number.isFinite(fixed) && fixed >= 0 && fixed < 1 ? fixed : null;
}

// On for local runs and CI's container, off on Fly. Fly sets FLY_APP_NAME on
// every machine and CI's `docker run` can't be given extra env without
// editing the course workflow, so its absence is the switch. TEST_HOOKS=0 or
// 1 overrides either way.
export const testHooks = (): boolean =>
  process.env.TEST_HOOKS ? process.env.TEST_HOOKS === "1" : !process.env.FLY_APP_NAME;
