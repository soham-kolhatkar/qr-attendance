import { api, unwrap } from '../api/client';

/**
 * How far this computer's clock is behind the server's, in ms (server − local).
 * Uses the midpoint of the request round trip; the projector adds this to Date.now()
 * so its QR codes line up with what the server accepts even if the laptop clock is off.
 */
export async function measureClockOffset(): Promise<number> {
  const samples: { offset: number; rtt: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const { epochMs } = unwrap(await api.GET('/v1/time'));
    const t1 = Date.now();
    samples.push({ offset: epochMs - (t0 + t1) / 2, rtt: t1 - t0 });
  }
  // The fastest round trip gives the most trustworthy midpoint.
  samples.sort((a, b) => a.rtt - b.rtt);
  return samples[0]!.offset;
}
