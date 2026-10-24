/**
 * Audience-profile feed → canonical `CrowdProfile` per flight.
 *
 * Format: a JSON object mapping canonical flight ids to aggregated profiles (the mock stands in for airline
 * aggregated booking mix, PNR statistics and APIS aggregates). Profiles describe shares of a flight's
 * passengers, never individuals; anything that does not validate is rejected.
 */
import { type CrowdProfile, CrowdProfileSchema } from '@arm/domain';

export interface AudienceParseResult {
  profiles: Map<string, CrowdProfile>;
  errors: { flightId: string; reason: string }[];
}

export function parseAudienceProfiles(text: string): AudienceParseResult {
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('audience profile feed must be an object keyed by flight id');
  }
  const profiles = new Map<string, CrowdProfile>();
  const errors: AudienceParseResult['errors'] = [];
  for (const [flightId, raw] of Object.entries(data)) {
    const parsed = CrowdProfileSchema.safeParse(raw);
    if (parsed.success) profiles.set(flightId, parsed.data);
    else
      errors.push({
        flightId,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
  }
  return { profiles, errors };
}
