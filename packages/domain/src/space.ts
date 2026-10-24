/**
 * Canonical airport-space entities (ACI ACRIS concepts): terminals, concourses, zones, gates, checkpoints,
 * passenger queues and queue measurements. Coordinates are metres on the stylised floor plan.
 */
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type Rect = z.infer<typeof RectSchema>;

export const TerminalSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** What the terminal mainly handles; flights of either nature may still use it. */
  mainMarket: z.enum(['domestic', 'international', 'mixed']),
  outline: RectSchema,
});
export type Terminal = z.infer<typeof TerminalSchema>;

export const ConcourseSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string(),
  name: z.string(),
});
export type Concourse = z.infer<typeof ConcourseSchema>;

export const ZoneKindSchema = z.enum([
  'landside_hall',
  'security',
  'passport_control',
  'airside_plaza',
  'pier',
  'bus_lounge',
  'arrivals_hall',
]);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const ZoneSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string(),
  concourseId: z.string().nullable(),
  name: z.string(),
  kind: ZoneKindSchema,
  side: z.enum(['landside', 'airside']),
  area: RectSchema,
});
export type Zone = z.infer<typeof ZoneSchema>;

export const GateSchema = z.object({
  /** Terminal-qualified id, e.g. `T2-42`. */
  id: z.string().min(1),
  /** The code shown to passengers and used by the AODB, e.g. `42` or `BUS3`. */
  code: z.string().min(1),
  terminalId: z.string(),
  concourseId: z.string().nullable(),
  zoneId: z.string(),
  remote: z.boolean(),
  position: PointSchema,
});
export type Gate = z.infer<typeof GateSchema>;

export const CheckpointSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string(),
  zoneId: z.string(),
  name: z.string(),
  kind: z.enum(['security', 'passport_control']),
  lanes: z.number().int().positive(),
  position: PointSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const PassengerQueueSchema = z.object({
  id: z.string().min(1),
  checkpointId: z.string(),
  name: z.string(),
  queueType: z.enum(['standard', 'priority']),
});
export type PassengerQueue = z.infer<typeof PassengerQueueSchema>;

export const QueueMeasurementSchema = z.object({
  id: z.string().min(1),
  queueId: z.string(),
  checkpointId: z.string(),
  /** End of the measurement period. */
  measuredAt: instant,
  /** People in the queue. */
  occupancy: z.number().int().min(0),
  /** Average wait in seconds. */
  waitTimeSec: z.number().min(0),
  projectedWaitTimeSec: z.number().min(0),
  /** People processed per hour. */
  throughputPerHour: z.number().min(0),
});
export type QueueMeasurement = z.infer<typeof QueueMeasurementSchema>;

/** Straight-line distance between two plan points, in metres. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function rectCentre(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}
