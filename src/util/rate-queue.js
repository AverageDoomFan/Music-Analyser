// Serialises calls to a web service so that two calls never start closer than
// `intervalMs` apart (MusicBrainz: 1 request per second per client). Calls run
// one after the other in the order they were scheduled; a failing call does not
// block the ones behind it. `now` and `sleep` are injectable for tests.

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{intervalMs?:number, now?:() => number, sleep?:(ms:number) => Promise<void>}} [opts]
 * @returns {(fn: () => any) => Promise<any>} schedule(fn): resolves with fn's result
 */
export function createRateQueue({ intervalMs = 1000, now = Date.now, sleep = realSleep } = {}) {
  let last = -Infinity;
  let chain = Promise.resolve();
  const schedule = (fn) => {
    const run = chain.then(async () => {
      const wait = last + intervalMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
  /** Pushes the next start back (e.g. after a 503 "slow down"). */
  schedule.backoff = (ms) => { last = Math.max(last, now()) + ms; };
  return schedule;
}
