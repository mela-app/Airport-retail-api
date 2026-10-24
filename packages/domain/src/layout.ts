/**
 * The stylised floor plan of Meridian International (MQI): two terminals, their piers, commercial zones,
 * gates, checkpoints and passenger queues. Units are metres on a 1600 × 900 plan; y grows downwards
 * (airside piers at the top, landside halls at the bottom).
 *
 * T1 mainly handles domestic flights (piers A, B, C). T2 handles all international and some domestic
 * flights (piers D 41–56, E 57–72, F 73–88). Each terminal also has a remote bus-gate lounge (BUS1–BUS8).
 */
import { gateId } from './flight.js';
import type { Checkpoint, Concourse, Gate, PassengerQueue, Rect, Terminal, Zone, ZoneKind } from './space.js';

export const PLAN_SIZE = { width: 1600, height: 900 } as const;

interface PierSpec {
  terminalId: 'T1' | 'T2';
  concourseId: string;
  name: string;
  area: Rect;
  gateCodes: string[];
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const PIERS: readonly PierSpec[] = [
  {
    terminalId: 'T1',
    concourseId: 'T1-A',
    name: 'Pier A',
    area: { x: 60, y: 110, width: 150, height: 440 },
    gateCodes: range(1, 10).map((n) => `A${n}`),
  },
  {
    terminalId: 'T1',
    concourseId: 'T1-B',
    name: 'Pier B',
    area: { x: 295, y: 110, width: 150, height: 440 },
    gateCodes: range(1, 12).map((n) => `B${n}`),
  },
  {
    terminalId: 'T1',
    concourseId: 'T1-C',
    name: 'Pier C',
    area: { x: 530, y: 110, width: 150, height: 440 },
    gateCodes: range(1, 12).map((n) => `C${n}`),
  },
  {
    terminalId: 'T2',
    concourseId: 'T2-D',
    name: 'Pier D',
    area: { x: 780, y: 90, width: 160, height: 450 },
    gateCodes: range(41, 56).map(String),
  },
  {
    terminalId: 'T2',
    concourseId: 'T2-E',
    name: 'Pier E',
    area: { x: 1080, y: 90, width: 160, height: 450 },
    gateCodes: range(57, 72).map(String),
  },
  {
    terminalId: 'T2',
    concourseId: 'T2-F',
    name: 'Pier F',
    area: { x: 1380, y: 90, width: 160, height: 450 },
    gateCodes: range(73, 88).map(String),
  },
];

interface ZoneSpec {
  id: string;
  terminalId: 'T1' | 'T2';
  concourseId: string | null;
  name: string;
  kind: ZoneKind;
  side: 'landside' | 'airside';
  area: Rect;
}

const NON_PIER_ZONES: readonly ZoneSpec[] = [
  {
    id: 'T1-LS',
    terminalId: 'T1',
    concourseId: null,
    name: 'T1 Check-in Hall',
    kind: 'landside_hall',
    side: 'landside',
    area: { x: 220, y: 770, width: 300, height: 90 },
  },
  {
    id: 'T1-SEC',
    terminalId: 'T1',
    concourseId: null,
    name: 'T1 Security',
    kind: 'security',
    side: 'landside',
    area: { x: 300, y: 705, width: 140, height: 60 },
  },
  {
    id: 'T1-PLZ',
    terminalId: 'T1',
    concourseId: null,
    name: 'T1 Market Hall',
    kind: 'airside_plaza',
    side: 'airside',
    area: { x: 60, y: 560, width: 620, height: 140 },
  },
  {
    id: 'T1-BUS',
    terminalId: 'T1',
    concourseId: null,
    name: 'T1 Bus Gates',
    kind: 'bus_lounge',
    side: 'airside',
    area: { x: 60, y: 705, width: 150, height: 70 },
  },
  {
    id: 'T1-ARR',
    terminalId: 'T1',
    concourseId: null,
    name: 'T1 Arrivals Hall',
    kind: 'arrivals_hall',
    side: 'landside',
    area: { x: 540, y: 705, width: 140, height: 155 },
  },
  {
    id: 'T2-LS',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Check-in Hall',
    kind: 'landside_hall',
    side: 'landside',
    area: { x: 960, y: 795, width: 400, height: 75 },
  },
  {
    id: 'T2-SEC',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Security',
    kind: 'security',
    side: 'landside',
    area: { x: 1060, y: 745, width: 200, height: 45 },
  },
  {
    id: 'T2-PPC',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Passport Control',
    kind: 'passport_control',
    side: 'airside',
    area: { x: 1060, y: 700, width: 200, height: 42 },
  },
  {
    id: 'T2-PLZ',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Duty Free Plaza',
    kind: 'airside_plaza',
    side: 'airside',
    area: { x: 945, y: 545, width: 430, height: 150 },
  },
  {
    id: 'T2-BUS',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Bus Gates',
    kind: 'bus_lounge',
    side: 'airside',
    area: { x: 780, y: 550, width: 160, height: 110 },
  },
  {
    id: 'T2-ARR',
    terminalId: 'T2',
    concourseId: null,
    name: 'T2 Arrivals Hall',
    kind: 'arrivals_hall',
    side: 'landside',
    area: { x: 1380, y: 550, width: 160, height: 310 },
  },
];

export const TERMINALS: readonly Terminal[] = [
  {
    id: 'T1',
    name: 'Terminal 1',
    mainMarket: 'domestic',
    outline: { x: 40, y: 80, width: 660, height: 800 },
  },
  {
    id: 'T2',
    name: 'Terminal 2',
    mainMarket: 'international',
    outline: { x: 760, y: 60, width: 800, height: 820 },
  },
];

export const CONCOURSES: readonly Concourse[] = PIERS.map((p) => ({
  id: p.concourseId,
  terminalId: p.terminalId,
  name: p.name,
}));

export const ZONES: readonly Zone[] = [
  ...PIERS.map((p): Zone => ({
    id: p.concourseId,
    terminalId: p.terminalId,
    concourseId: p.concourseId,
    name: `${p.terminalId} ${p.name}`,
    kind: 'pier',
    side: 'airside',
    area: p.area,
  })),
  ...NON_PIER_ZONES,
];

/** Pier gates alternate left and right sides, numbered from the plaza end (nearest first). */
function pierGates(p: PierSpec): Gate[] {
  const perSide = Math.ceil(p.gateCodes.length / 2);
  const step = (p.area.height - 40) / Math.max(1, perSide - 1);
  return p.gateCodes.map((code, i) => {
    const row = Math.floor(i / 2);
    const left = i % 2 === 0;
    return {
      id: gateId(p.terminalId, code),
      code,
      terminalId: p.terminalId,
      concourseId: p.concourseId,
      zoneId: p.concourseId,
      remote: false,
      position: {
        x: left ? p.area.x + 18 : p.area.x + p.area.width - 18,
        y: p.area.y + p.area.height - 20 - row * step,
      },
    };
  });
}

function busGates(terminalId: 'T1' | 'T2', zone: ZoneSpec): Gate[] {
  return range(1, 8).map((n, i) => ({
    id: gateId(terminalId, `BUS${n}`),
    code: `BUS${n}`,
    terminalId,
    concourseId: null,
    zoneId: zone.id,
    remote: true,
    position: {
      x: zone.area.x + 15 + (i % 4) * ((zone.area.width - 30) / 3),
      y: zone.area.y + (i < 4 ? 18 : zone.area.height - 18),
    },
  }));
}

function zoneSpec(id: string): ZoneSpec {
  const zone = NON_PIER_ZONES.find((z) => z.id === id);
  if (!zone) throw new Error(`unknown zone ${id}`);
  return zone;
}

export const GATES: readonly Gate[] = [
  ...PIERS.flatMap(pierGates),
  ...busGates('T1', zoneSpec('T1-BUS')),
  ...busGates('T2', zoneSpec('T2-BUS')),
];

export const CHECKPOINTS: readonly Checkpoint[] = [
  {
    id: 'T1-SEC-CP',
    terminalId: 'T1',
    zoneId: 'T1-SEC',
    name: 'T1 Central Security',
    kind: 'security',
    lanes: 12,
    position: { x: 370, y: 735 },
  },
  // `lanes` is the installed maximum; the mock sensor feed staffs lanes to forecast demand (peak demand on a
  // generated day is ≈ 5,200 pax/h at T2 security, 2,500 at passport control, 1,250 at T1 security).
  {
    id: 'T2-SEC-CP',
    terminalId: 'T2',
    zoneId: 'T2-SEC',
    name: 'T2 Central Security',
    kind: 'security',
    lanes: 40,
    position: { x: 1160, y: 767 },
  },
  {
    id: 'T2-PPC-CP',
    terminalId: 'T2',
    zoneId: 'T2-PPC',
    name: 'T2 Departures Passport Control',
    kind: 'passport_control',
    lanes: 18,
    position: { x: 1160, y: 721 },
  },
];

export const PASSENGER_QUEUES: readonly PassengerQueue[] = CHECKPOINTS.flatMap((cp) => [
  { id: `${cp.id}-STD`, checkpointId: cp.id, name: `${cp.name} – standard`, queueType: 'standard' as const },
  { id: `${cp.id}-PRI`, checkpointId: cp.id, name: `${cp.name} – priority`, queueType: 'priority' as const },
]);

const GATE_BY_ID: ReadonlyMap<string, Gate> = new Map(GATES.map((g) => [g.id, g]));
const ZONE_BY_ID: ReadonlyMap<string, Zone> = new Map(ZONES.map((z) => [z.id, z]));

export function gateById(id: string): Gate | undefined {
  return GATE_BY_ID.get(id);
}

export function zoneById(id: string): Zone | undefined {
  return ZONE_BY_ID.get(id);
}

/** Resolve an AODB (terminal, gate code) pair to a canonical gate, if the layout has it. */
export function resolveGate(terminal: string, code: string | null): Gate | undefined {
  return code ? GATE_BY_ID.get(gateId(terminal, code)) : undefined;
}

/** The airside plaza a terminal's departing passengers pass through before going to their gate. */
export function plazaZoneId(terminalId: string): string {
  return `${terminalId}-PLZ`;
}
