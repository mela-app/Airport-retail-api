# Data adapter guide

The platform reads three kinds of airport data. Each source sits behind an adapter interface, and the
application core only ever sees the canonical model in `packages/domain`. Going live means writing (or
configuring) one new adapter; nothing else in the code changes.

| Source                                | Standard                   | Interface        | Mock adapter | Live adapter  | Switch            |
| ------------------------------------- | -------------------------- | ---------------- | ------------ | ------------- | ----------------- |
| Flight movements + real-time updates  | AODB snapshot, IATA AIDX   | `FlightSource`   | `mock-aidx`  | `vendor-api`  | `FLIGHT_SOURCE`   |
| Terminals, zones, checkpoints, queues | ACI ACRIS (FIWARE NGSI-LD) | `SpaceSource`    | `mock-acris` | `ngsi-ld`     | `SPACE_SOURCE`    |
| Aggregated audience per flight        | none (airline aggregates)  | `AudienceSource` | `mock-rules` | `airline-api` | `AUDIENCE_SOURCE` |

Code: `apps/api/src/adapters/` (`contracts.ts`, `parsers/`, `mock/`, `live/`, `registry.ts`).

## How data flows

```
 source format                   adapter (parser)                 canonical model          core
 ─────────────                   ────────────────                 ───────────────          ────
 AODB CSV / JSON rows     ──►    parsers/aodb.ts          ──►     Flight            ──►    ingestion,
 AIDX FlightLegNotifRQ    ──►    parsers/aidx.ts          ──►     FlightEvent       ──►    presence,
 ACRIS NGSI-LD entities   ──►    parsers/acris.ts         ──►     QueueMeasurement  ──►    decisions,
 audience aggregates      ──►    parsers/audience.ts      ──►     CrowdProfile      ──►    dashboards
```

Parsers are pure functions: they validate every record against the canonical zod schema and report rejected
records instead of passing bad data on. The mock adapters and the live adapters use the same parsers, so the
mock feeds exercise exactly the code a production feed would.

## The contracts

```ts
interface FlightSource {
  readonly adapter: string;
  snapshot(at: Date): Promise<Flight[]>; // AODB state at a point in time
  stream(from: Date, signal: AbortSignal): AsyncIterable<FlightEvent>; // real-time updates, in order
  inject?(aidxXml: string): FlightEvent; // simulation only
  health(): FeedHealth[];
}

interface SpaceSource {
  readonly adapter: string;
  facilities(): Promise<AcrisFacility[]>;
  latest(at: Date): Promise<QueueMeasurement[]>;
  stream(from: Date, signal: AbortSignal): AsyncIterable<QueueMeasurement>;
  health(): FeedHealth[];
}

interface AudienceSource {
  readonly adapter: string;
  profiles(flights: readonly Flight[]): Promise<Map<string, CrowdProfile>>;
  health(): FeedHealth[];
}
```

Every adapter reports `FeedHealth` per feed: status (`up`, `degraded`, `down`), messages in total and per
minute, rejected messages, the time of the last message and the last error. The Platform Admin's feed-health
panel shows these.

Adapters receive a `FeedClock`. In the demo it is the simulation clock (play, pause, 1x / 10x / 60x, jump);
with live adapters it follows real time.

## AODB snapshot format

One row per flight leg; the 33 columns of the challenge sample
(`samples/aodb-samples/MQI_aodb_flights_2026-10-14_SYNTHETIC.csv`), as CSV or as a JSON array of row objects.
Column order does not matter and extra vendor columns are ignored. Paired columns hold the arrival value on
`A` rows and the departure value on `D` rows.

| Column(s)                                               | Canonical field                           | Notes                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `airline_iata`, `flight_number`, `direction`, `STA_STD` | `id`                                      | `XH960-A-20261014` (scheduled date in UTC)                                                                  |
| `aodb_flight_id` / `linked_flight_id`                   | `sourceFlightId` / `linkedFlightId`       | the link is resolved to the partner's canonical id                                                          |
| `flight_nature`                                         | `nature`                                  | `I` international, `D` domestic                                                                             |
| `STA_STD`, `ETA_ETD`                                    | `scheduledTime`, `estimatedTime`          |                                                                                                             |
| `ELDT_ETOT`, `ALDT_ATOT`                                | `estimatedRunwayTime`, `actualRunwayTime` |                                                                                                             |
| `AIBT_AOBT`, `TOBT`, `TSAT`                             | `actualBlockTime`, `tobt`, `tsat`         | A-CDM milestones                                                                                            |
| `stand`, `gate`, `checkin_counters`, `baggage_belt`     | same names                                | gates are terminal-qualified in the layout (`T2-42`)                                                        |
| `seats`, `pax_total`                                    | `seats`, `pax`                            |                                                                                                             |
| `status`                                                | `status`                                  | `SCH` `DEL` `BRD` `GCL` `DEP` `EXP` `LND` `ARR` `CNL` (the sample end-of-day file uses `ARR`, `DEP`, `CNL`) |
| `delay_codes`                                           | `delayCodes`                              | IATA codes, `/`-separated                                                                                   |
| `codeshares`, `via`                                     | `codeshares`, `via`                       | `                                                                                                           | `-separated |

## IATA AIDX messages

`IATA_AIDX_FlightLegNotifRQ`, namespace `http://www.iata.org/IATA/2007/00`, in the shape of
`samples/aodb-samples/AIDX_FlightLegNotifRQ_XH960_arrival_ILLUSTRATIVE.xml`. The flight is identified from
`LegIdentifier` and the scheduled `OperationTime` (`TimeType="SCT"`); without a scheduled time the adapter
matches airline, flight number and direction to a known flight.

| AIDX                                                                            | Canonical                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PublicStatus`                                                                  | `status` (same codes as the AODB)                                                |
| `AirportResources/Resource/Gate`, `AircraftParkingPosition`, `BaggageClaimUnit` | `gate`, `stand`, `baggageBelt`                                                   |
| `OperationTime OFB EST` / `OFB TAR` / `TKO EST` (departures)                    | `estimatedTime` / `tobt` / `estimatedRunwayTime`                                 |
| `OperationTime OFB ACT` / `TKO ACT`                                             | `actualBlockTime` / `actualRunwayTime`                                           |
| `OperationTime ONB EST` / `TDN EST` / `TDN ACT` / `ONB ACT` (arrivals)          | `estimatedTime` / `estimatedRunwayTime` / `actualRunwayTime` / `actualBlockTime` |
| `Delay@DelayCode`                                                               | `delayCodes`                                                                     |
| `CabinClass/PaxCount` (summed)                                                  | `pax`                                                                            |
| `TransactionIdentifier`, `SequenceNmbr`, `TimeStamp`                            | event `id`, `sequence`, `occurredAt`                                             |

The event type is inferred in this order: `cancelled`, `gate_change` (`AirportResources Usage="Planned"`),
`on_block`, `landed`, `airborne`, `off_block`, `gate_closed`, `boarding`, `delay`, `estimate`. Out-of-order
duplicates (a lower `SequenceNmbr` than one already applied) are dropped.

The XML parser is strict: it rejects any DOCTYPE or DTD, so external entities (XXE) and entity-expansion
attacks cannot happen; it bounds document size and nesting depth.

Like the sample, the element set is illustrative. Validate against the official IATA AIDX XSD before
connecting a production feed.

## ACI ACRIS entities

NGSI-LD entities of the FIWARE Smart Data Models `dataModel.ACRIS` (schemas in
`samples/acris-smart-data-models/`), in normalized or keyValues form. Entity ids follow
`urn:ngsi-ld:<Type>:<airport>:<local id>`.

| Entity                                                                                                                                                                                       | Canonical                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `QueueMeasurement`: `Occupancy`, `WaitTime`, `ProjectedWaitTime`, `Throughput`, `MeasurementTimePeriod.EndTime`, `PassengerQueue.Identifier`, `PassengerQueue.CheckpointFacility.Identifier` | `QueueMeasurement`                                |
| `TerminalFacility`, `ConcourseFacility`, `ZoneAreaLocation`, `CheckpointFacility`, `PassengerQueue`                                                                                          | `AcrisFacility` (reconciled with the master data) |

## Audience aggregates

A JSON object keyed by canonical flight id, each value a `CrowdProfile`: shares of trip purpose, party type,
age band, gender, cabin and market, the frequent-flyer share, and the top 3 nationalities, languages and
destinations. These are aggregates of a flight's passengers; the platform never requests or accepts data about
individual passengers.

## Live adapters

| Adapter       | Endpoint                                                        | Behaviour                                                                                           |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `vendor-api`  | `GET {VENDOR_API_URL}/flights?date=YYYY-MM-DD` → AODB JSON rows | Polls every `LIVE_POLL_INTERVAL_MS` and turns the differences between snapshots into `FlightEvent`s |
| `ngsi-ld`     | `GET {NGSI_LD_URL}/ngsi-ld/v1/entities?type=…`                  | Reads facilities once, polls `QueueMeasurement`                                                     |
| `airline-api` | `POST {AIRLINE_API_URL}/audience-aggregates {"flightIds": […]}` | Batches of 200 flights                                                                              |

All three use `adapters/live/http.ts`: http/https only, no credentials in URLs, a bearer token from the
environment, request timeout (`LIVE_TIMEOUT_MS`), a response size limit, and no redirects. Errors never contain
the token. When an endpoint fails, the feed reports `down` with the error and the adapter retries on the next
poll.

## Writing a new adapter

1. **Implement the interface** in `apps/api/src/adapters/live/` (for example a push-based AIDX feed from a
   message broker). Reuse the parser for the format: `parseAidxMessage`, `parseAodbCsv` / `parseAodbJson`,
   `parseQueueMeasurement` / `parseFacility`, `parseAudienceProfiles`.
2. **Track health** with `FeedStats` (`received`, `rejectedMessage`, `unavailable`).
3. **Register it** in `adapters/registry.ts` under a new switch value, and add the value and any endpoint
   settings to `apps/api/src/config.ts` and `.env.example`.
4. **Test it** against the fixtures in `samples/` and a local fake endpoint, as `apps/api/test/sources.test.ts`
   does for the existing live adapters.

## Mock data

The mock adapters read one generated day from `DATA_DIR/<SIM_DATE>/` (created on first start from `SIM_DATE`
and `SIM_SEED`; the same values always produce the same day):

| Path                                                       | Content                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `aodb/MQI_aodb_flights_<date>_start-of-day.csv` / `.json`  | the AODB snapshot published at local midnight                       |
| `aodb/MQI_aodb_flights_<date>_end-of-day.csv`              | the day's final state (comparable to the sample file)               |
| `aidx/stream.ndjson`                                       | the day's AIDX messages, one per line (`at`, `sequence`, `xml`)     |
| `aidx/samples/*.xml`                                       | one message of each event type, for reading                         |
| `acris/entities.jsonld`, `acris/queue-measurements.ndjson` | ACRIS facilities and the 5-minute queue series                      |
| `audience/flight-profiles.json`                            | aggregated crowd profile per flight                                 |
| `platform/*.json`                                          | screens, advertisers, outlets, creatives, campaigns, 30-day history |

Regenerate with `pnpm generate -- --date YYYY-MM-DD --seed text`.
