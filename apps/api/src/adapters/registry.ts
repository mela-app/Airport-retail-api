/**
 * Builds the configured source adapters. This is the only place that knows which implementation is in use.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GENERATOR_VERSION, generateWorld, writeWorld } from '@arm/mockgen';

import type { AppConfig } from '../config.js';
import type { AudienceSource, FeedClock, FeedHealth, FlightSource, SpaceSource } from './contracts.js';
import { AirlineApiAudienceSource } from './live/airline-audience-source.js';
import { type HttpEndpoint, createEndpoint } from './live/http.js';
import { NgsiLdSpaceSource } from './live/ngsi-ld-space-source.js';
import { VendorApiFlightSource } from './live/vendor-flight-source.js';
import { MockRulesAudienceSource } from './mock/audience-source.js';
import { MockAidxFlightSource } from './mock/flight-source.js';
import { MockAcrisSpaceSource } from './mock/space-source.js';

export interface Sources {
  flights: FlightSource;
  space: SpaceSource;
  audience: AudienceSource;
  health(): FeedHealth[];
}

const MAX_RESPONSE_BYTES = 20_000_000;

/**
 * The directory of the configured day's mock data. Generated (deterministically, from SIM_DATE and SIM_SEED)
 * the first time it is needed, so a fresh checkout starts with data and no manual step.
 */
/** Whether a generated day matches the generator version and the configured seed, size and offset. */
function mockDataCurrent(manifestPath: string, config: AppConfig): boolean {
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return (
      m.generatorVersion === GENERATOR_VERSION &&
      m.seed === config.SIM_SEED &&
      m.pairs === config.SIM_PAIRS &&
      m.utcOffsetMinutes === config.AIRPORT_UTC_OFFSET_MINUTES
    );
  } catch {
    return false;
  }
}

export function ensureMockData(config: AppConfig): string {
  const dayDir = resolve(join(config.DATA_DIR, config.SIM_DATE));
  if (!mockDataCurrent(join(dayDir, 'manifest.json'), config)) {
    const world = generateWorld({
      date: config.SIM_DATE,
      seed: config.SIM_SEED,
      pairs: config.SIM_PAIRS,
      utcOffsetMinutes: config.AIRPORT_UTC_OFFSET_MINUTES,
    });
    writeWorld(world, dayDir);
  }
  return dayDir;
}

export function createSources(config: AppConfig, clock: FeedClock): Sources {
  const usesMock =
    config.FLIGHT_SOURCE === 'mock-aidx' ||
    config.SPACE_SOURCE === 'mock-acris' ||
    config.AUDIENCE_SOURCE === 'mock-rules';
  const dayDir = usesMock ? ensureMockData(config) : '';
  const endpoint = (baseUrl: string | undefined, token: string | undefined): HttpEndpoint =>
    createEndpoint({
      baseUrl: baseUrl ?? '',
      token,
      timeoutMs: config.LIVE_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });

  const flights: FlightSource =
    config.FLIGHT_SOURCE === 'vendor-api'
      ? new VendorApiFlightSource({
          endpoint: endpoint(config.VENDOR_API_URL, config.VENDOR_API_TOKEN),
          pollIntervalMs: config.LIVE_POLL_INTERVAL_MS,
          clock,
        })
      : new MockAidxFlightSource({ dayDir, homeAirport: config.HOME_AIRPORT, clock });

  const space: SpaceSource =
    config.SPACE_SOURCE === 'ngsi-ld'
      ? new NgsiLdSpaceSource({
          endpoint: endpoint(config.NGSI_LD_URL, config.NGSI_LD_TOKEN),
          pollIntervalMs: config.LIVE_POLL_INTERVAL_MS,
          clock,
        })
      : new MockAcrisSpaceSource({ dayDir, clock });

  const audience: AudienceSource =
    config.AUDIENCE_SOURCE === 'airline-api'
      ? new AirlineApiAudienceSource({
          endpoint: endpoint(config.AIRLINE_API_URL, config.AIRLINE_API_TOKEN),
          clock,
        })
      : new MockRulesAudienceSource({ dayDir, utcOffsetMinutes: config.AIRPORT_UTC_OFFSET_MINUTES, clock });

  return {
    flights,
    space,
    audience,
    health: () => [...flights.health(), ...space.health(), ...audience.health()],
  };
}
