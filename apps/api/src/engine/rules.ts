/**
 * Business rules, applied to the verified ranking before a campaign plays:
 *
 *   manual_pin             a Media Manager pin for this screen and time wins (with its reason)
 *   relevance_floor        a candidate scoring below `minScoreToPlay` does not play here; it is kept for screens
 *                          where it fits better (the worked example's "filtered to other gates")
 *   airline_priority       in an airline's own boarding window, its priority gate messaging goes first
 *   budget_pacing          a campaign spending ahead of its daily pace is scored down (× 0.85)
 *   rotation               a campaign that played `maxConsecutivePlays` slots in a row yields the next slot
 *                          to another eligible campaign (it keeps playing when it is the only one)
 *   frequency_cap          a campaign plays at most `cap` times per screen per hour, evenly spaced (at most once
 *                          every 3600 / cap seconds), so a screen's caps are not used up in a burst
 *   competitor_separation  two campaigns of the same competitor group never play back to back on a screen
 *   exploration            a small share of slots goes to another eligible campaign, so new campaigns learn
 *
 * The result names the winner and every rule that changed the outcome.
 */
import type { CandidateEvaluation, RuleEngineSettings, SpendState } from './scoring.js';

export interface AppliedRule {
  rule:
    | 'manual_pin'
    | 'relevance_floor'
    | 'airline_priority'
    | 'budget_pacing'
    | 'rotation'
    | 'frequency_cap'
    | 'competitor_separation'
    | 'exploration';
  campaignId: string;
  detail: string;
}

export interface ScreenHistory {
  /** Campaign of the previous slot on this screen. */
  lastCampaignId: string | null;
  lastCompetitorGroup: string | null;
  /** How many slots in a row the last campaign has played. */
  consecutivePlays: number;
  /** Plays per campaign on this screen in the last hour. */
  playsLastHour: ReadonlyMap<string, number>;
  /** Last play time (epoch ms) per campaign on this screen. */
  lastPlayedAt: ReadonlyMap<string, number>;
}

export interface Pin {
  id: string;
  campaignId: string;
  reason: string;
  createdBy: string;
}

export interface RuleInput {
  /** Eligible candidates in verified order (best first). */
  ranked: readonly CandidateEvaluation[];
  settings: RuleEngineSettings;
  history: ScreenHistory;
  pin: Pin | null;
  /** Campaign id → frequency cap per screen per hour. */
  frequencyCaps: ReadonlyMap<string, number>;
  /** Campaign id → daily cap and spend. */
  pacing: ReadonlyMap<string, { dailyCap: number; spend: SpendState }>;
  /** Share of the operating day elapsed (0–1), for pacing. */
  dayElapsed: number;
  /** Slot start (epoch ms). */
  now: number;
  /** Uniform random number in [0, 1) for exploration (seeded by the caller). */
  random: number;
  /** Second random number, to pick the explored campaign. */
  random2: number;
}

export interface RuleOutcome {
  winner: CandidateEvaluation | null;
  /** The order after pacing (best first), before caps and separation. */
  order: CandidateEvaluation[];
  applied: AppliedRule[];
}

export const PACING_PENALTY = 0.85;
/** Spending more than this much ahead of the daily pace triggers the penalty. */
export const PACING_TOLERANCE = 1.15;

const score = (c: CandidateEvaluation) => c.score?.final ?? 0;

export function applyBusinessRules(input: RuleInput): RuleOutcome {
  const applied: AppliedRule[] = [];
  const { settings, history } = input;

  // Pins win outright (the pinned campaign still has to be an evaluated, eligible candidate).
  if (input.pin) {
    const pinned = input.ranked.find((c) => c.campaignId === input.pin?.campaignId);
    if (pinned) {
      applied.push({
        rule: 'manual_pin',
        campaignId: pinned.campaignId,
        detail: `pinned by ${input.pin.createdBy}: ${input.pin.reason}`,
      });
      return { winner: pinned, order: [...input.ranked], applied };
    }
  }

  // Relevance floor: poor fits here are held for screens where they fit better.
  const relevant = input.ranked.filter((c) => {
    if (score(c) >= settings.minScoreToPlay) return true;
    applied.push({
      rule: 'relevance_floor',
      campaignId: c.campaignId,
      detail: `score ${score(c).toFixed(2)} is below the ${settings.minScoreToPlay.toFixed(2)} relevance floor; held for screens where it fits better`,
    });
    return false;
  });

  // Budget pacing: re-order with a penalty for campaigns ahead of their daily pace.
  const paced = relevant.map((c) => {
    const p = input.pacing.get(c.campaignId);
    const expected = p ? p.dailyCap * Math.max(0.05, input.dayElapsed) : 0;
    const ahead = p !== undefined && p.spend.today > expected * PACING_TOLERANCE;
    return {
      c,
      effective: score(c) * (ahead ? PACING_PENALTY : 1),
      ahead,
      spent: p?.spend.today ?? 0,
      expected,
    };
  });
  const order = [...paced].sort((a, b) => b.effective - a.effective);
  if (order.at(0)?.c !== relevant.at(0) && relevant.at(0)) {
    const top = paced.find((p) => p.c === relevant.at(0));
    if (top?.ahead)
      applied.push({
        rule: 'budget_pacing',
        campaignId: top.c.campaignId,
        detail: `spent ${top.spent.toFixed(0)} of an expected ${top.expected.toFixed(0)} so far today; scored × ${PACING_PENALTY}`,
      });
  }

  const capOf = (c: CandidateEvaluation) =>
    input.frequencyCaps.get(c.campaignId) ?? settings.defaultFrequencyCap;
  const spacingMs = (c: CandidateEvaluation) => 3_600_000 / Math.max(1, capOf(c));
  const tooSoon = (c: CandidateEvaluation) => {
    const last = history.lastPlayedAt.get(c.campaignId);
    return last !== undefined && input.now - last < spacingMs(c);
  };
  const capped = (c: CandidateEvaluation) =>
    (history.playsLastHour.get(c.campaignId) ?? 0) >= capOf(c) || tooSoon(c);
  const separated = (c: CandidateEvaluation) =>
    settings.competitorSeparation &&
    c.competitorGroup !== null &&
    c.competitorGroup === history.lastCompetitorGroup &&
    c.campaignId !== history.lastCampaignId;

  const available = (c: CandidateEvaluation, note: boolean): boolean => {
    if (capped(c)) {
      if (note)
        applied.push({
          rule: 'frequency_cap',
          campaignId: c.campaignId,
          detail: tooSoon(c)
            ? `played ${Math.round((input.now - (history.lastPlayedAt.get(c.campaignId) ?? 0)) / 1000)} s ago; cap ${capOf(c)} per hour allows one play every ${Math.round(spacingMs(c) / 1000)} s`
            : `${history.playsLastHour.get(c.campaignId) ?? 0} plays on this screen in the last hour (cap ${capOf(c)})`,
        });
      return false;
    }
    if (separated(c)) {
      if (note)
        applied.push({
          rule: 'competitor_separation',
          campaignId: c.campaignId,
          detail: `a ${c.competitorGroup} campaign just played here`,
        });
      return false;
    }
    return true;
  };

  // Airline priority: the airline's own gate messaging, in its boarding window (already enforced by the
  // airline_window hard filter), goes first.
  if (settings.airlinePriorityInBoardingWindow) {
    const priority = order.find((o) => o.c.airlinePriority && available(o.c, false));
    if (priority && priority !== order.at(0)) {
      applied.push({
        rule: 'airline_priority',
        campaignId: priority.c.campaignId,
        detail: `${priority.c.advertiserName} gate messaging in its own boarding window`,
      });
      return { winner: priority.c, order: order.map((o) => o.c), applied };
    }
  }

  // Exploration: a small share of slots to another eligible campaign.
  const open = order.filter((o) => available(o.c, false));
  if (open.length > 1 && input.random < settings.explorationPct / 100) {
    const others = open.slice(1);
    const pick = others.at(Math.floor(input.random2 * others.length));
    if (pick) {
      applied.push({
        rule: 'exploration',
        campaignId: pick.c.campaignId,
        detail: `exploration slot (${settings.explorationPct}% of slots)`,
      });
      return { winner: pick.c, order: order.map((o) => o.c), applied };
    }
  }

  // Rotation: the campaign that just played `maxConsecutivePlays` slots yields, unless nothing else can play.
  const rotating = (c: CandidateEvaluation) =>
    c.campaignId === history.lastCampaignId && history.consecutivePlays >= settings.maxConsecutivePlays;
  const hasAlternative = order.some((o) => !rotating(o.c) && available(o.c, false));
  for (const o of order) {
    if (rotating(o.c) && hasAlternative) {
      applied.push({
        rule: 'rotation',
        campaignId: o.c.campaignId,
        detail: `played ${history.consecutivePlays} slots in a row; next in rotation`,
      });
      continue;
    }
    if (available(o.c, true)) return { winner: o.c, order: order.map((x) => x.c), applied };
  }
  return { winner: null, order: order.map((o) => o.c), applied };
}
