/**
 * Reference data for the fictional airport Meridian International (MQI). Airlines, airports, handlers and
 * aircraft registrations are invented; the lists follow the challenge's sample package
 * (samples/aodb-samples/README.md). Aircraft types are real ICAO designators.
 */
import type { AircraftType } from './flight.js';

export const HOME_AIRPORT = {
  iata: 'MQI',
  icao: 'QMQI',
  name: 'Meridian International',
  city: 'Meridian',
  country: 'Meridia',
} as const;

export interface Airline {
  iata: string;
  icao: string;
  name: string;
  /** Business model, used for cabin and fare mix. */
  model: 'low_cost' | 'full_service';
  market: 'domestic' | 'international' | 'mixed';
  brandColor: string;
}

export const AIRLINES: readonly Airline[] = [
  { iata: 'XD', icao: 'SKJ', name: 'Skylark Air', model: 'low_cost', market: 'mixed', brandColor: '#F2A900' },
  {
    iata: 'YA',
    icao: 'AUQ',
    name: 'Aurora National Airlines',
    model: 'full_service',
    market: 'mixed',
    brandColor: '#1F4E9C',
  },
  {
    iata: 'YN',
    icao: 'KSQ',
    name: 'Kestrel Air',
    model: 'low_cost',
    market: 'domestic',
    brandColor: '#D9472B',
  },
  {
    iata: 'XU',
    icao: 'CWQ',
    name: 'Coralwing Express',
    model: 'low_cost',
    market: 'domestic',
    brandColor: '#0FA3A3',
  },
  {
    iata: 'YF',
    icao: 'SVZ',
    name: 'Sunvale Airlines',
    model: 'low_cost',
    market: 'domestic',
    brandColor: '#F28C28',
  },
  {
    iata: 'ZO',
    icao: 'SLQ',
    name: 'Solano Airways',
    model: 'full_service',
    market: 'international',
    brandColor: '#6B2D8C',
  },
  {
    iata: 'XH',
    icao: 'HCZ',
    name: 'Halcyon Airways',
    model: 'full_service',
    market: 'international',
    brandColor: '#0B6E4F',
  },
  {
    iata: 'YG',
    icao: 'ACZ',
    name: 'Alpine Continental Airlines',
    model: 'full_service',
    market: 'international',
    brandColor: '#B22234',
  },
  {
    iata: 'XI',
    icao: 'CRU',
    name: 'Crescent Airways',
    model: 'full_service',
    market: 'international',
    brandColor: '#8C6D1F',
  },
  {
    iata: 'YU',
    icao: 'LPZ',
    name: 'Lumen Pacific Airlines',
    model: 'full_service',
    market: 'international',
    brandColor: '#2C7FB8',
  },
  {
    iata: 'YB',
    icao: 'NSZ',
    name: 'Northstar Atlantic',
    model: 'full_service',
    market: 'international',
    brandColor: '#22313F',
  },
];

/** What kind of trips a destination attracts; drives the plausible crowd profile of its flights. */
export type DestinationCharacter =
  'capital' | 'business_hub' | 'beach' | 'resort' | 'nature' | 'vfr' | 'university' | 'religious';

export interface Destination {
  iata: string;
  city: string;
  country: string;
  /** Demonym used for nationality shares. */
  nationality: string;
  /** ISO 639-1 language mainly spoken there. */
  language: string;
  market: 'domestic' | 'international';
  /** Region used by campaign hard filters (e.g. `gulf`). */
  region: string;
  character: DestinationCharacter;
  /** Flight time from MQI in minutes (drives arrival times and aircraft choice). */
  blockMinutes: number;
}

export const DESTINATIONS: readonly Destination[] = [
  // domestic (country: Meridia)
  {
    iata: 'ADN',
    city: 'Aldmere',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'capital',
    blockMinutes: 70,
  },
  {
    iata: 'BWZ',
    city: 'Brightwater',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'vfr',
    blockMinutes: 55,
  },
  {
    iata: 'CBP',
    city: 'Calder Bay',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'beach',
    blockMinutes: 80,
  },
  {
    iata: 'CPZ',
    city: 'Coralport',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'beach',
    blockMinutes: 95,
  },
  {
    iata: 'DMQ',
    city: 'Dunmore',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'vfr',
    blockMinutes: 60,
  },
  {
    iata: 'EHQ',
    city: 'Eastholm',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'business_hub',
    blockMinutes: 75,
  },
  {
    iata: 'FHQ',
    city: 'Fairhaven',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'vfr',
    blockMinutes: 50,
  },
  {
    iata: 'GRH',
    city: 'Glenrock',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'nature',
    blockMinutes: 65,
  },
  {
    iata: 'GSZ',
    city: 'Goldsand',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'beach',
    blockMinutes: 90,
  },
  {
    iata: 'HCX',
    city: 'Highcliff',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'resort',
    blockMinutes: 85,
  },
  {
    iata: 'IVQ',
    city: 'Ironvale',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'business_hub',
    blockMinutes: 60,
  },
  {
    iata: 'JFQ',
    city: 'Juniper Falls',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'nature',
    blockMinutes: 75,
  },
  {
    iata: 'LMW',
    city: 'Lakemont',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'university',
    blockMinutes: 55,
  },
  {
    iata: 'NGV',
    city: 'Northgate',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'business_hub',
    blockMinutes: 80,
  },
  {
    iata: 'OKZ',
    city: 'Oakridge',
    country: 'Meridia',
    nationality: 'Meridian',
    language: 'en',
    market: 'domestic',
    region: 'meridia',
    character: 'vfr',
    blockMinutes: 50,
  },
  // international
  {
    iata: 'ZHQ',
    city: 'Zarhan',
    country: 'Zarhan Emirates',
    nationality: 'Zarhani',
    language: 'ar',
    market: 'international',
    region: 'gulf',
    character: 'business_hub',
    blockMinutes: 240,
  },
  {
    iata: 'KST',
    city: 'Kastell',
    country: 'Kastellia',
    nationality: 'Kastellian',
    language: 'de',
    market: 'international',
    region: 'europe',
    character: 'capital',
    blockMinutes: 420,
  },
  {
    iata: 'NVQ',
    city: 'Novaterra',
    country: 'Novaterra',
    nationality: 'Novaterran',
    language: 'zh',
    market: 'international',
    region: 'asia_pacific',
    character: 'business_hub',
    blockMinutes: 480,
  },
  {
    iata: 'BVQ',
    city: 'Belvista',
    country: 'Belvistan Republic',
    nationality: 'Belvistan',
    language: 'it',
    market: 'international',
    region: 'europe',
    character: 'beach',
    blockMinutes: 390,
  },
  {
    iata: 'SCJ',
    city: 'Santa Corvina',
    country: 'Corvina',
    nationality: 'Corvinan',
    language: 'es',
    market: 'international',
    region: 'americas',
    character: 'beach',
    blockMinutes: 540,
  },
  {
    iata: 'SMG',
    city: 'Solmara',
    country: 'Solmara Islands',
    nationality: 'Solmaran',
    language: 'fr',
    market: 'international',
    region: 'indian_ocean',
    character: 'resort',
    blockMinutes: 300,
  },
  {
    iata: 'PVQ',
    city: 'Port Valen',
    country: 'Valenia',
    nationality: 'Valenese',
    language: 'hi',
    market: 'international',
    region: 'south_asia',
    character: 'religious',
    blockMinutes: 270,
  },
];

export const REGION_LABELS: ReadonlyMap<string, string> = new Map([
  ['meridia', 'Meridia (domestic)'],
  ['gulf', 'Gulf'],
  ['europe', 'Europe'],
  ['asia_pacific', 'Asia-Pacific'],
  ['americas', 'Americas'],
  ['indian_ocean', 'Indian Ocean'],
  ['south_asia', 'South Asia'],
]);

export const LANGUAGE_LABELS: ReadonlyMap<string, string> = new Map([
  ['en', 'English'],
  ['ar', 'Arabic'],
  ['de', 'German'],
  ['zh', 'Chinese'],
  ['it', 'Italian'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['hi', 'Hindi'],
]);

export const GROUND_HANDLERS = [
  'Skylark self-handling',
  'Meridian Ground Services',
  'Harbor Aviation Services',
  'Compass Ground Handling',
] as const;

/** Aircraft types seen in the sample, with the cabin layouts used to estimate cabin mix. */
export const AIRCRAFT_TYPES: readonly AircraftType[] = [
  {
    icao: 'AT76',
    name: 'ATR 72-600',
    wideBody: false,
    cabins: { business: 0, premium_economy: 0, economy: 78 },
  },
  {
    icao: 'A20N',
    name: 'Airbus A320neo',
    wideBody: false,
    cabins: { business: 0, premium_economy: 0, economy: 186 },
  },
  {
    icao: 'A21N',
    name: 'Airbus A321neo',
    wideBody: false,
    cabins: { business: 0, premium_economy: 0, economy: 232 },
  },
  {
    icao: 'B38M',
    name: 'Boeing 737 MAX 8',
    wideBody: false,
    cabins: { business: 0, premium_economy: 0, economy: 189 },
  },
  {
    icao: 'B738',
    name: 'Boeing 737-800',
    wideBody: false,
    cabins: { business: 0, premium_economy: 0, economy: 189 },
  },
  {
    icao: 'A359',
    name: 'Airbus A350-900',
    wideBody: true,
    cabins: { business: 30, premium_economy: 0, economy: 253 },
  },
  {
    icao: 'B788',
    name: 'Boeing 787-8',
    wideBody: true,
    cabins: { business: 24, premium_economy: 28, economy: 204 },
  },
  {
    icao: 'B789',
    name: 'Boeing 787-9',
    wideBody: true,
    cabins: { business: 28, premium_economy: 35, economy: 236 },
  },
  {
    icao: 'B77W',
    name: 'Boeing 777-300ER',
    wideBody: true,
    cabins: { business: 42, premium_economy: 24, economy: 288 },
  },
  {
    icao: 'B748',
    name: 'Boeing 747-8',
    wideBody: true,
    cabins: { business: 48, premium_economy: 32, economy: 284 },
  },
  {
    icao: 'A388',
    name: 'Airbus A380-800',
    wideBody: true,
    cabins: { business: 64, premium_economy: 44, economy: 381 },
  },
];

/** Full-service operators fly a two-class narrow-body layout on short routes. */
export const FULL_SERVICE_NARROWBODY_BUSINESS_SEATS = 12;

/** IATA delay codes used in the data (a subset of the AHM 730 standard list). */
export const DELAY_CODES: ReadonlyMap<string, string> = new Map([
  ['11', 'Late check-in, acceptance after deadline'],
  ['41', 'Aircraft defects'],
  ['63', 'Late crew boarding or departure procedures'],
  ['81', 'ATFM due to ATC en-route demand / capacity'],
  ['89', 'Restrictions at airport of departure'],
  ['93', 'Aircraft rotation, late arrival from another flight'],
]);

export interface Route {
  airlineIata: string;
  destination: string;
  /** Relative frequency of the route in the generated schedule. */
  weight: number;
  /** Aircraft types flown on the route (ICAO). */
  fleet: readonly string[];
}

/** The route network, following the sample day (airline → destinations and fleet). */
export const ROUTES: readonly Route[] = [
  // Skylark Air: domestic and regional low-cost, the dominant carrier
  ...['JFQ', 'LMW', 'IVQ', 'HCX', 'NGV', 'EHQ', 'ADN', 'CBP', 'GSZ', 'BWZ', 'FHQ', 'CPZ', 'GRH'].map(
    (destination) => ({
      airlineIata: 'XD',
      destination,
      weight: destination === 'JFQ' || destination === 'LMW' || destination === 'IVQ' ? 7 : 4,
      fleet: ['AT76', 'A20N', 'A21N'],
    }),
  ),
  ...['SMG', 'SCJ', 'BVQ', 'KST'].map((destination) => ({
    airlineIata: 'XD',
    destination,
    weight: 4,
    fleet: ['A21N'],
  })),
  // Aurora National: domestic full-service plus some long-haul
  ...['OKZ', 'JFQ', 'GRH', 'DMQ', 'GSZ', 'ADN', 'EHQ', 'IVQ', 'CBP', 'FHQ', 'BWZ'].map((destination) => ({
    airlineIata: 'YA',
    destination,
    weight: destination === 'OKZ' ? 3 : 2,
    fleet: ['A20N'],
  })),
  ...['BVQ', 'KST'].map((destination) => ({
    airlineIata: 'YA',
    destination,
    weight: 2,
    fleet: ['A359', 'B788'],
  })),
  // domestic low-cost
  ...['LMW', 'GRH', 'NGV', 'OKZ', 'JFQ', 'FHQ', 'ADN', 'HCX', 'CBP', 'GSZ', 'DMQ'].map((destination) => ({
    airlineIata: 'YN',
    destination,
    weight: 2,
    fleet: ['B38M'],
  })),
  ...['IVQ', 'NGV', 'ADN', 'OKZ', 'FHQ', 'GRH', 'JFQ', 'CPZ'].map((destination) => ({
    airlineIata: 'XU',
    destination,
    weight: 2,
    fleet: ['B38M'],
  })),
  ...['DMQ', 'GRH', 'LMW', 'BWZ', 'GSZ'].map((destination) => ({
    airlineIata: 'YF',
    destination,
    weight: 2,
    fleet: ['B738'],
  })),
  // international full-service
  { airlineIata: 'ZO', destination: 'KST', weight: 8, fleet: ['A388', 'B77W'] },
  { airlineIata: 'XH', destination: 'ZHQ', weight: 6, fleet: ['A359', 'B77W'] },
  { airlineIata: 'YG', destination: 'NVQ', weight: 4, fleet: ['B748'] },
  { airlineIata: 'XI', destination: 'PVQ', weight: 4, fleet: ['B789'] },
  { airlineIata: 'YU', destination: 'SCJ', weight: 3, fleet: ['A359'] },
  { airlineIata: 'YB', destination: 'BVQ', weight: 2, fleet: ['B77W'] },
];

/** Codeshare partners (marketing carriers), as in the sample. */
export const CODESHARES: ReadonlyMap<string, readonly string[]> = new Map([
  ['XD', ['XH']],
  ['XH', ['YB']],
  ['YA', ['YG']],
]);

export function airlineByIata(iata: string): Airline | undefined {
  return AIRLINES.find((a) => a.iata === iata);
}

export function destinationByIata(iata: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.iata === iata);
}

export function aircraftTypeByIcao(icao: string): AircraftType | undefined {
  return AIRCRAFT_TYPES.find((t) => t.icao === icao);
}
