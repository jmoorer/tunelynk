export type LimiterOptions = {
  rps: number;
  burst: number;
  concurrency: number;
  now?: () => number;
};

export type Limiter = {
  schedule<T>(task: () => Promise<T>): Promise<T>;
  // Empty the bucket so every caller backs off together (used after a 429).
  drain(): void;
};

// Token bucket plus a concurrency cap. One instance per process: Apple's budget
// belongs to the developer token, not to a run.
export function createLimiter({
  rps,
  burst,
  concurrency,
  now = Date.now,
}: LimiterOptions): Limiter {
  let tokens = burst;
  let lastRefill = now();
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<() => void> = [];

  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - lastRefill) / 1000) * rps);
    lastRefill = t;
  };

  const pump = () => {
    refill();
    while (queue.length > 0 && inFlight < concurrency && tokens >= 1) {
      tokens -= 1;
      inFlight += 1;
      queue.shift()?.();
    }
    if (queue.length > 0 && inFlight < concurrency && !timer) {
      const waitMs = Math.ceil(((1 - tokens) / rps) * 1000);
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, waitMs);
    }
  };

  return {
    schedule(task) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              inFlight -= 1;
              pump();
            });
        });
        pump();
      });
    },
    drain() {
      refill();
      tokens = 0;
    },
  };
}
