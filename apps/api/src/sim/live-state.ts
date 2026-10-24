/**
 * The current state of the simulated world, in memory, for the engines that run every few seconds (presence,
 * ad decisions) and for fast API reads. The database holds the same data for history and queries.
 *
 * Besides the values it keeps their provenance, so every decision input can be cited as evidence: the last
 * AIDX message per flight, when the AODB snapshot last confirmed the flights, and when the audience profiles
 * were received. `version` changes whenever flights change, so engines can cache derived values.
 */
import {
  type CrowdProfile,
  type Flight,
  type FlightEvent,
  type QueueMeasurement,
  applyFlightEvent,
} from '@arm/domain';

export interface FlightProvenance {
  /** `aidx` when the latest information came from a real-time message, `aodb` when from the snapshot. */
  source: 'aodb' | 'aidx';
  /** When the source last stated the flight's current values. */
  observedAt: string;
  /** AIDX transaction id, or the AODB row id. */
  ref: string;
}

export class LiveState {
  private flights = new Map<string, Flight>();
  private profiles = new Map<string, CrowdProfile>();
  private queues = new Map<string, QueueMeasurement>();
  private lastEvents = new Map<string, FlightEvent>();
  private gateChanges = new Map<string, string>();
  /** Recent flight events, newest last (bounded). */
  private recent: FlightEvent[] = [];
  private static readonly RECENT_LIMIT = 500;
  private snapshotConfirmedAt = new Date(0).toISOString();
  private profilesReceivedAt = new Date(0).toISOString();
  private changeCounter = 0;
  /** Version of the last full reload; changes before it cannot be listed individually. */
  private reloadVersion = 0;
  /** [version, flight id] of recent individual changes (bounded). */
  private changes: [number, string][] = [];
  private static readonly CHANGE_LIMIT = 5000;

  /** Changes whenever any flight changes (cache key for derived values). */
  get version(): number {
    return this.changeCounter;
  }

  replaceFlights(flights: readonly Flight[], profiles: ReadonlyMap<string, CrowdProfile>, at: Date): void {
    this.flights = new Map(flights.map((f) => [f.id, f]));
    this.profiles = new Map(profiles);
    this.recent = [];
    this.lastEvents = new Map();
    this.gateChanges = new Map();
    this.snapshotConfirmedAt = at.toISOString();
    this.profilesReceivedAt = at.toISOString();
    this.changeCounter += 1;
    this.reloadVersion = this.changeCounter;
    this.changes = [];
  }

  /**
   * Flights changed after `version`, or `null` when the world was reloaded since (then everything changed).
   */
  changedSince(version: number): Set<string> | null {
    if (version < this.reloadVersion) return null;
    // The list is bounded: if changes right after `version` were dropped, report "everything".
    const oldest = this.changes.at(0)?.[0];
    if (oldest !== undefined && oldest > version + 1) return null;
    return new Set(this.changes.filter(([v]) => v > version).map(([, id]) => id));
  }

  /** The AODB snapshot was fetched again at `at` and confirms the current flight list. */
  confirmSnapshot(at: Date): void {
    this.snapshotConfirmedAt = at.toISOString();
  }

  applyEvent(event: FlightEvent): Flight | undefined {
    const current = this.flights.get(event.flightId);
    if (!current) return undefined;
    const next = applyFlightEvent(current, event);
    this.flights.set(next.id, next);
    const profile = this.profiles.get(next.id);
    if (profile && next.pax !== null && profile.pax !== next.pax)
      this.profiles.set(next.id, { ...profile, pax: next.pax });
    this.lastEvents.set(next.id, event);
    if (event.type === 'gate_change') this.gateChanges.set(next.id, event.occurredAt);
    this.recent.push(event);
    if (this.recent.length > LiveState.RECENT_LIMIT)
      this.recent.splice(0, this.recent.length - LiveState.RECENT_LIMIT);
    this.changeCounter += 1;
    this.changes.push([this.changeCounter, next.id]);
    if (this.changes.length > LiveState.CHANGE_LIMIT)
      this.changes.splice(0, this.changes.length - LiveState.CHANGE_LIMIT);
    return next;
  }

  setQueues(measurements: readonly QueueMeasurement[]): void {
    this.queues = new Map(measurements.map((m) => [m.queueId, m]));
  }

  recordQueue(m: QueueMeasurement): void {
    this.queues.set(m.queueId, m);
  }

  flight(id: string): Flight | undefined {
    return this.flights.get(id);
  }

  allFlights(): Flight[] {
    return [...this.flights.values()];
  }

  profile(flightId: string): CrowdProfile | undefined {
    return this.profiles.get(flightId);
  }

  profileMap(): ReadonlyMap<string, CrowdProfile> {
    return this.profiles;
  }

  queueMap(): ReadonlyMap<string, QueueMeasurement> {
    return this.queues;
  }

  latestQueues(): QueueMeasurement[] {
    return [...this.queues.values()];
  }

  recentEvents(limit = 50): FlightEvent[] {
    return this.recent.slice(-limit).reverse();
  }

  /** Flights whose gate changed, with the change time. */
  recentGateChanges(): ReadonlyMap<string, string> {
    return this.gateChanges;
  }

  /** Where the flight's current values come from. */
  provenance(flightId: string): FlightProvenance {
    const event = this.lastEvents.get(flightId);
    const flight = this.flights.get(flightId);
    if (event && Date.parse(event.occurredAt) >= Date.parse(this.snapshotConfirmedAt))
      return { source: 'aidx', observedAt: event.occurredAt, ref: event.source.ref };
    return { source: 'aodb', observedAt: this.snapshotConfirmedAt, ref: flight?.sourceFlightId ?? flightId };
  }

  audienceReceivedAt(): string {
    return this.profilesReceivedAt;
  }
}
