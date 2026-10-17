import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import { connectionConfig, type DbOrTx } from '../../db/client.js';

const CHANNEL = 'attendance_live';
const RECONNECT_MS = 1000;

export type SessionCounts = { present: number; absent: number; excused: number; total: number };

export type LiveEvent =
  | {
      type: 'marked';
      sessionId: string;
      student: { id: string; fullName: string; rollNo: string | null };
      status: 'present' | 'absent' | 'excused';
      method: 'qr' | 'manual';
      counts: SessionCounts;
    }
  | {
      type: 'session';
      sessionId: string;
      status: 'open' | 'closed' | 'cancelled';
      closesAt: string;
    };

/**
 * Fan-out of attendance events to live faculty screens. Events travel through Postgres
 * NOTIFY, so a scan handled by one API instance reaches screens connected to any other.
 * A NOTIFY sent inside a transaction is only delivered if the transaction commits.
 */
export class LiveHub {
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.emitter.setMaxListeners(0);
  }

  async publish(db: DbOrTx, event: LiveEvent): Promise<void> {
    await db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`);
  }

  /** Starts listening on first use; returns an unsubscribe function. */
  async subscribe(sessionId: string, listener: (event: LiveEvent) => void): Promise<() => void> {
    await this.ensureListening();
    this.emitter.on(sessionId, listener);
    return () => {
      this.emitter.off(sessionId, listener);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async ensureListening(): Promise<void> {
    if (this.client || this.stopped) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client(connectionConfig(this.databaseUrl));
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const event = JSON.parse(msg.payload) as LiveEvent;
        this.emitter.emit(event.sessionId, event);
      } catch (err) {
        this.log.warn({ err }, 'ignored malformed live event');
      }
    });
    client.on('error', (err) => {
      this.log.warn({ err }, 'live listener connection error');
      this.dropped(client);
    });
    client.on('end', () => this.dropped(client));
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    if (this.stopped) {
      await client.end();
      return;
    }
    this.client = client;
  }

  /** Reconnects while anyone is still watching; screens re-sync from the counts in the next event. */
  private dropped(client: pg.Client) {
    if (this.client !== client) return;
    this.client = null;
    if (this.stopped || this.emitter.eventNames().length === 0) return;
    setTimeout(() => {
      this.ensureListening().catch((err) => this.log.error({ err }, 'live listener reconnect failed'));
    }, RECONNECT_MS).unref();
  }
}
