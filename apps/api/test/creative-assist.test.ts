import { describe, expect, it } from 'vitest';

import { safetyChecks, contrast } from '../src/creative-assist/assistant.js';
import { categoryFor, findOffer } from '../src/creative-assist/phrasebook.js';

const variant = (en: string) => ({
  name: 'x',
  template: 'offer_split' as const,
  artwork: 'perfume' as const,
  palette: { background: '#1B2A4A', foreground: '#FFFFFF', accent: '#F2B134' },
  content: {
    en: { headline: en, body: 'Short body', cta: 'Scan', badge: null },
    ar: { headline: 'عنوان', body: 'نص', cta: 'امسح', badge: null },
  },
  rationale: '',
});

describe('creative assistant', () => {
  it('reads offers from a brief without regular expressions', () => {
    expect(findOffer('15% off perfume')?.badgeEn).toBe('15% OFF');
    expect(findOffer('خصم ١٥٪ على العطور')?.en).toBe('15% off');
    expect(findOffer('Buy 2 for 1 coffee')?.badgeEn).toBe('2 FOR 1');
    expect(findOffer('new collection')).toBeNull();
  });

  it('picks the category from the brief first, then the advertiser', () => {
    expect(categoryFor('flat white for commuters', 'Duty free')).toBe('coffee');
    expect(categoryFor('our new season', 'Toys')).toBe('toys');
  });

  it('flags real brands, unverifiable claims and poor contrast', () => {
    expect(safetyChecks(variant('Fresh scent')).every((c) => c.passed)).toBe(true);
    const bad = safetyChecks(variant('The best Chanel deal'));
    expect(bad.find((c) => c.name === 'no_real_brand_marks')?.passed).toBe(false);
    expect(bad.find((c) => c.name === 'claims_verifiable')?.passed).toBe(false);
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
  });
});
