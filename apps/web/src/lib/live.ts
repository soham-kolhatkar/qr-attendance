import { useEffect, useRef, useState } from 'react';
import { authFetch } from '../api/client';
import type { LiveEvent, Session } from '../api/types';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

const RETRY_MS = 2000;

/**
 * Follows GET /v1/sessions/{id}/live. Calls `onSnapshot` on every (re)connect and
 * `onEvent` for each change. Reconnects automatically; the snapshot after a reconnect
 * repairs anything missed while offline. Uses fetch (not EventSource) so the access
 * token goes in a header, never in the URL.
 */
export function useLiveSession(
  sessionId: string | undefined,
  handlers: { onSnapshot(session: Session): void; onEvent(event: LiveEvent): void },
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let attempt = 0;

    const dispatch = (block: string) => {
      if (block.startsWith(':')) return; // keep-alive
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) return;
      const parsed = JSON.parse(data);
      if (event === 'snapshot') handlersRef.current.onSnapshot(parsed as Session);
      else handlersRef.current.onEvent(parsed as LiveEvent);
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await authFetch(`/v1/sessions/${sessionId}/live`, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`live stream failed (${res.status})`);
          setStatus('live');
          attempt = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              dispatch(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        setStatus('reconnecting');
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(RETRY_MS * attempt, 10_000)));
      }
    };
    void run();
    return () => controller.abort();
  }, [sessionId]);

  return status;
}
