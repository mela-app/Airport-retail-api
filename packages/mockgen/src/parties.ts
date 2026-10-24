/**
 * Fictional advertisers and their outlets. Every name is invented for the demo; none is a real brand.
 * The persona switcher uses the "persona" entries: a duty-free store, a coffee chain, a low-cost airline and a
 * full-service airline.
 */
import { AIRLINES, type Advertiser, type AdvertiserKind, type Outlet } from '@arm/domain';

interface AdvertiserSpec {
  id: string;
  name: string;
  kind: AdvertiserKind;
  category: string;
  competitorGroup: string | null;
  brandColor: string;
  contactName: string;
}

const RETAIL: readonly AdvertiserSpec[] = [
  {
    id: 'adv-aurelia',
    name: 'Aurelia Duty Free',
    kind: 'retailer',
    category: 'Duty free',
    competitorGroup: null,
    brandColor: '#7A3E9D',
    contactName: 'Nadia Corral',
  },
  {
    id: 'adv-brewline',
    name: 'Brewline Coffee',
    kind: 'fnb',
    category: 'Coffee',
    competitorGroup: 'coffee',
    brandColor: '#6F4E37',
    contactName: 'Tomas Reyler',
  },
  {
    id: 'adv-kite',
    name: 'Kite & Kin Toys',
    kind: 'retailer',
    category: 'Toys',
    competitorGroup: null,
    brandColor: '#E94F37',
    contactName: 'Priya Okafor',
  },
  {
    id: 'adv-saffron',
    name: 'Saffron & Sugar',
    kind: 'fnb',
    category: 'Sweets',
    competitorGroup: null,
    brandColor: '#E8A33D',
    contactName: 'Leila Amrani',
  },
  {
    id: 'adv-voltline',
    name: 'Voltline Electronics',
    kind: 'retailer',
    category: 'Electronics',
    competitorGroup: null,
    brandColor: '#2D9CDB',
    contactName: 'Jonas Whitfield',
  },
  {
    id: 'adv-pagewise',
    name: 'Pagewise Books',
    kind: 'retailer',
    category: 'Books',
    competitorGroup: null,
    brandColor: '#3D5A80',
    contactName: 'Clara Benn',
  },
  {
    id: 'adv-linenlark',
    name: 'Linen & Lark',
    kind: 'retailer',
    category: 'Fashion',
    competitorGroup: null,
    brandColor: '#A26769',
    contactName: 'Eva Marlowe',
  },
  {
    id: 'adv-ember',
    name: 'Ember Grill',
    kind: 'fnb',
    category: 'Dining',
    competitorGroup: 'dining',
    brandColor: '#C0392B',
    contactName: 'Marco Lindqvist',
  },
  {
    id: 'adv-noodle',
    name: 'Noodle Harbour',
    kind: 'fnb',
    category: 'Dining',
    competitorGroup: 'dining',
    brandColor: '#D35400',
    contactName: 'Mei Tanaro',
  },
  {
    id: 'adv-gatehouse',
    name: 'Gatehouse Burgers',
    kind: 'fnb',
    category: 'Quick service',
    competitorGroup: 'dining',
    brandColor: '#D4A017',
    contactName: 'Sam Odell',
  },
  {
    id: 'adv-carewing',
    name: 'CareWing Pharmacy',
    kind: 'retailer',
    category: 'Pharmacy',
    competitorGroup: null,
    brandColor: '#27AE60',
    contactName: 'Ruth Abara',
  },
  {
    id: 'adv-horizon',
    name: 'Horizon Lounges',
    kind: 'service',
    category: 'Lounges',
    competitorGroup: null,
    brandColor: '#138D75',
    contactName: 'Victor Hale',
  },
  {
    id: 'adv-globe',
    name: 'Globe Exchange',
    kind: 'service',
    category: 'Currency exchange',
    competitorGroup: null,
    brandColor: '#34495E',
    contactName: 'Ines Duval',
  },
  {
    id: 'adv-rentaro',
    name: 'Rentaro Car Hire',
    kind: 'service',
    category: 'Car hire',
    competitorGroup: null,
    brandColor: '#E67E22',
    contactName: 'Oskar Brandt',
  },
  {
    id: 'adv-solenne',
    name: 'Maison Solenne',
    kind: 'brand',
    category: 'Perfume',
    competitorGroup: 'perfume',
    brandColor: '#B48EAD',
    contactName: 'Hélène Vasser',
  },
  {
    id: 'adv-velour',
    name: 'Velour Parfums',
    kind: 'brand',
    category: 'Perfume',
    competitorGroup: 'perfume',
    brandColor: '#8E44AD',
    contactName: 'Dario Fenn',
  },
  {
    id: 'adv-roamly',
    name: 'Roamly eSIM',
    kind: 'brand',
    category: 'Mobile data',
    competitorGroup: null,
    brandColor: '#16A085',
    contactName: 'Aiko Brennan',
  },
  {
    id: 'adv-northbank',
    name: 'Northbank Card',
    kind: 'brand',
    category: 'Payments',
    competitorGroup: null,
    brandColor: '#0B3954',
    contactName: 'Hugo Pemberton',
  },
];

/** Persona companies for the role switcher. */
export const PERSONAS = {
  retailers: ['adv-aurelia', 'adv-brewline', 'adv-kite', 'adv-saffron'],
  airlines: ['adv-air-XD', 'adv-air-XH', 'adv-air-YA', 'adv-air-ZO'],
} as const;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');

export function buildAdvertisers(onboardedAt: string): Advertiser[] {
  const retail = RETAIL.map((a): Advertiser => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    category: a.category,
    competitorGroup: a.competitorGroup,
    airlineIata: null,
    contactName: a.contactName,
    contactEmail: `${slug(a.contactName)}@${slug(a.name)}.example`,
    brandColor: a.brandColor,
    onboardedAt,
  }));
  const airlines = AIRLINES.map((al): Advertiser => ({
    id: `adv-air-${al.iata}`,
    name: al.name,
    kind: 'airline',
    category: al.model === 'low_cost' ? 'Low-cost airline' : 'Full-service airline',
    competitorGroup: null,
    airlineIata: al.iata,
    contactName: 'Station Marketing',
    contactEmail: `marketing.mqi@${slug(al.name)}.example`,
    brandColor: al.brandColor,
    onboardedAt,
  }));
  return [...retail, ...airlines];
}

type OutletCategory = Outlet['category'];

/** [advertiser, outlet name, category, zone, average basket]. 40 outlets. */
const OUTLETS: readonly (readonly [string, string, OutletCategory, string, number])[] = [
  // T2 duty-free plaza
  ['adv-aurelia', 'Aurelia Duty Free – Main Store', 'duty_free', 'T2-PLZ', 96],
  ['adv-aurelia', 'Aurelia Beauty & Fragrance', 'perfume_cosmetics', 'T2-PLZ', 88],
  ['adv-aurelia', 'Aurelia Gulf Boutique', 'duty_free', 'T2-PLZ', 140],
  ['adv-brewline', 'Brewline Coffee – T2 Plaza', 'fnb_coffee', 'T2-PLZ', 9],
  ['adv-kite', 'Kite & Kin Toys – T2', 'toys', 'T2-PLZ', 34],
  ['adv-saffron', 'Saffron & Sugar – T2', 'fnb_sweets', 'T2-PLZ', 18],
  ['adv-voltline', 'Voltline Electronics – T2', 'electronics', 'T2-PLZ', 72],
  ['adv-pagewise', 'Pagewise Books – T2', 'books', 'T2-PLZ', 21],
  ['adv-linenlark', 'Linen & Lark – T2', 'fashion', 'T2-PLZ', 64],
  ['adv-ember', 'Ember Grill – T2', 'fnb_dining', 'T2-PLZ', 31],
  ['adv-noodle', 'Noodle Harbour – T2', 'fnb_dining', 'T2-PLZ', 24],
  ['adv-carewing', 'CareWing Pharmacy – T2', 'pharmacy', 'T2-PLZ', 15],
  ['adv-globe', 'Globe Exchange – T2 Airside', 'services', 'T2-PLZ', 12],
  // T2 piers and landside
  ['adv-brewline', 'Brewline Coffee – Pier D', 'fnb_coffee', 'T2-D', 9],
  ['adv-brewline', 'Brewline Coffee – Pier F', 'fnb_coffee', 'T2-F', 9],
  ['adv-horizon', 'Horizon Lounge – T2 Pier D', 'lounge', 'T2-D', 45],
  ['adv-aurelia', 'Aurelia Walk-through – Pier E', 'duty_free', 'T2-E', 58],
  ['adv-gatehouse', 'Gatehouse Burgers – Pier E', 'fnb_dining', 'T2-E', 14],
  ['adv-saffron', 'Saffron & Sugar – Pier F', 'fnb_sweets', 'T2-F', 16],
  ['adv-brewline', 'Brewline Coffee – T2 Check-in', 'fnb_coffee', 'T2-LS', 8],
  ['adv-globe', 'Globe Exchange – T2 Check-in', 'services', 'T2-LS', 12],
  ['adv-rentaro', 'Rentaro Car Hire – T2 Arrivals', 'services', 'T2-ARR', 120],
  ['adv-brewline', 'Brewline Coffee – T2 Arrivals', 'fnb_coffee', 'T2-ARR', 8],
  // T1 market hall
  ['adv-aurelia', 'Aurelia Duty Free – T1 Market', 'duty_free', 'T1-PLZ', 52],
  ['adv-brewline', 'Brewline Coffee – T1 Market', 'fnb_coffee', 'T1-PLZ', 8],
  ['adv-kite', 'Kite & Kin Toys – T1', 'toys', 'T1-PLZ', 29],
  ['adv-saffron', 'Saffron & Sugar – T1', 'fnb_sweets', 'T1-PLZ', 15],
  ['adv-voltline', 'Voltline Express – T1', 'electronics', 'T1-PLZ', 48],
  ['adv-pagewise', 'Pagewise Books – T1', 'books', 'T1-PLZ', 18],
  ['adv-ember', 'Ember Grill – T1', 'fnb_dining', 'T1-PLZ', 27],
  ['adv-gatehouse', 'Gatehouse Burgers – T1', 'fnb_dining', 'T1-PLZ', 12],
  ['adv-carewing', 'CareWing Pharmacy – T1', 'pharmacy', 'T1-PLZ', 13],
  ['adv-linenlark', 'Linen & Lark – T1', 'fashion', 'T1-PLZ', 55],
  // T1 piers, landside and arrivals
  ['adv-brewline', 'Brewline Coffee – Pier B', 'fnb_coffee', 'T1-B', 8],
  ['adv-noodle', 'Noodle Harbour – Pier C', 'fnb_dining', 'T1-C', 20],
  ['adv-horizon', 'Horizon Lounge – T1', 'lounge', 'T1-A', 38],
  ['adv-gatehouse', 'Gatehouse Burgers – Bus Gates', 'fnb_dining', 'T1-BUS', 11],
  ['adv-brewline', 'Brewline Coffee – T1 Check-in', 'fnb_coffee', 'T1-LS', 8],
  ['adv-rentaro', 'Rentaro Car Hire – T1 Arrivals', 'services', 'T1-ARR', 95],
  ['adv-carewing', 'CareWing Express – T1 Arrivals', 'pharmacy', 'T1-ARR', 10],
];

export interface OutletSeed {
  advertiserId: string;
  name: string;
  category: OutletCategory;
  zoneId: string;
  averageBasket: number;
}

export const OUTLET_SEEDS: readonly OutletSeed[] = OUTLETS.map(
  ([advertiserId, name, category, zoneId, averageBasket]) => ({
    advertiserId,
    name,
    category,
    zoneId,
    averageBasket,
  }),
);
