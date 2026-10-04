import { useEffect, useState } from "react";

/**
 * The wall clock in unix seconds, ticking once a second while `active`.
 *
 * For anything that counts down against a deadline the engine set rather than
 * against an event it will send -- the wait for a new address simply lapses,
 * and nothing announces that. Idle when inactive, so a table of two thousand
 * rows does not run two thousand timers to show a label on one of them.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!active) return;
    setNow(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return active ? now : Math.floor(Date.now() / 1000);
}
