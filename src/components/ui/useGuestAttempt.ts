import { useEffect, useRef, useState } from 'react';

/** One explicit user action permits one automatic CAPTCHA submission. */
export function useGuestAttempt() {
  const generation = useRef(0);
  const armed = useRef(false);
  const deadline = useRef(0);
  const [id, setId] = useState(0);
  const [failed, setFailed] = useState(false);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!remaining) return;
    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [remaining > 0]);
  useEffect(() => () => { armed.current = false; generation.current += 1; }, []);
  return {
    id, failed, remaining,
    open() {
      if (deadline.current > Date.now()) return false;
      armed.current = true;
      setId(++generation.current); setFailed(false);
      return true;
    },
    close() { armed.current = false; generation.current += 1; },
    take(attempt: number) {
      if (!armed.current || attempt !== generation.current || deadline.current > Date.now()) return false;
      armed.current = false;
      return true;
    },
    fail(response?: Response) {
      armed.current = false; setFailed(true);
      if (response?.status === 429) {
        const value = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(value) && value > 0 ? Math.min(86400, Math.ceil(value)) : 60;
        deadline.current = Date.now() + seconds * 1000;
        setRemaining(seconds);
      }
    },
  };
}
