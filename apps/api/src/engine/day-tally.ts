/**
 * Today's delivery and outcomes, for the network and per campaign: plays, estimated viewers, media cost,
 * QR scans, redemptions and attributed sales. Updated as slots are delivered, so dashboards tick live.
 */

export interface DayTotals {
  plays: number;
  viewers: number;
  cost: number;
  scans: number;
  redemptions: number;
  revenue: number;
}

const empty = (): DayTotals => ({ plays: 0, viewers: 0, cost: 0, scans: 0, redemptions: 0, revenue: 0 });

export class DayTally {
  private total = empty();
  private readonly campaigns = new Map<string, DayTotals>();

  reset(): void {
    this.total = empty();
    this.campaigns.clear();
  }

  private of(campaignId: string): DayTotals {
    let c = this.campaigns.get(campaignId);
    if (!c) {
      c = empty();
      this.campaigns.set(campaignId, c);
    }
    return c;
  }

  /** Add recorded totals (start-up, from the database). */
  add(campaignId: string, values: Partial<DayTotals>): void {
    for (const target of [this.total, this.of(campaignId)]) {
      target.plays += values.plays ?? 0;
      target.viewers += values.viewers ?? 0;
      target.cost += values.cost ?? 0;
      target.scans += values.scans ?? 0;
      target.redemptions += values.redemptions ?? 0;
      target.revenue += values.revenue ?? 0;
    }
  }

  play(campaignId: string, viewers: number, cost: number): void {
    this.add(campaignId, { plays: 1, viewers, cost });
  }

  scans(campaignId: string, n: number): void {
    if (n > 0) this.add(campaignId, { scans: n });
  }

  redemption(campaignId: string, revenue: number): void {
    this.add(campaignId, { redemptions: 1, revenue });
  }

  network(): DayTotals {
    return { ...this.total };
  }

  campaign(campaignId: string): DayTotals {
    return { ...(this.campaigns.get(campaignId) ?? empty()) };
  }
}
