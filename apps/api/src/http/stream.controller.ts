/**
 * Live updates over Server-Sent Events: `GET /api/stream?topics=clock,flight,…`.
 *
 * Each bus message becomes an SSE event named after its topic, with the bus sequence number as the event id.
 * A new client first receives the current clock. A comment line every 15 s keeps proxies from closing idle
 * connections. Without `topics`, all topics are sent.
 */
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { BUS } from '../core/tokens.js';
import type { BusMessage, EventBus, Topic } from '../sim/event-bus.js';

const TOPICS: ReadonlySet<string> = new Set<Topic>([
  'clock',
  'flight',
  'flights_reloaded',
  'queue',
  'screen',
  'incident',
  'feeds',
  'sim',
  'decisions',
  'delivery',
  'presence',
  'model',
  'catalog',
  'claims',
]);
const HEARTBEAT_MS = 15_000;

/** One SSE frame. Topic names come from the fixed list above; data is JSON (no raw newlines). */
export function sseFrame(message: BusMessage): string {
  return [
    'id: ',
    String(message.seq),
    '\nevent: ',
    message.topic,
    '\ndata: ',
    JSON.stringify({ ...message.payload, _publishedAt: message.publishedAt }),
    '\n\n',
  ].join('');
}

@ApiTags('Live updates')
@Controller('api')
export class StreamController {
  constructor(@Inject(BUS) private readonly bus: EventBus) {}

  @ApiOperation({ summary: 'Server-Sent Events stream of live updates (filter with `topics`)' })
  @ApiQuery({
    name: 'topics',
    required: false,
    description: 'Comma-separated topics (default: all)',
    schema: { type: 'string' },
  })
  @Get('stream')
  stream(@Res() res: Response, @Query('topics') topics?: string): void {
    const wanted = new Set(
      (topics ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => TOPICS.has(s)),
    );
    const accepts = (topic: Topic) => wanted.size === 0 || wanted.has(topic);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    const clock = this.bus.last('clock');
    if (clock && accepts('clock')) res.write(sseFrame(clock));

    const unsubscribe = this.bus.subscribe((message) => {
      if (accepts(message.topic)) res.write(sseFrame(message));
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
