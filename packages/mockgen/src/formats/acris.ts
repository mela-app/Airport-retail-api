/**
 * ACI ACRIS entities in NGSI-LD normalized form (FIWARE Smart Data Models, dataModel.ACRIS; schemas in
 * samples/acris-smart-data-models/). Static entities describe the airport; QueueMeasurement entities form a
 * time series a sensor feed would publish every 5 minutes.
 */
import {
  CHECKPOINTS,
  CONCOURSES,
  HOME_AIRPORT,
  PASSENGER_QUEUES,
  type QueueMeasurement,
  TERMINALS,
  ZONES,
} from '@arm/domain';

export const NGSI_LD_CONTEXT = [
  'https://raw.githubusercontent.com/smart-data-models/dataModel.ACRIS/master/context.jsonld',
] as const;

export interface NgsiProperty<T> {
  type: 'Property';
  value: T;
}

export interface NgsiEntity {
  id: string;
  type: string;
  '@context': readonly string[];
  [attribute: string]: unknown;
}

const prop = <T>(value: T): NgsiProperty<T> => ({ type: 'Property', value });

export const acrisId = (type: string, local: string): string =>
  `urn:ngsi-ld:${type}:${HOME_AIRPORT.iata}:${local}`;

const airportFacility = { IataCode: HOME_AIRPORT.iata, IcaoCode: HOME_AIRPORT.icao, Name: HOME_AIRPORT.name };

function terminalFacility(terminalId: string) {
  const t = TERMINALS.find((x) => x.id === terminalId);
  return { Identifier: terminalId, Name: t?.name ?? terminalId, AirportFacility: airportFacility };
}

/** The static ACRIS entities: terminals, concourses, zones, checkpoints and passenger queues. */
export function acrisStaticEntities(): NgsiEntity[] {
  const entities: NgsiEntity[] = [];
  for (const t of TERMINALS) {
    entities.push({
      id: acrisId('TerminalFacility', t.id),
      type: 'TerminalFacility',
      Identifier: prop(t.id),
      Name: prop(t.name),
      AirportFacility: prop(airportFacility),
      '@context': NGSI_LD_CONTEXT,
    });
  }
  for (const c of CONCOURSES) {
    entities.push({
      id: acrisId('ConcourseFacility', c.id),
      type: 'ConcourseFacility',
      Identifier: prop(c.id),
      Name: prop(c.name),
      TerminalFacility: prop(terminalFacility(c.terminalId)),
      '@context': NGSI_LD_CONTEXT,
    });
  }
  for (const z of ZONES) {
    entities.push({
      id: acrisId('ZoneAreaLocation', z.id),
      type: 'ZoneAreaLocation',
      Name: prop(z.name),
      TerminalAreaLocation: prop({ Name: z.terminalId, Identifier: z.terminalId }),
      // Platform extensions (prefixed so they are recognisable as non-ACRIS attributes).
      'x-zoneKind': prop(z.kind),
      'x-side': prop(z.side),
      'x-planArea': prop(z.area),
      '@context': NGSI_LD_CONTEXT,
    });
  }
  for (const cp of CHECKPOINTS) {
    entities.push({
      id: acrisId('CheckpointFacility', cp.id),
      type: 'CheckpointFacility',
      Identifier: prop(cp.id),
      Name: prop(cp.name),
      Description: prop(
        `${cp.kind === 'security' ? 'Security screening' : 'Departures passport control'}, ${cp.lanes} lanes`,
      ),
      CheckpointFacilityType: prop(cp.kind === 'security' ? 'Security' : 'Border'),
      CheckpointAreaLocation: prop(cp.zoneId),
      ConcourseFacility: prop({
        Identifier: cp.zoneId,
        Name: cp.name,
        TerminalFacility: terminalFacility(cp.terminalId),
      }),
      'x-lanes': prop(cp.lanes),
      '@context': NGSI_LD_CONTEXT,
    });
  }
  for (const q of PASSENGER_QUEUES) {
    const cp = CHECKPOINTS.find((c) => c.id === q.checkpointId);
    entities.push({
      id: acrisId('PassengerQueue', q.id),
      type: 'PassengerQueue',
      Identifier: prop(q.id),
      Name: prop(q.name),
      QueueType: prop(q.queueType === 'priority' ? 'Priority' : 'Standard'),
      CheckpointFacility: prop({ Identifier: q.checkpointId, Name: cp?.name ?? q.checkpointId }),
      '@context': NGSI_LD_CONTEXT,
    });
  }
  return entities;
}

/** One QueueMeasurement as an NGSI-LD entity (same attribute names as the ACRIS schema). */
export function acrisQueueMeasurement(m: QueueMeasurement): NgsiEntity {
  const queue = PASSENGER_QUEUES.find((q) => q.id === m.queueId);
  return {
    id: acrisId('QueueMeasurement', m.id),
    type: 'QueueMeasurement',
    Occupancy: prop(m.occupancy),
    WaitTime: prop(m.waitTimeSec),
    ProjectedWaitTime: prop(m.projectedWaitTimeSec),
    Throughput: prop(m.throughputPerHour),
    MeasurementTimePeriod: prop({ EndTime: m.measuredAt }),
    MeasurementDevice: prop({
      Name: `${m.checkpointId}-sensor`,
      MeasurementDeviceLocation: { Name: m.checkpointId },
    }),
    PassengerQueue: prop({
      Identifier: m.queueId,
      Name: queue?.name ?? m.queueId,
      CheckpointFacility: { Identifier: m.checkpointId },
    }),
    '@context': NGSI_LD_CONTEXT,
  };
}
