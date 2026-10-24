/**
 * Adapter contracts. The application core only sees these interfaces and canonical entities; each source has
 * a mock implementation (the POC's simulated feeds) and a live implementation (a real vendor endpoint).
 * Switching is a single configuration value per source:
 *
 *   FLIGHT_SOURCE   = mock-aidx  | vendor-api      AODB snapshot + AIDX real-time updates
 *   SPACE_SOURCE    = mock-acris | ngsi-ld         ACRIS facilities + queue measurements
 *   AUDIENCE_SOURCE = mock-rules | airline-api     aggregated crowd profile per flight
 *
 * Going live means writing (or configuring) one new implementation of the interface; nothing else changes.
 */
import type { CrowdProfile, Flight, FlightEvent, QueueMeasurement } from '@arm/domain';

import type { AcrisFacility } from './parsers/acris.js';

/** The simulation clock as adapters see it. Live adapters run against a clock that follows real time. */
export interface FeedClock {
  now(): Date;
  /** Resolves once clock time reaches `at`, or immediately when `signal` aborts (never rejects). */
  sleepUntil(at: Date, signal?: AbortSignal): Promise<void>;
}

export type FeedName = 'aodb' | 'aidx' | 'acris' | 'audience';

export interface FeedHealth {
  feed: FeedName;
  /** The adapter in use, e.g. `mock-aidx` or `vendor-api`. */
  adapter: string;
  status: 'up' | 'degraded' | 'down';
  messagesTotal: number;
  rejectedTotal: number;
  /** Messages received in the last minute of real time. */
  messagesPerMinute: number;
  /** Clock time of the last message received. */
  lastMessageAt: string | null;
  lastError: string | null;
}

export interface FlightSource {
  readonly adapter: string;
  /** Every flight as known at `at`: the AODB snapshot with all real-time updates up to `at` applied. */
  snapshot(at: Date): Promise<Flight[]>;
  /** Real-time flight-leg updates after `from`, in order, as clock time reaches them. Ends when `signal` aborts. */
  stream(from: Date, signal: AbortSignal): AsyncIterable<FlightEvent>;
  /**
   * Publish an AIDX message into the feed (simulation "inject event" buttons). The message goes through the
   * same parser as every other message. Only feeds that can accept injected messages implement it.
   */
  inject?(aidxXml: string): FlightEvent;
  /** Forget injected messages from `from` on (scenario presets start from the published feed). */
  discardInjections?(from: Date): void;
  health(): FeedHealth[];
}

export interface SpaceSource {
  readonly adapter: string;
  /** Terminals, concourses, zones, checkpoints and queues the feed describes. */
  facilities(): Promise<AcrisFacility[]>;
  /** The latest measurement of every queue at `at`. */
  latest(at: Date): Promise<QueueMeasurement[]>;
  /** New measurements after `from`, as clock time reaches them. */
  stream(from: Date, signal: AbortSignal): AsyncIterable<QueueMeasurement>;
  health(): FeedHealth[];
}

export interface AudienceSource {
  readonly adapter: string;
  /** Aggregated crowd profiles for the given flights (flights without a profile are omitted). */
  profiles(flights: readonly Flight[]): Promise<Map<string, CrowdProfile>>;
  health(): FeedHealth[];
}
