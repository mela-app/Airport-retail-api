/**
 * Evidence: every input to an ad decision is a recorded data point with its source, timestamp and
 * freshness. The AI may only cite evidence ids; a deterministic verifier checks each citation exists in a
 * trusted feed and is fresh enough before a decision is executed.
 */
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });

export const EvidenceSourceSchema = z.enum([
  'aodb',
  'aidx',
  'acris',
  'screen',
  'scan',
  'redemption',
  'platform',
  /** Airline aggregated audience profiles (booking mix, PNR and APIS aggregates). */
  'audience',
  /** Values the platform computed from the above (e.g. a crowd's holiday share); they cite their inputs. */
  'derived',
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** How old a data point may be (simulation seconds) and still be used for a decision. */
export const FRESHNESS_LIMIT_SEC: ReadonlyMap<EvidenceSource, number> = new Map([
  ['aodb', 6 * 3600],
  ['aidx', 2 * 3600],
  ['acris', 15 * 60],
  ['screen', 5 * 60],
  ['scan', 24 * 3600],
  ['redemption', 24 * 3600],
  ['platform', 30 * 24 * 3600],
  ['audience', 24 * 3600],
  ['derived', 5 * 60],
]);

export const EvidenceSchema = z.object({
  /** Stable id the AI and the decision log cite, e.g. `ev:aidx:XH501-D-20261016:etd`. */
  id: z.string().min(1),
  source: EvidenceSourceSchema,
  /** The entity it describes, e.g. `flight:XH501-D-20261016` or `zone:T2-D`. */
  subject: z.string().min(1),
  /** The attribute, e.g. `estimatedTime`, `pax`, `waitTimeSec`. */
  field: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  /** When the source observed the value. */
  observedAt: instant,
  /** The source message or row it came from (transaction id, AODB row id, entity id). */
  sourceRef: z.string().min(1),
  /** For derived values: the evidence ids they were computed from. */
  derivedFrom: z.array(z.string()).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export interface FreshnessCheck {
  fresh: boolean;
  ageSec: number;
  limitSec: number;
}

/** Whether a data point may still be used at simulation time `now`. Future-dated points are not fresh. */
export function checkFreshness(evidence: Pick<Evidence, 'source' | 'observedAt'>, now: Date): FreshnessCheck {
  const limitSec = FRESHNESS_LIMIT_SEC.get(evidence.source) ?? 0;
  const ageSec = Math.round((now.getTime() - Date.parse(evidence.observedAt)) / 1000);
  return { fresh: ageSec >= 0 && ageSec <= limitSec, ageSec, limitSec };
}
