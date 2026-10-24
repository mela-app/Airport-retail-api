/**
 * IATA AIDX `IATA_AIDX_FlightLegNotifRQ` messages, in the shape of the illustrative sample
 * (samples/aodb-samples/AIDX_FlightLegNotifRQ_XH960_arrival_ILLUSTRATIVE.xml).
 *
 * The element set is the subset the platform needs. Like the sample, it is illustrative: validate against the
 * official IATA AIDX XSD before using it for integration tests. Mapping of event types:
 *
 * | event        | PublicStatus | OperationTime (qualifier / type)          | other                          |
 * |--------------|--------------|-------------------------------------------|--------------------------------|
 * | estimate     | EXP          | ONB EST, TDN EST (arrivals)               |                                |
 * | delay        | DEL          | OFB EST, OFB TAR (TOBT), TKO EST          | Delay codes                    |
 * | gate_change  | (unchanged)  |                                           | AirportResources Usage=Planned |
 * | boarding     | BRD          |                                           |                                |
 * | gate_closed  | GCL          |                                           |                                |
 * | off_block    | DEP          | OFB ACT                                   |                                |
 * | airborne     | DEP          | TKO ACT                                   |                                |
 * | landed       | LND          | TDN ACT                                   |                                |
 * | on_block     | ARR          | ONB ACT                                   | BaggageClaimUnit               |
 * | cancelled    | CNL          |                                           |                                |
 */
import type { Flight } from '@arm/domain';

import type { PlannedEvent } from '../schedule.js';
import { AODB_STATUS } from './aodb.js';
import { type XmlNode, renderXml, x } from './xml.js';

export const AIDX_NAMESPACE = 'http://www.iata.org/IATA/2007/00';

function operationTimes(flight: Flight, e: PlannedEvent): XmlNode[] {
  const c = e.changes;
  const out: XmlNode[] = [];
  const time = (qualifier: string, type: string, value: string | null | undefined) => {
    if (value) {
      out.push(
        x(
          'OperationTime',
          [
            ['OperationQualifier', qualifier],
            ['CodeContext', '9750'],
            ['TimeType', type],
          ],
          value,
        ),
      );
    }
  };
  if (flight.direction === 'D') {
    time('OFB', 'SCT', flight.scheduledTime);
    time('OFB', 'EST', c.estimatedTime);
    time('OFB', 'TAR', c.tobt);
    time('TKO', 'EST', c.estimatedRunwayTime);
    time('OFB', 'ACT', e.type === 'off_block' ? c.actualBlockTime : null);
    time('TKO', 'ACT', e.type === 'airborne' ? c.actualRunwayTime : null);
  } else {
    time('ONB', 'SCT', flight.scheduledTime);
    time('ONB', 'EST', c.estimatedTime);
    time('TDN', 'EST', c.estimatedRunwayTime);
    time('TDN', 'ACT', e.type === 'landed' ? c.actualRunwayTime : null);
    time('ONB', 'ACT', e.type === 'on_block' ? c.actualBlockTime : null);
  }
  return out;
}

/** Departure date at the origin, as AIDX `OriginDate` (UTC date of the scheduled departure). */
function originDate(flight: Flight, blockMinutes: number): string {
  const scheduled = Date.parse(flight.scheduledTime);
  const depart = flight.direction === 'D' ? scheduled : scheduled - blockMinutes * 60_000;
  return new Date(depart).toISOString().slice(0, 10);
}

/**
 * Render one event as an AIDX message. `flight` is the flight's state after the event is applied;
 * `sequence` is the feed's message counter.
 */
export function toAidxXml(flight: Flight, e: PlannedEvent, sequence: number, blockMinutes: number): string {
  const resource = x(
    'Resource',
    [['DepartureOrArrival', flight.direction === 'D' ? 'Departure' : 'Arrival']],
    undefined,
    [
      flight.stand ? x('AircraftParkingPosition', [], flight.stand) : null,
      flight.gate ? x('Gate', [], flight.gate) : null,
      flight.baggageBelt ? x('BaggageClaimUnit', [], flight.baggageBelt) : null,
      x('AircraftTerminal', [], flight.terminal),
    ],
  );

  const legData = x(
    'LegData',
    [['InternalDomesticIndicator', String(flight.nature === 'domestic')]],
    undefined,
    [
      x('PublicStatus', [], AODB_STATUS.get(flight.status) ?? 'SCH'),
      x('ServiceType', [], flight.serviceType),
      ...flight.codeshares
        .filter((code) => code !== flight.airlineIata)
        .map((code) =>
          x('CodeShareInfo', [], undefined, [
            x('Airline', [], code),
            x('FlightNumber', [], flight.flightNumber),
          ]),
        ),
      x('AirportResources', [['Usage', e.type === 'gate_change' ? 'Planned' : 'Actual']], undefined, [
        resource,
      ]),
      ...operationTimes(flight, e),
      ...(e.changes.delayCodes ?? []).map((code) =>
        x('Delay', [
          ['DelayCode', code],
          ['CodeContext', 'IATA'],
        ]),
      ),
      x('AircraftInfo', [], undefined, [
        x('AircraftType', [], flight.aircraftTypeIcao),
        flight.aircraftRegistration ? x('Registration', [], flight.aircraftRegistration) : null,
      ]),
      flight.pax === null
        ? null
        : x('CabinClass', [['Class', 'Y']], undefined, [
            x('SeatCapacity', [], String(flight.seats)),
            x('PaxCount', [], String(flight.pax)),
          ]),
    ],
  );

  const root = x(
    'IATA_AIDX_FlightLegNotifRQ',
    [
      ['xmlns', AIDX_NAMESPACE],
      ['Version', '16.1'],
      ['Target', 'Test'],
      ['TimeStamp', e.at],
      ['TransactionIdentifier', ['MQI-AODB-', String(sequence).padStart(9, '0')].join('')],
      ['SequenceNmbr', String(sequence)],
    ],
    undefined,
    [
      x('Originator', [
        ['CompanyShortName', 'MQI'],
        ['TravelSector', '5'],
        ['Code', 'MQI'],
        ['CodeContext', '3'],
      ]),
      x('DeliveringSystem', [['CompanyShortName', 'AODB']]),
      x('FlightLeg', [], undefined, [
        x('LegIdentifier', [], undefined, [
          x('Airline', [['CodeContext', '3']], flight.airlineIata),
          x('FlightNumber', [], flight.flightNumber),
          x('DepartureAirport', [['CodeContext', '3']], flight.origin),
          x('ArrivalAirport', [['CodeContext', '3']], flight.destination),
          x('OriginDate', [], originDate(flight, blockMinutes)),
        ]),
        legData,
      ]),
    ],
  );
  return renderXml(root);
}
