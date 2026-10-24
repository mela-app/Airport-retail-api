/**
 * The airport layout in use: terminals, zones and gates as stored in the database (managed through the
 * master-data API). The presence model, the decision engine, the injectors and the API read the layout from
 * here, so an edit (a new gate, a renamed zone, a gate taken out of service) takes effect immediately.
 *
 * `Layout.default()` is the seeded floor plan (used by tests and before the database is loaded).
 */
import { GATES, TERMINALS, ZONES, type Gate, type Terminal, type Zone, gateId } from '@arm/domain';

export interface LayoutGate extends Gate {
  /** False when the gate is out of service (no gate changes to it; it keeps showing on the map). */
  active: boolean;
}

export class Layout {
  private readonly gateById: ReadonlyMap<string, LayoutGate>;
  private readonly zoneById: ReadonlyMap<string, Zone>;

  constructor(
    readonly terminals: readonly Terminal[],
    readonly zones: readonly Zone[],
    readonly gates: readonly LayoutGate[],
  ) {
    this.gateById = new Map(gates.map((g) => [g.id, g]));
    this.zoneById = new Map(zones.map((z) => [z.id, z]));
  }

  static default(): Layout {
    return new Layout(
      TERMINALS,
      ZONES,
      GATES.map((g) => ({ ...g, active: true })),
    );
  }

  gate(id: string): LayoutGate | undefined {
    return this.gateById.get(id);
  }

  /** Resolve an AODB (terminal, gate code) pair. */
  gateOf(terminal: string, code: string | null): LayoutGate | undefined {
    return code ? this.gateById.get(gateId(terminal, code)) : undefined;
  }

  zone(id: string): Zone | undefined {
    return this.zoneById.get(id);
  }
}
