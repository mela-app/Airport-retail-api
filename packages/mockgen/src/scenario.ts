/**
 * The challenge's worked example, re-labelled to the fictional airport:
 *
 *   Gate 42 at 14:10. The crowd is flight XH501 to Zarhan (ZHQ, a Gulf hub; the example's "DXB") with 240 pax,
 *   delayed 45 min, plus flight XU88 to the beach destination Coralport (CPZ) with 180 pax.
 *   Profile: holiday 58%, family 31%, business 22%, international 57%, median dwell 52 min.
 *
 * Both flights get pinned crowd profiles so the roll-up reproduces those shares exactly, and the gates next to
 * them stay free in the generated schedule so no other flight joins the crowd.
 */
import type { CrowdProfile } from '@arm/domain';

export interface ScenarioFlight {
  airlineIata: string;
  flightNumber: string;
  destination: string;
  aircraftTypeIcao: string;
  gateId: string;
  /** Local scheduled departure time. */
  localStd: { hour: number; minute: number };
  pax: number;
  delayMinutes: number;
  delayCode: string;
  /** When the delay is published (minutes before STD). */
  delayKnownMinutesBeforeStd: number;
  profile: CrowdProfile;
}

const XH501_PROFILE: CrowdProfile = {
  pax: 240,
  segments: {
    tripPurpose: { business: 0.3475, holiday: 0.415, vfr: 0.2, student: 0.0275, religious: 0.01 },
    partyType: { solo: 0.33, couple: 0.3125, family: 0.2275, group: 0.13 },
    ageBand: { u12: 0.08, a12_17: 0.05, a18_24: 0.08, a25_34: 0.25, a35_44: 0.25, a45_54: 0.17, a55p: 0.12 },
    gender: { female: 0.47, male: 0.53 },
    cabin: { economy: 0.9, premium_economy: 0, business: 0.1 },
    market: { domestic: 0, international: 1 },
  },
  frequentFlyerShare: 0.3,
  topNationalities: [
    { code: 'MER', label: 'Meridian', share: 0.48 },
    { code: 'ZHQ', label: 'Zarhani', share: 0.42 },
    { code: 'KST', label: 'Kastellian', share: 0.1 },
  ],
  topLanguages: [
    { code: 'en', label: 'English', share: 0.48 },
    { code: 'ar', label: 'Arabic', share: 0.42 },
    { code: 'de', label: 'German', share: 0.1 },
  ],
  topDestinations: [{ code: 'ZHQ', label: 'Zarhan', share: 1 }],
};

const XU88_PROFILE: CrowdProfile = {
  pax: 180,
  segments: {
    tripPurpose: { business: 0.05, holiday: 0.8, vfr: 0.12, student: 0.02, religious: 0.01 },
    partyType: { solo: 0.08, couple: 0.3, family: 0.42, group: 0.2 },
    ageBand: { u12: 0.16, a12_17: 0.08, a18_24: 0.1, a25_34: 0.2, a35_44: 0.22, a45_54: 0.14, a55p: 0.1 },
    gender: { female: 0.52, male: 0.48 },
    cabin: { economy: 1, premium_economy: 0, business: 0 },
    market: { domestic: 1, international: 0 },
  },
  frequentFlyerShare: 0.06,
  topNationalities: [
    { code: 'MER', label: 'Meridian', share: 0.92 },
    { code: 'ZHQ', label: 'Zarhani', share: 0.05 },
    { code: 'BVQ', label: 'Belvistan', share: 0.03 },
  ],
  topLanguages: [
    { code: 'en', label: 'English', share: 0.92 },
    { code: 'ar', label: 'Arabic', share: 0.05 },
    { code: 'it', label: 'Italian', share: 0.03 },
  ],
  topDestinations: [{ code: 'CPZ', label: 'Coralport', share: 1 }],
};

export const WORKED_EXAMPLE = {
  /** Local time of the example. */
  localTime: { hour: 14, minute: 10 },
  screenGateId: 'T2-42',
  flights: [
    {
      airlineIata: 'XH',
      flightNumber: '501',
      destination: 'ZHQ',
      aircraftTypeIcao: 'A359',
      gateId: 'T2-42',
      // STD 14:57 + 45 min delay = ETD 15:42; boarding (40 min before) at 15:02 → 52 min dwell at 14:10.
      localStd: { hour: 14, minute: 57 },
      pax: 240,
      delayMinutes: 45,
      delayCode: '93',
      delayKnownMinutesBeforeStd: 60,
      profile: XH501_PROFILE,
    },
    {
      airlineIata: 'XU',
      flightNumber: '88',
      destination: 'CPZ',
      aircraftTypeIcao: 'B38M',
      gateId: 'T2-43',
      // STD 15:10; boarding (30 min before) at 14:40 → 30 min dwell at 14:10.
      localStd: { hour: 15, minute: 10 },
      pax: 180,
      delayMinutes: 0,
      delayCode: '',
      delayKnownMinutesBeforeStd: 0,
      profile: XU88_PROFILE,
    },
  ] satisfies ScenarioFlight[],
  /** Neighbouring gates kept free so only the two example flights form the crowd. */
  keepFreeGateIds: ['T2-41', 'T2-44', 'T2-45', 'T2-46'],
} as const;
