import { useEffect, useState } from "react";

// Whole seconds since `active` last became true.
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    setSeconds(0);
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}
