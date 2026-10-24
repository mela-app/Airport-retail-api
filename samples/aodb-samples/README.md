# Reference data samples

These files show the shape of the airport data the POC must consume. They describe a fictional airport, **Meridian International (code `MQI`)**, a two-terminal hub with T1 for domestic and T2 for international flights. Every airport, city, airline, ground handler and aircraft registration in them is invented. Field layouts follow real industry formats, but the values are generated.

## Files

| File | What it is | Status |
|---|---|---|
| `MQI_aodb_flights_2026-10-14_SYNTHETIC.csv` | One operating day at MQI from an AODB (Airport Operational Database): 320 rows (160 arrival/departure pairs, linked by `linked_flight_id`), 33 columns including A-CDM times (TOBT, TSAT, AIBT/AOBT), stand, gate, check-in counters, baggage belt, aircraft registration and type, seats, pax, status, IATA delay codes, codeshares and handler | Synthetic |
| `AIDX_FlightLegNotifRQ_XH960_arrival_ILLUSTRATIVE.xml` | One IATA AIDX `FlightLegNotifRQ` message for the arrival of flight XH960, matching row `aodb_flight_id = 100180` in the CSV | Hand-written illustration; check against the official IATA AIDX XSD before using it for integration tests |
| `ACRIS-smart-data-models/` | ACI ACRIS semantic model entities (airport, terminal, concourse, checkpoint, passenger process and queue, measurement), each with JSON Schema, Swagger and example payloads | Public standard, copied unchanged from the FIWARE Smart Data Models project ([dataModel.ACRIS](https://github.com/smart-data-models/dataModel.ACRIS)) under its own licence |

## CSV notes

- Times are ISO 8601 in UTC. Paired columns such as `STA_STD` or `ALDT_ATOT` hold the arrival value on `direction = A` rows and the departure value on `direction = D` rows.
- `flight_nature` is `D` (domestic) or `I` (international). `status` is `ARR`, `DEP` or `CNL`.
- `codeshares` is a `|`-separated list of marketing carrier codes. `delay_codes` uses standard IATA delay codes, `/`-separated when there are several.
- `aircraft_type_icao` uses real ICAO type designators (A359, B38M and so on). Registrations use the `Q` prefix, which no country uses for aircraft.

## Fictional reference lists

**Airlines**

| IATA | ICAO | Name | Main market |
|---|---|---|---|
| XD | SKJ | Skylark Air | Domestic and regional low-cost |
| YA | AUQ | Aurora National Airlines | Domestic full-service |
| YN | KSQ | Kestrel Air | Domestic low-cost |
| XU | CWQ | Coralwing Express | Domestic low-cost |
| YF | SVZ | Sunvale Airlines | Domestic low-cost |
| ZO | SLQ | Solano Airways | International |
| XH | HCZ | Halcyon Airways | International |
| YG | ACZ | Alpine Continental Airlines | International |
| XI | CRU | Crescent Airways | International |
| YU | LPZ | Lumen Pacific Airlines | International |
| YB | NSZ | Northstar Atlantic | International |

**Airports**

| Code | City | Type |
|---|---|---|
| MQI | Meridian International (home airport) | |
| ADN | Aldmere | Domestic |
| BWZ | Brightwater | Domestic |
| CBP | Calder Bay | Domestic |
| CPZ | Coralport | Domestic |
| DMQ | Dunmore | Domestic |
| EHQ | Eastholm | Domestic |
| FHQ | Fairhaven | Domestic |
| GRH | Glenrock | Domestic |
| GSZ | Goldsand | Domestic |
| HCX | Highcliff | Domestic |
| IVQ | Ironvale | Domestic |
| JFQ | Juniper Falls | Domestic |
| LMW | Lakemont | Domestic |
| NGV | Northgate | Domestic |
| OKZ | Oakridge | Domestic |
| BVQ | Belvista | International |
| KST | Kastell | International |
| NVQ | Novaterra | International |
| PVQ | Port Valen | International |
| SCJ | Santa Corvina | International |
| SMG | Solmara | International |
| ZHQ | Zarhan | International |

**Ground handlers:** Skylark self-handling, Meridian Ground Services, Harbor Aviation Services, Compass Ground Handling.

## Using the samples

Treat these files as fixtures for the AODB, AIDX and ACRIS adapters. The POC's own mock-data generator should produce data in the same shape, at the full scale given in the challenge requirements.
