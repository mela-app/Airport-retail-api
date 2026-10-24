# ACI ACRIS smart data models (reference schemas)

These are the JSON Schemas of the six ACRIS entities used by the ACRIS adapter. They were copied
unchanged from the FIWARE Smart Data Models project, `dataModel.ACRIS`
(https://github.com/smart-data-models/dataModel.ACRIS, branch `master`, retrieved 2026-10-23). The
challenge sample package lists this folder, but it was not included in the shared ZIP.

| Folder | Entity | Used for |
|---|---|---|
| `TerminalFacility/` | Terminal | Terminals T1 and T2 |
| `ConcourseFacility/` | Concourse / boarding area | Piers and concourses |
| `CheckpointFacility/` | Checkpoint | Security and passport control |
| `ZoneAreaLocation/` | Zone | Commercial and gate-area zones |
| `PassengerQueue/` | Passenger queue | Queues at each checkpoint |
| `QueueMeasurement/` | Queue measurement | Occupancy, wait time and throughput readings |

`context.jsonld` is the project's JSON-LD context.

The upstream example payloads are **not** copied, because they describe a real airport. The mock data
generator produces examples for the fictional airport Meridian International (MQI) in the same
NGSI-LD shape.

Licence: the files remain under the Smart Data Models licence. Each model's `LICENSE.md` is in the
upstream repository, for example
https://github.com/smart-data-models/dataModel.ACRIS/blob/master/QueueMeasurement/LICENSE.md.
