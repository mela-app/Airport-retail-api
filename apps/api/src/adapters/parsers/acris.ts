/**
 * ACI ACRIS (FIWARE Smart Data Models, dataModel.ACRIS) NGSI-LD entities → canonical space entities.
 *
 * Accepts both NGSI-LD representations: normalized (`"Occupancy": {"type": "Property", "value": 58}`) and
 * keyValues (`"Occupancy": 58`). Entity ids follow `urn:ngsi-ld:<Type>:<airport>:<local id>`; the local id
 * becomes the canonical id.
 */
import { type QueueMeasurement, QueueMeasurementSchema } from '@arm/domain';

export class AcrisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcrisError';
  }
}

type Entity = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value of an NGSI-LD attribute, in either representation. */
export function attr(entity: Entity, name: string): unknown {
  if (!Object.hasOwn(entity, name)) return undefined;
  const raw: unknown = Reflect.get(entity, name);
  if (isRecord(raw) && (raw.type === 'Property' || raw.type === 'Relationship')) {
    return raw.type === 'Property' ? Reflect.get(raw, 'value') : Reflect.get(raw, 'object');
  }
  return raw;
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new AcrisError(`${what} must be a non-empty string`);
  return v;
};

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new AcrisError(`${what} must be a non-negative number`);
  return v;
};

/** `urn:ngsi-ld:QueueMeasurement:MQI:T2-SEC-CP-STD-202610161005` → `T2-SEC-CP-STD-202610161005`. */
export function localId(urn: string, type: string): string {
  const prefix = `urn:ngsi-ld:${type}:`;
  if (!urn.startsWith(prefix)) throw new AcrisError(`entity id ${urn} is not a ${type} URN`);
  const rest = urn.slice(prefix.length);
  const colon = rest.indexOf(':');
  return colon < 0 ? rest : rest.slice(colon + 1);
}

export function parseQueueMeasurement(input: unknown): QueueMeasurement {
  if (!isRecord(input)) throw new AcrisError('entity must be an object');
  if (input.type !== 'QueueMeasurement')
    throw new AcrisError(`expected QueueMeasurement, got ${String(input.type)}`);
  const queue = attr(input, 'PassengerQueue');
  const endTime = str(
    nested(attr(input, 'MeasurementTimePeriod'), 'EndTime'),
    'MeasurementTimePeriod.EndTime',
  );
  const ms = Date.parse(endTime);
  if (Number.isNaN(ms)) throw new AcrisError(`invalid MeasurementTimePeriod.EndTime ${endTime}`);
  const measurement = {
    id: localId(str(input.id, 'id'), 'QueueMeasurement'),
    queueId: str(nested(queue, 'Identifier'), 'PassengerQueue.Identifier'),
    checkpointId: str(
      nested(queue, 'CheckpointFacility', 'Identifier'),
      'PassengerQueue.CheckpointFacility.Identifier',
    ),
    measuredAt: `${new Date(ms).toISOString().slice(0, 19)}Z`,
    occupancy: Math.round(num(attr(input, 'Occupancy'), 'Occupancy')),
    waitTimeSec: num(attr(input, 'WaitTime'), 'WaitTime'),
    projectedWaitTimeSec: num(attr(input, 'ProjectedWaitTime') ?? 0, 'ProjectedWaitTime'),
    throughputPerHour: num(attr(input, 'Throughput') ?? 0, 'Throughput'),
  };
  const parsed = QueueMeasurementSchema.safeParse(measurement);
  if (!parsed.success)
    throw new AcrisError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

/** A static ACRIS entity reduced to what the platform reconciles against its master data. */
export interface AcrisFacility {
  type:
    'TerminalFacility' | 'ConcourseFacility' | 'ZoneAreaLocation' | 'CheckpointFacility' | 'PassengerQueue';
  id: string;
  name: string;
  /** Parent facility (terminal of a concourse or zone, checkpoint of a queue), when given. */
  parentId: string | null;
}

const FACILITY_TYPES = new Set([
  'TerminalFacility',
  'ConcourseFacility',
  'ZoneAreaLocation',
  'CheckpointFacility',
  'PassengerQueue',
]);

export function parseFacility(input: unknown): AcrisFacility {
  if (!isRecord(input)) throw new AcrisError('entity must be an object');
  const type = String(input.type);
  if (!FACILITY_TYPES.has(type)) throw new AcrisError(`unsupported ACRIS entity type ${type}`);
  const parent =
    nested(attr(input, 'TerminalFacility'), 'Identifier') ??
    nested(attr(input, 'TerminalAreaLocation'), 'Identifier') ??
    nested(attr(input, 'CheckpointFacility'), 'Identifier') ??
    nested(attr(input, 'ConcourseFacility'), 'TerminalFacility', 'Identifier') ??
    null;
  return {
    type: type as AcrisFacility['type'],
    id: localId(str(input.id, 'id'), type),
    name: str(attr(input, 'Name'), 'Name'),
    parentId: typeof parent === 'string' ? parent : null,
  };
}
