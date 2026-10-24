/**
 * End-to-end: the real Nest application on an in-memory PostgreSQL (PGlite), over HTTP.
 * Covers the simulation controls, live updates over SSE (≤ 2 s from an injected feed event), rewinding on a
 * backward jump, incidents, and input validation.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-e2e-')),
    SIM_DATE: '2026-10-16',
    SIM_SEED: 'mqi',
    SIM_AUTOPLAY: 'false',
  });
  app = await createApp(config, false);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> & Record<number, unknown> };
};
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
  receivedAt: number;
}

/** Open an SSE connection and collect events until `close()`. */
function openStream(topics: string) {
  const events: SseEvent[] = [];
  const ctl = new AbortController();
  const ready = (async () => {
    const res = await fetch(`${base}/api/stream?topics=${topics}`, { signal: ctl.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    return reader;
  })();
  const done = (async () => {
    const reader = await ready;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) return;
        buffer += decoder.decode(value, { stream: true });
        for (let idx = buffer.indexOf('\n\n'); idx >= 0; idx = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data)
            events.push({ event, data: JSON.parse(data) as Record<string, unknown>, receivedAt: Date.now() });
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    ready,
    close: async () => {
      ctl.abort();
      await done;
    },
  };
}

const waitFor = async <T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('simulation API', () => {
  it('reports health and the simulation state, starting at the configured local time', async () => {
    const health = await get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const sim = await get('/api/sim');
    expect(sim.body).toMatchObject({
      clock: { playing: false, speed: 1 },
      airport: { code: 'MQI', utcOffsetMinutes: 240 },
      adapters: { flights: 'mock-aidx', space: 'mock-acris', audience: 'mock-rules' },
    });
    // 13:50 local = 09:50 UTC
    expect((sim.body.clock as { now: string }).now.startsWith('2026-10-16T09:50')).toBe(true);
  });

  it('play, pause and speed change the clock; invalid input is rejected', async () => {
    expect((await post('/api/sim/speed', { speed: 60 })).status).toBe(200);
    expect((await post('/api/sim/play')).body).toMatchObject({ playing: true, speed: 60 });
    const paused = await post('/api/sim/pause');
    expect(paused.body).toMatchObject({ playing: false });
    expect((await post('/api/sim/speed', { speed: 'fast' })).status).toBe(400);
    expect((await post('/api/sim/speed', { speed: 1000 })).status).toBe(400);
    expect((await post('/api/sim/jump', { localTime: '25:99' })).status).toBe(400);
    expect((await post('/api/sim/speed', { speed: 1 })).status).toBe(200);
  });

  it('an injected AIDX delay reaches SSE clients in under 2 seconds and is persisted', async () => {
    const stream = openStream('flight,sim');
    await stream.ready;
    const flights = (await get('/api/flights?direction=D&q=XU88')).body as unknown as {
      id: string;
      status: string;
    }[];
    const xu88 = flights.at(0);
    expect(xu88?.id).toBe('XU88-D-20261016');

    const t0 = Date.now();
    const injected = await post('/api/sim/inject/delay', {
      flightId: 'XU88-D-20261016',
      minutes: 40,
      delayCode: '41',
    });
    expect(injected.status).toBe(200);
    expect(injected.body.aidxMessage).toContain('<IATA_AIDX_FlightLegNotifRQ');
    const received = await waitFor(
      () =>
        stream.events.find(
          (e) => e.event === 'flight' && (e.data.flight as { id: string }).id === 'XU88-D-20261016',
        ),
      2000,
    );
    await stream.close();
    expect(received, 'flight event over SSE').toBeDefined();
    expect((received?.receivedAt ?? Infinity) - t0).toBeLessThan(2000);
    expect(received?.data.flight).toMatchObject({ status: 'delayed', estimatedTime: '2026-10-16T11:50:00Z' });

    const stored = await get('/api/flights/XU88-D-20261016');
    expect(stored.body).toMatchObject({ flight: { status: 'delayed', delayMinutes: 40 } });
    expect((stored.body.events as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('rejects injections for unknown flights and gates', async () => {
    expect((await post('/api/sim/inject/delay', { flightId: 'ZZ1-D-20261016', minutes: 10 })).status).toBe(
      404,
    );
    expect(
      (await post('/api/sim/inject/gate-change', { flightId: 'XU88-D-20261016', gate: 'ZZ9' })).status,
    ).toBe(400);
    expect((await post('/api/sim/inject/screen-offline', { screenId: 'SCR-NOPE' })).status).toBe(404);
  });

  it('a screen offline for more than 5 simulated minutes raises an incident', async () => {
    expect((await post('/api/sim/inject/screen-offline', { screenId: 'SCR-T2-D-01' })).body).toMatchObject({
      status: 'offline',
    });
    await post('/api/sim/jump', { localTime: '13:57' });
    type Incident = { kind: string; subject: string; severity: string };
    let incident: Incident | undefined;
    for (let attempt = 0; attempt < 50 && !incident; attempt += 1) {
      const list = (await get('/api/incidents?status=active')).body as unknown as Incident[];
      incident = list.find((i) => i.kind === 'screen_offline' && i.subject === 'SCR-T2-D-01');
      if (!incident) await new Promise((r) => setTimeout(r, 50));
    }
    expect(incident).toMatchObject({ kind: 'screen_offline', severity: 'high' });
    expect((await post('/api/sim/inject/screen-online', { screenId: 'SCR-T2-D-01' })).body).toMatchObject({
      status: 'online',
    });
  });

  it('jumping back rewinds feed data recorded after the target time', async () => {
    await post('/api/sim/jump', { localTime: '15:00' });
    const flights = (await get('/api/flights?direction=D')).body as unknown as {
      id: string;
      status: string;
      scheduledTime: string;
    }[];
    const target = flights.find((f) => f.status === 'scheduled' && f.scheduledTime > '2026-10-16T12:00:00Z');
    expect(target).toBeDefined();
    expect((await post('/api/sim/inject/delay', { flightId: target?.id, minutes: 15 })).status).toBe(200);
    // The event is pushed live first and persisted right after; wait for the write.
    let logged = false;
    for (let attempt = 0; attempt < 50 && !logged; attempt += 1) {
      const recent = (await get('/api/flight-events/recent?limit=500')).body as unknown as {
        flightId: string;
        occurredAt: string;
      }[];
      logged = recent.some(
        (e) => e.flightId === target?.id && Date.parse(e.occurredAt) >= Date.parse('2026-10-16T11:00:00Z'),
      );
      if (!logged) await new Promise((r) => setTimeout(r, 50));
    }
    expect(logged).toBe(true);

    const back = await post('/api/sim/jump', { localTime: '13:55' });
    expect(String(back.body.now).startsWith('2026-10-16T09:55')).toBe(true);
    const after = (await get('/api/flight-events/recent?limit=500')).body as unknown as {
      occurredAt: string;
    }[];
    expect(after.every((e) => Date.parse(e.occurredAt) <= Date.parse('2026-10-16T09:56:00Z'))).toBe(true);
    const restored = (await get(`/api/flights/${target?.id ?? ''}`)).body as { flight: { status: string } };
    expect(restored.flight.status).toBe('scheduled');
  });

  it('reset returns to the configured start time', async () => {
    const reset = await post('/api/sim/reset');
    expect(reset.status).toBe(200);
    expect(String(reset.body.now).startsWith('2026-10-16T09:50')).toBe(true);
  });
});
