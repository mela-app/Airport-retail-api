/**
 * Builds the evidence set of a decision: every measured input with its source, timestamp and reference.
 *
 * Ids are stable and readable, e.g. `ev:aidx:XH501-D-20261016:delay_min` or `ev:derived:SCR-T2-D-01:share:tripPurpose.holiday`.
 * The AI may only cite these ids; the verifier checks each one exists, comes from a trusted feed, is fresh
 * enough, and carries the value the AI claims.
 */
import { type Evidence, SEGMENT_KEYS, segmentShare } from '@arm/domain';

import type { LiveState } from '../sim/live-state.js';
import type { CrowdEstimate } from './presence.js';
import type { CandidateEvaluation } from './scoring.js';

export interface ScreenStatusInfo {
  status: string;
  lastHeartbeat: string | null;
}

export interface ModelInfo {
  version: string;
  trainedAt: string;
}

export interface EvidenceInputs {
  now: Date;
  screenId: string;
  screenStatus: ScreenStatusInfo;
  crowd: CrowdEstimate;
  candidates: readonly CandidateEvaluation[];
  state: Pick<LiveState, 'provenance' | 'flight' | 'audienceReceivedAt'>;
  model: ModelInfo;
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Flights recorded individually per decision: the largest contributors, plus the most delayed others. */
export const MAX_FLIGHT_EVIDENCE = 15;
export const MAX_DELAYED_EVIDENCE = 10;

export const flightEvidenceId = (source: string, flightId: string, field: string) =>
  `ev:${source}:${flightId}:${field}`;
export const crowdEvidenceId = (screenId: string, field: string) => `ev:derived:${screenId}:${field}`;
export const performanceEvidenceId = (campaignId: string) => `ev:redemption:${campaignId}:performance`;

export function buildEvidence(inputs: EvidenceInputs): Evidence[] {
  const { now, screenId, crowd, state } = inputs;
  const nowIso = now.toISOString();
  const out = new Map<string, Evidence>();
  const add = (e: Evidence) => out.set(e.id, e);

  const flightIds: string[] = [];
  const audienceIds: string[] = [];
  // Flight evidence for the largest contributors and for delayed flights (they can activate triggers); the
  // derived crowd values below summarise every contributor.
  const largest = crowd.contributors.slice(0, MAX_FLIGHT_EVIDENCE);
  const delayed = crowd.contributors
    .slice(MAX_FLIGHT_EVIDENCE)
    .filter((c) => c.delayMin > 0)
    .sort((a, b) => b.delayMin - a.delayMin)
    .slice(0, MAX_DELAYED_EVIDENCE);
  for (const c of [...largest, ...delayed]) {
    const flight = state.flight(c.flightId);
    if (!flight) continue;
    const p = state.provenance(c.flightId);
    const subject = `flight:${c.flightId}`;
    const fields: [string, string | number | null][] = [
      ['pax', c.flightPax],
      ['scheduled_time', flight.scheduledTime],
      ['estimated_time', flight.estimatedTime ?? flight.scheduledTime],
      ['delay_min', c.delayMin],
      ['gate', flight.gate],
      ['status', flight.status],
    ];
    for (const [field, value] of fields) {
      const id = flightEvidenceId(p.source, c.flightId, field);
      flightIds.push(id);
      add({ id, source: p.source, subject, field, value, observedAt: p.observedAt, sourceRef: p.ref });
    }
    const audienceId = flightEvidenceId('audience', c.flightId, 'profile');
    audienceIds.push(audienceId);
    add({
      id: audienceId,
      source: 'audience',
      subject,
      field: 'profile',
      value: `aggregate profile of ${c.flightPax} pax`,
      observedAt: state.audienceReceivedAt(),
      sourceRef: `audience:${c.flightId}`,
    });
  }

  const queueIds: string[] = [];
  for (const q of crowd.queues) {
    for (const [field, value] of [
      ['occupancy', q.occupancy],
      ['wait_time_sec', q.waitTimeSec],
    ] as const) {
      const id = `ev:acris:${q.queueId}:${field}`;
      queueIds.push(id);
      add({
        id,
        source: 'acris',
        subject: `queue:${q.queueId}`,
        field,
        value,
        observedAt: q.measuredAt,
        sourceRef: q.id,
      });
    }
  }

  add({
    id: `ev:screen:${screenId}:status`,
    source: 'screen',
    subject: `screen:${screenId}`,
    field: 'status',
    value: inputs.screenStatus.status,
    observedAt: inputs.screenStatus.lastHeartbeat ?? nowIso,
    sourceRef: `heartbeat:${screenId}`,
  });

  // Derived crowd values cite the flight, audience and queue evidence they were computed from.
  const derivedFrom = [
    ...flightIds.filter((id) => id.endsWith(':pax') || id.endsWith(':estimated_time')),
    ...audienceIds,
    ...queueIds,
  ];
  const derived = (field: string, value: number | null) =>
    add({
      id: crowdEvidenceId(screenId, field),
      source: 'derived',
      subject: `screen:${screenId}`,
      field,
      value,
      observedAt: nowIso,
      sourceRef: `crowd:${screenId}:${crowd.at}`,
      derivedFrom,
    });
  derived('pax', r4(crowd.pax));
  derived('median_dwell_min', crowd.medianDwellMin);
  derived('max_delay_min', crowd.maxDelayMin);
  for (const key of SEGMENT_KEYS) derived(`share:${key}`, r4(segmentShare(crowd.profile, key)));

  for (const c of inputs.candidates) {
    if (!c.score) continue;
    add({
      id: performanceEvidenceId(c.campaignId),
      source: 'redemption',
      subject: `campaign:${c.campaignId}`,
      field: 'performance',
      value: c.score.performance,
      observedAt: inputs.model.trainedAt,
      sourceRef: `model:${inputs.model.version}`,
    });
  }
  return [...out.values()];
}
