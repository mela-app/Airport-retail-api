/**
 * IATA AIDX `IATA_AIDX_FlightLegNotifRQ` → canonical `FlightEvent`.
 *
 * The flight is identified from LegIdentifier (airline, flight number, departure/arrival airport) and the
 * scheduled time (OperationTime TimeType="SCT"). Changes are read from PublicStatus, AirportResources,
 * OperationTime, Delay and CabinClass. The event type is inferred from what the message reports, in this
 * order: cancelled, gate change (AirportResources Usage="Planned"), on-block, landed, airborne, off-block,
 * gate closed, boarding, delay, estimate.
 *
 * Element names follow the challenge's illustrative sample; validate against the official AIDX XSD before
 * connecting to a production feed.
 */
import {
  type FlightChanges,
  type FlightEvent,
  FlightEventSchema,
  type FlightEventType,
  type FlightStatus,
  flightId,
} from '@arm/domain';

import { type XmlElement, child, childText, childrenNamed, parseXml } from './xml.js';

export const AIDX_NAMESPACE = 'http://www.iata.org/IATA/2007/00';

const PUBLIC_STATUS: ReadonlyMap<string, FlightStatus> = new Map([
  ['SCH', 'scheduled'],
  ['DEL', 'delayed'],
  ['BRD', 'boarding'],
  ['GCL', 'gate_closed'],
  ['DEP', 'departed'],
  ['EXP', 'approaching'],
  ['LND', 'landed'],
  ['ARR', 'arrived'],
  ['CNL', 'cancelled'],
]);

export interface AidxLeg {
  airlineIata: string;
  flightNumber: string;
  origin: string;
  destination: string;
  originDate: string | null;
  direction: 'A' | 'D';
}

export interface AidxParseOptions {
  /** IATA code of the home airport, to tell departures from arrivals. */
  homeAirport: string;
  /** When the platform received the message (simulation time). */
  receivedAt: string;
  /** Finds the canonical flight id when the message carries no scheduled time. */
  resolveFlightId?: (leg: AidxLeg) => string | undefined;
}

export class AidxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AidxError';
  }
}

const iso = (value: string, what: string): string => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new AidxError(`${what} is not a valid time: ${value}`);
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
};

/** OperationTime values keyed by `<qualifier>:<type>`, e.g. `OFB:EST`. */
function operationTimes(legData: XmlElement | undefined): Map<string, string> {
  const times = new Map<string, string>();
  for (const ot of childrenNamed(legData, 'OperationTime')) {
    const qualifier = ot.attributes.get('OperationQualifier');
    const type = ot.attributes.get('TimeType');
    if (qualifier && type && ot.text)
      times.set(`${qualifier}:${type}`, iso(ot.text, `OperationTime ${qualifier}/${type}`));
  }
  return times;
}

function inferType(
  status: FlightStatus | undefined,
  planned: boolean,
  times: ReadonlyMap<string, string>,
  direction: 'A' | 'D',
): FlightEventType {
  if (status === 'cancelled') return 'cancelled';
  if (planned) return 'gate_change';
  if (direction === 'A') {
    if (times.has('ONB:ACT')) return 'on_block';
    if (times.has('TDN:ACT')) return 'landed';
  } else {
    if (times.has('TKO:ACT')) return 'airborne';
    if (times.has('OFB:ACT')) return 'off_block';
  }
  if (status === 'gate_closed') return 'gate_closed';
  if (status === 'boarding') return 'boarding';
  if (status === 'delayed') return 'delay';
  if (status === 'approaching') return 'estimate';
  return [...times.keys()].some((k) => k.endsWith(':EST')) ? 'estimate' : 'schedule';
}

/** Parse one AIDX message. Throws `AidxError` / `XmlError` when the message is malformed. */
export function parseAidxMessage(xml: string, opts: AidxParseOptions): FlightEvent {
  const root = parseXml(xml);
  if (root.name !== 'IATA_AIDX_FlightLegNotifRQ') throw new AidxError(`unexpected root element ${root.name}`);
  const ns = root.attributes.get('xmlns');
  if (ns !== undefined && ns !== AIDX_NAMESPACE) throw new AidxError(`unexpected namespace ${ns}`);

  const leg = child(root, 'FlightLeg');
  const ident = child(leg, 'LegIdentifier');
  const legData = child(leg, 'LegData');
  const airline = childText(ident, 'Airline');
  const number = childText(ident, 'FlightNumber');
  const origin = childText(ident, 'DepartureAirport');
  const destination = childText(ident, 'ArrivalAirport');
  if (!airline || !number || !origin || !destination || !legData)
    throw new AidxError('incomplete LegIdentifier or missing LegData');
  const direction = origin === opts.homeAirport ? 'D' : destination === opts.homeAirport ? 'A' : null;
  if (!direction) throw new AidxError(`flight ${airline}${number} does not serve ${opts.homeAirport}`);

  const times = operationTimes(legData);
  const scheduled = times.get(direction === 'D' ? 'OFB:SCT' : 'ONB:SCT');
  const legInfo: AidxLeg = {
    airlineIata: airline,
    flightNumber: number,
    origin,
    destination,
    originDate: childText(ident, 'OriginDate'),
    direction,
  };
  const id = scheduled ? flightId(airline, number, direction, scheduled) : opts.resolveFlightId?.(legInfo);
  if (!id)
    throw new AidxError(
      `cannot identify flight ${airline}${number}: no scheduled time and no matching flight`,
    );

  const statusCode = childText(legData, 'PublicStatus');
  const status = statusCode ? PUBLIC_STATUS.get(statusCode) : undefined;
  if (statusCode && !status) throw new AidxError(`unknown PublicStatus ${statusCode}`);
  const resources = child(legData, 'AirportResources');
  const resource = child(resources, 'Resource');
  const planned = resources?.attributes.get('Usage') === 'Planned';

  const changes: FlightChanges = {};
  if (status) changes.status = status;
  const gate = childText(resource, 'Gate');
  const stand = childText(resource, 'AircraftParkingPosition');
  const belt = childText(resource, 'BaggageClaimUnit');
  if (gate) changes.gate = gate;
  if (stand) changes.stand = stand;
  if (belt) changes.baggageBelt = belt;
  const pick = (key: string): string | undefined => times.get(key);
  const set = (
    field: 'estimatedTime' | 'estimatedRunwayTime' | 'actualRunwayTime' | 'actualBlockTime' | 'tobt',
    value: string | undefined,
  ) => {
    if (value) Object.assign(changes, { [field]: value });
  };
  if (direction === 'D') {
    set('estimatedTime', pick('OFB:EST'));
    set('tobt', pick('OFB:TAR'));
    set('estimatedRunwayTime', pick('TKO:EST'));
    set('actualBlockTime', pick('OFB:ACT'));
    set('actualRunwayTime', pick('TKO:ACT'));
  } else {
    set('estimatedTime', pick('ONB:EST'));
    set('estimatedRunwayTime', pick('TDN:EST'));
    set('actualRunwayTime', pick('TDN:ACT'));
    set('actualBlockTime', pick('ONB:ACT'));
  }
  const delayCodes = childrenNamed(legData, 'Delay')
    .map((d) => d.attributes.get('DelayCode'))
    .filter((c): c is string => Boolean(c));
  if (delayCodes.length > 0) changes.delayCodes = delayCodes;
  const paxCounts = childrenNamed(legData, 'CabinClass').map((c) => childText(c, 'PaxCount'));
  if (paxCounts.length > 0 && paxCounts.every((p) => p !== null && /^\d+$/.test(p))) {
    changes.pax = paxCounts.reduce((sum, p) => sum + Number(p), 0);
  }

  const sequenceAttr = root.attributes.get('SequenceNmbr');
  const sequence = sequenceAttr && /^\d+$/.test(sequenceAttr) ? Number(sequenceAttr) : null;
  const timestamp = root.attributes.get('TimeStamp');
  const event = {
    id: root.attributes.get('TransactionIdentifier') ?? `aidx-${id}-${sequence ?? opts.receivedAt}`,
    flightId: id,
    type: inferType(status, planned && gate !== null, times, direction),
    occurredAt: timestamp ? iso(timestamp, 'TimeStamp') : opts.receivedAt,
    changes,
    sequence,
    source: {
      source: 'aidx' as const,
      ref: root.attributes.get('TransactionIdentifier') ?? id,
      receivedAt: opts.receivedAt,
    },
  };
  const parsed = FlightEventSchema.safeParse(event);
  if (!parsed.success)
    throw new AidxError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}
