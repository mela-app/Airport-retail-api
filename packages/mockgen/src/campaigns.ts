/**
 * The 25 demo campaigns and their creatives (English + Arabic, the default second language).
 *
 * c01–c03 are the challenge's worked example (perfume, toys, lounge). Their segment weights and performance
 * indexes are tuned so the decision engine reproduces the example's scores at Gate 42 / 14:10.
 */
import type { Campaign, Creative, CreativeContent, SegmentWeights, Trigger } from '@arm/domain';

type Bilingual = { en: CreativeContent; ar: CreativeContent };

interface CampaignSpec {
  id: string;
  advertiserId: string;
  name: string;
  objective: Campaign['objective'];
  status: Campaign['status'];
  /** Days relative to the simulation date: [start, end]. */
  days: [number, number];
  weights: SegmentWeights;
  market?: 'domestic' | 'international';
  regions?: string[];
  destinations?: string[];
  minDwell?: number;
  minCrowd?: number;
  zones: string[];
  hours?: { from: number; to: number };
  budget: { total: number; dailyCap: number; cpm: number; cap: number };
  triggers?: Trigger[];
  promo?: Campaign['promo'];
  airlinePriority?: boolean;
  coFundedBy?: string;
  performance: number;
  competitorGroup?: string;
  creative: {
    template: Creative['template'];
    artwork: string;
    palette: Creative['palette'];
    content: Bilingual;
  };
  variantB?: Bilingual;
}

const T2_AIRSIDE = ['T2-PLZ', 'T2-D', 'T2-E', 'T2-F'];
const T2_PIERS = ['T2-D', 'T2-E', 'T2-F', 'T2-BUS'];
const T1_AIRSIDE = ['T1-PLZ', 'T1-A', 'T1-B', 'T1-C', 'T1-BUS'];
const ALL_AIRSIDE = [...T1_AIRSIDE, ...T2_AIRSIDE, 'T2-BUS'];

const AGE_25_54: SegmentWeights = {
  'ageBand.u12': 0.3,
  'ageBand.a12_17': 0.3,
  'ageBand.a18_24': 0.3,
  'ageBand.a25_34': 1,
  'ageBand.a35_44': 1,
  'ageBand.a45_54': 1,
  'ageBand.a55p': 0.3,
};

const promo = (
  codePrefix: string,
  offerText: string,
  outletId: string | null,
  validity: NonNullable<Campaign['promo']>['validity'] = { mode: 'boarding_close' },
  shareable = true,
): Campaign['promo'] => ({ offerText, codePrefix, validity, shareable, outletId, inStock: true });

const c = (headline: string, body: string, cta: string, badge: string | null = null): CreativeContent => ({
  headline,
  body,
  cta,
  badge,
});

export const CAMPAIGN_SPECS: readonly CampaignSpec[] = [
  {
    id: 'c01',
    advertiserId: 'adv-aurelia',
    name: 'Perfume Week – 15% off fragrances',
    objective: 'conversion',
    status: 'active',
    days: [-12, 16],
    weights: {
      'tripPurpose.holiday': 1,
      'tripPurpose.business': 0.6,
      'tripPurpose.vfr': 0.6,
      'market.international': 1,
      ...AGE_25_54,
    },
    minDwell: 15,
    zones: T2_AIRSIDE,
    budget: { total: 252000, dailyCap: 10800, cpm: 14, cap: 60 },
    triggers: [{ type: 'delay_over', minutes: 30, airlineIata: null, destinations: [], boost: 1.5 }],
    promo: promo('PERF15', '15% off all fragrances', 'out-02'),
    performance: 0.3,
    competitorGroup: 'perfume',
    creative: {
      template: 'offer_split',
      artwork: 'perfume',
      palette: { background: '#2B1B3D', foreground: '#FFFFFF', accent: '#E8C468' },
      content: {
        en: c(
          'Your signature scent, 15% off',
          'Discover the season’s finest fragrances at Aurelia Beauty & Fragrance, Duty Free Plaza.',
          'Scan to claim',
          '15% OFF',
        ),
        ar: c(
          'عطرك المميز بخصم 15٪',
          'اكتشف أرقى عطور الموسم في أوريليا للجمال والعطور، ساحة السوق الحرة.',
          'امسح للحصول على العرض',
          'خصم 15٪',
        ),
      },
    },
    variantB: {
      en: c(
        'Fly with a new fragrance',
        'Delayed? Take your time: 15% off every fragrance at Aurelia, just steps from your gate.',
        'Scan for 15% off',
        '15% OFF',
      ),
      ar: c(
        'سافر بعطر جديد',
        'رحلتك متأخرة؟ خذ وقتك: خصم 15٪ على جميع العطور في أوريليا بالقرب من بوابتك.',
        'امسح للخصم',
        'خصم 15٪',
      ),
    },
  },
  {
    id: 'c02',
    advertiserId: 'adv-kite',
    name: 'Toys – buy 2, get 1 free',
    objective: 'conversion',
    status: 'active',
    days: [-20, 10],
    weights: {
      'partyType.family': 1,
      'partyType.group': 0.5,
      'partyType.couple': 0.28,
      'partyType.solo': 0.05,
    },
    zones: [...T2_AIRSIDE, 'T1-PLZ'],
    budget: { total: 156000, dailyCap: 6600, cpm: 11, cap: 50 },
    promo: promo('KITE3', 'Buy 2 toys, get 1 free', 'out-05', { mode: 'minutes', minutes: 90 }),
    performance: 0.64,
    creative: {
      template: 'offer_split',
      artwork: 'toys',
      palette: { background: '#FFF4E6', foreground: '#2B2B2B', accent: '#E94F37' },
      content: {
        en: c(
          'Buy 2, get 1 free',
          'Keep little travellers happy all the way: puzzles, plush and travel games at Kite & Kin.',
          'Scan for the offer',
          '3 FOR 2',
        ),
        ar: c(
          'اشترِ 2 واحصل على الثالثة مجاناً',
          'أسعد المسافرين الصغار طوال الرحلة: ألغاز وألعاب سفر في كايت آند كين.',
          'امسح للعرض',
          '3 بسعر 2',
        ),
      },
    },
  },
  {
    id: 'c03',
    advertiserId: 'adv-horizon',
    name: 'Business lounge day pass',
    objective: 'conversion',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.business': 1,
      'cabin.business': 1,
      'cabin.premium_economy': 1,
      'partyType.solo': 1,
      'partyType.couple': 0.1,
    },
    minDwell: 40,
    zones: [...T2_AIRSIDE, 'T1-PLZ', 'T1-A'],
    budget: { total: 180000, dailyCap: 6000, cpm: 16, cap: 40 },
    promo: promo('LOUNGE', 'Day pass from 39', 'out-16', { mode: 'minutes', minutes: 120 }, false),
    performance: 0.33,
    creative: {
      template: 'hero_full',
      artwork: 'lounge',
      palette: { background: '#0E2A2A', foreground: '#FFFFFF', accent: '#4FD1C5' },
      content: {
        en: c(
          'Work, rest, recharge',
          'Quiet seats, fast Wi-Fi and hot food at Horizon Lounge, Pier D. Day pass from 39.',
          'Scan to book',
          'FROM 39',
        ),
        ar: c(
          'اعمل واسترح واستعد نشاطك',
          'مقاعد هادئة وإنترنت سريع ووجبات ساخنة في صالة هورايزون، الرصيف D. التذكرة اليومية من 39.',
          'امسح للحجز',
          'من 39',
        ),
      },
    },
  },
  {
    id: 'c04',
    advertiserId: 'adv-brewline',
    name: 'Morning flat white – 2 for 1',
    objective: 'footfall',
    status: 'active',
    days: [-25, 20],
    weights: {
      'tripPurpose.business': 1,
      'partyType.solo': 0.8,
      'market.domestic': 1,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 1,
    },
    zones: [...T1_AIRSIDE, 'T1-LS', 'T2-LS', 'T2-PLZ'],
    hours: { from: 5, to: 11 },
    budget: { total: 72000, dailyCap: 2700, cpm: 8, cap: 60 },
    promo: promo('BREW2', 'Two flat whites for the price of one', 'out-25', { mode: 'minutes', minutes: 30 }),
    performance: 0.55,
    competitorGroup: 'coffee',
    creative: {
      template: 'offer_split',
      artwork: 'coffee',
      palette: { background: '#F3E9DD', foreground: '#3B2A20', accent: '#6F4E37' },
      content: {
        en: c(
          'Early flight? Flat whites, 2 for 1',
          'Freshly roasted at Brewline, ready in 3 minutes. Until 11:00.',
          'Scan to claim',
          '2 FOR 1',
        ),
        ar: c(
          'رحلة مبكرة؟ قهوة فلات وايت 2 بسعر 1',
          'محمصة طازجة في برولاين، جاهزة خلال 3 دقائق. حتى الساعة 11:00.',
          'امسح للحصول عليه',
          '2 بسعر 1',
        ),
      },
    },
  },
  {
    id: 'c05',
    advertiserId: 'adv-brewline',
    name: 'Delayed? 20% off coffee',
    objective: 'goodwill',
    status: 'active',
    days: [-10, 25],
    weights: {
      'market.domestic': 0.7,
      'market.international': 0.7,
      'tripPurpose.business': 0.8,
      'tripPurpose.vfr': 0.6,
      'tripPurpose.holiday': 0.6,
    },
    market: 'domestic',
    zones: ALL_AIRSIDE,
    budget: { total: 54000, dailyCap: 2100, cpm: 7, cap: 50 },
    triggers: [{ type: 'delay_over', minutes: 20, airlineIata: null, destinations: [], boost: 1.8 }],
    promo: promo('BRWDLY', '20% off any drink', 'out-04'),
    performance: 0.48,
    competitorGroup: 'coffee',
    creative: {
      template: 'voucher',
      artwork: 'coffee',
      palette: { background: '#3B2A20', foreground: '#FFFFFF', accent: '#F2C14E' },
      content: {
        en: c(
          'Delayed? Have a coffee on us',
          '20% off any drink at Brewline while you wait. Valid until your boarding closes.',
          'Scan for 20% off',
          '20% OFF',
        ),
        ar: c(
          'رحلتك متأخرة؟ قهوتك علينا',
          'خصم 20٪ على أي مشروب في برولاين أثناء الانتظار. صالح حتى إغلاق باب الصعود.',
          'امسح للخصم',
          'خصم 20٪',
        ),
      },
    },
  },
  {
    id: 'c06',
    advertiserId: 'adv-air-XD',
    name: 'Skylark Plus – upgrade at the gate',
    objective: 'conversion',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.business': 0.8,
      'tripPurpose.holiday': 0.5,
      'partyType.couple': 0.6,
      'partyType.solo': 0.6,
    },
    zones: [...T1_AIRSIDE, ...T2_PIERS],
    budget: { total: 120000, dailyCap: 4200, cpm: 9, cap: 75 },
    triggers: [{ type: 'boarding_starts', boost: 1.3 }],
    airlinePriority: true,
    performance: 0.42,
    creative: {
      template: 'gate_message',
      artwork: 'seat',
      palette: { background: '#F2A900', foreground: '#1A1A1A', accent: '#FFFFFF' },
      content: {
        en: c(
          'Extra legroom from 19',
          'Upgrade to Skylark Plus: front rows, priority boarding and a free snack. Ask at the gate.',
          'Upgrade in the app',
        ),
        ar: c(
          'مساحة إضافية للساقين من 19',
          'ترقَّ إلى سكايلارك بلس: صفوف أمامية وصعود أولوية ووجبة خفيفة مجانية. اسأل عند البوابة.',
          'رقِّ عبر التطبيق',
        ),
      },
    },
  },
  {
    id: 'c07',
    advertiserId: 'adv-air-XH',
    name: 'Halcyon Business – upgrade offer',
    objective: 'conversion',
    status: 'active',
    days: [-14, 30],
    weights: {
      'tripPurpose.business': 1,
      'cabin.economy': 0.6,
      'ageBand.a35_44': 1,
      'ageBand.a45_54': 1,
      'ageBand.a25_34': 0.6,
    },
    market: 'international',
    zones: T2_PIERS,
    budget: { total: 216000, dailyCap: 7200, cpm: 18, cap: 40 },
    triggers: [{ type: 'boarding_starts', boost: 1.3 }],
    airlinePriority: true,
    performance: 0.37,
    creative: {
      template: 'gate_message',
      artwork: 'flatbed',
      palette: { background: '#0B6E4F', foreground: '#FFFFFF', accent: '#D4AF37' },
      content: {
        en: c(
          'Arrive rested: Business from 290',
          'Lie-flat seats and lounge access on tonight’s Halcyon flight. Limited seats at the gate.',
          'Ask at the gate',
          'FROM 290',
        ),
        ar: c(
          'صل مرتاحاً: درجة رجال الأعمال من 290',
          'مقاعد قابلة للتمدد ودخول الصالة على رحلة هالسيون الليلة. مقاعد محدودة عند البوابة.',
          'اسأل عند البوابة',
          'من 290',
        ),
      },
    },
  },
  {
    id: 'c08',
    advertiserId: 'adv-air-XH',
    name: 'Delay goodwill – meal voucher (with Brewline)',
    objective: 'goodwill',
    status: 'active',
    days: [-30, 30],
    weights: { 'market.international': 1, 'market.domestic': 1 },
    zones: T2_PIERS,
    budget: { total: 48000, dailyCap: 3600, cpm: 0, cap: 100 },
    triggers: [{ type: 'delay_over', minutes: 60, airlineIata: 'XH', destinations: [], boost: 2.5 }],
    promo: promo('XHMEAL', 'A meal and drink on Halcyon', 'out-14'),
    airlinePriority: true,
    coFundedBy: 'adv-brewline',
    performance: 0.6,
    creative: {
      template: 'voucher',
      artwork: 'voucher',
      palette: { background: '#0B6E4F', foreground: '#FFFFFF', accent: '#F2C14E' },
      content: {
        en: c(
          'Sorry for the wait. Lunch is on us',
          'Halcyon passengers: a meal and drink at Brewline, Pier D. Valid until boarding closes.',
          'Scan for your voucher',
          'ON US',
        ),
        ar: c(
          'نعتذر عن الانتظار. الغداء علينا',
          'ركاب هالسيون: وجبة ومشروب في برولاين، الرصيف D. صالحة حتى إغلاق الصعود.',
          'امسح لقسيمتك',
          'مجاناً',
        ),
      },
    },
  },
  {
    id: 'c09',
    advertiserId: 'adv-saffron',
    name: 'Festive sweets – 20% off',
    objective: 'conversion',
    status: 'active',
    days: [-3, 9],
    weights: {
      'partyType.family': 1,
      'market.domestic': 1,
      'tripPurpose.vfr': 0.9,
      'tripPurpose.holiday': 0.6,
    },
    zones: ['T1-PLZ', 'T2-PLZ', 'T1-B', 'T2-F'],
    budget: { total: 42000, dailyCap: 4200, cpm: 10, cap: 60 },
    triggers: [{ type: 'festival_day', boost: 1.6 }],
    promo: promo('SWEET20', '20% off festive gift boxes', 'out-06'),
    performance: 0.58,
    creative: {
      template: 'offer_split',
      artwork: 'sweets',
      palette: { background: '#7B1E3A', foreground: '#FFFFFF', accent: '#E8A33D' },
      content: {
        en: c(
          'Festive sweets, 20% off',
          'Take a box of Lantern Festival favourites home to the family.',
          'Scan for 20% off',
          '20% OFF',
        ),
        ar: c(
          'حلويات العيد بخصم 20٪',
          'خذ علبة من حلويات مهرجان الفوانيس إلى العائلة.',
          'امسح للخصم',
          'خصم 20٪',
        ),
      },
    },
  },
  {
    id: 'c10',
    advertiserId: 'adv-solenne',
    name: 'Maison Solenne – Nuit d’Or',
    objective: 'awareness',
    status: 'active',
    days: [-18, 12],
    weights: {
      'gender.female': 1,
      'gender.male': 0.4,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 1,
      'market.international': 0.8,
      'market.domestic': 0.3,
    },
    zones: ['T2-PLZ', 'T2-E', 'T2-F'],
    budget: { total: 300000, dailyCap: 10200, cpm: 20, cap: 30 },
    performance: 0.26,
    competitorGroup: 'perfume',
    creative: {
      template: 'hero_full',
      artwork: 'perfume',
      palette: { background: '#1C1C1C', foreground: '#F5E6C8', accent: '#C9A227' },
      content: {
        en: c(
          'Nuit d’Or',
          'The new eau de parfum by Maison Solenne. Exclusively at Aurelia Duty Free.',
          'Try it at Aurelia',
        ),
        ar: c('نوي دور', 'عطر ميزون سولين الجديد. حصرياً في أوريليا للسوق الحرة.', 'جرّبه في أوريليا'),
      },
    },
  },
  {
    id: 'c11',
    advertiserId: 'adv-velour',
    name: 'Velour Parfums – Oud Noir',
    objective: 'awareness',
    status: 'active',
    days: [-8, 22],
    weights: {
      'tripPurpose.business': 0.8,
      'tripPurpose.holiday': 0.6,
      'ageBand.a35_44': 1,
      'ageBand.a45_54': 1,
      'ageBand.a25_34': 0.7,
    },
    regions: ['gulf'],
    zones: ['T2-PLZ'],
    budget: { total: 204000, dailyCap: 7200, cpm: 19, cap: 30 },
    performance: 0.29,
    competitorGroup: 'perfume',
    creative: {
      template: 'hero_full',
      artwork: 'oud',
      palette: { background: '#2A1A12', foreground: '#F7E7CE', accent: '#B8860B' },
      content: {
        en: c(
          'Oud Noir',
          'A deep, smoky oud for evenings in Zarhan. By Velour Parfums.',
          'Discover at Aurelia',
        ),
        ar: c('عود نوار', 'عود عميق ودخاني لأمسيات زرهان. من فيلور للعطور.', 'اكتشفه في أوريليا'),
      },
    },
  },
  {
    id: 'c12',
    advertiserId: 'adv-voltline',
    name: 'Travel tech – headphones 10% off',
    objective: 'conversion',
    status: 'active',
    days: [-15, 15],
    weights: {
      'tripPurpose.business': 0.8,
      'tripPurpose.student': 1,
      'ageBand.a18_24': 1,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 0.5,
    },
    zones: ['T1-PLZ', 'T2-PLZ', 'T1-B', 'T2-E'],
    budget: { total: 90000, dailyCap: 3600, cpm: 12, cap: 40 },
    promo: promo('VOLT10', '10% off noise-cancelling headphones', 'out-07', { mode: 'minutes', minutes: 60 }),
    performance: 0.4,
    creative: {
      template: 'offer_split',
      artwork: 'headphones',
      palette: { background: '#0F1C2E', foreground: '#FFFFFF', accent: '#2D9CDB' },
      content: {
        en: c(
          'Silence the cabin',
          'Noise-cancelling headphones, 10% off at Voltline before you board.',
          'Scan for 10% off',
          '10% OFF',
        ),
        ar: c(
          'أسكت ضجيج المقصورة',
          'سماعات عازلة للضوضاء بخصم 10٪ في فولتلاين قبل الصعود.',
          'امسح للخصم',
          'خصم 10٪',
        ),
      },
    },
  },
  {
    id: 'c13',
    advertiserId: 'adv-pagewise',
    name: 'Holiday reads – 3 for 2',
    objective: 'conversion',
    status: 'active',
    days: [-22, 8],
    weights: {
      'tripPurpose.holiday': 1,
      'partyType.couple': 0.8,
      'partyType.family': 0.5,
      'ageBand.a25_34': 0.7,
      'ageBand.a35_44': 0.8,
      'ageBand.a45_54': 0.8,
      'ageBand.a55p': 1,
    },
    minDwell: 25,
    zones: ['T1-PLZ', 'T2-PLZ'],
    budget: { total: 48000, dailyCap: 1800, cpm: 9, cap: 40 },
    promo: promo('READ32', '3 books for the price of 2', 'out-08', { mode: 'minutes', minutes: 60 }),
    performance: 0.35,
    creative: {
      template: 'offer_split',
      artwork: 'books',
      palette: { background: '#F6F1E7', foreground: '#22313F', accent: '#3D5A80' },
      content: {
        en: c(
          'Holiday reads, 3 for 2',
          'Bestsellers for the beach and the long flight, at Pagewise.',
          'Scan for the offer',
          '3 FOR 2',
        ),
        ar: c(
          'كتب العطلة 3 بسعر 2',
          'الأكثر مبيعاً للشاطئ والرحلة الطويلة في بيجوايز.',
          'امسح للعرض',
          '3 بسعر 2',
        ),
      },
    },
  },
  {
    id: 'c14',
    advertiserId: 'adv-linenlark',
    name: 'Resort edit – new season',
    objective: 'awareness',
    status: 'active',
    days: [-6, 24],
    weights: {
      'tripPurpose.holiday': 1,
      'gender.female': 0.8,
      'gender.male': 0.4,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 0.9,
    },
    zones: ['T1-PLZ', 'T2-PLZ'],
    budget: { total: 96000, dailyCap: 3300, cpm: 13, cap: 30 },
    performance: 0.31,
    creative: {
      template: 'hero_full',
      artwork: 'fashion',
      palette: { background: '#F4E1D2', foreground: '#3C2F2F', accent: '#A26769' },
      content: {
        en: c(
          'The resort edit',
          'Linen shirts, sun hats and easy dresses for wherever you land.',
          'Shop in the Market Hall',
        ),
        ar: c(
          'تشكيلة المنتجعات',
          'قمصان كتان وقبعات شمس وفساتين خفيفة لوجهتك القادمة.',
          'تسوّق في ساحة السوق',
        ),
      },
    },
  },
  {
    id: 'c15',
    advertiserId: 'adv-roamly',
    name: 'Land connected – 10 GB eSIM',
    objective: 'conversion',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.business': 0.8,
      'tripPurpose.holiday': 0.7,
      'tripPurpose.student': 0.8,
      'ageBand.a18_24': 1,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 0.8,
    },
    market: 'international',
    zones: ['T2-PLZ', 'T2-LS', 'T2-ARR'],
    budget: { total: 132000, dailyCap: 4500, cpm: 12, cap: 40 },
    promo: promo(
      'ROAM10',
      '10 GB travel eSIM, first week free',
      null,
      { mode: 'minutes', minutes: 180 },
      false,
    ),
    performance: 0.45,
    creative: {
      template: 'destination',
      artwork: 'esim',
      palette: { background: '#0E3B36', foreground: '#FFFFFF', accent: '#4CD3B0' },
      content: {
        en: c(
          'Land connected',
          '10 GB of data in 40 destinations. Install before take-off, first week free.',
          'Scan to install',
          'FREE WEEK',
        ),
        ar: c(
          'اهبط وأنت متصل',
          '10 غيغابايت في 40 وجهة. ثبّتها قبل الإقلاع، والأسبوع الأول مجاناً.',
          'امسح للتثبيت',
          'أسبوع مجاني',
        ),
      },
    },
  },
  {
    id: 'c16',
    advertiserId: 'adv-globe',
    name: 'Zero-commission currency',
    objective: 'footfall',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.holiday': 0.9,
      'tripPurpose.vfr': 0.8,
      'tripPurpose.religious': 0.8,
      'ageBand.a35_44': 0.8,
      'ageBand.a45_54': 1,
      'ageBand.a55p': 1,
    },
    market: 'international',
    zones: ['T2-LS', 'T2-PLZ', 'T2-ARR'],
    budget: { total: 54000, dailyCap: 1800, cpm: 8, cap: 40 },
    promo: promo(
      'GLOBE0',
      'Zero commission on your first exchange',
      'out-13',
      { mode: 'minutes', minutes: 120 },
      false,
    ),
    performance: 0.38,
    creative: {
      template: 'offer_split',
      artwork: 'currency',
      palette: { background: '#E8EEF2', foreground: '#1B2631', accent: '#34495E' },
      content: {
        en: c(
          'Zero commission today',
          'Swap your currency before you fly, with no commission at Globe Exchange.',
          'Scan to claim',
          '0%',
        ),
        ar: c('بدون عمولة اليوم', 'استبدل عملتك قبل السفر بدون عمولة في جلوب إكسشينج.', 'امسح للعرض', '0٪'),
      },
    },
  },
  {
    id: 'c17',
    advertiserId: 'adv-rentaro',
    name: 'Your car is waiting – arrivals',
    objective: 'conversion',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.holiday': 0.9,
      'tripPurpose.business': 0.8,
      'partyType.family': 0.8,
      'partyType.couple': 0.7,
    },
    zones: ['T1-ARR', 'T2-ARR'],
    budget: { total: 84000, dailyCap: 2700, cpm: 10, cap: 50 },
    promo: promo('DRIVE15', '15% off a car today', 'out-22', { mode: 'minutes', minutes: 120 }, false),
    performance: 0.36,
    creative: {
      template: 'destination',
      artwork: 'car',
      palette: { background: '#FDF2E9', foreground: '#2C3E50', accent: '#E67E22' },
      content: {
        en: c(
          'Your car is waiting',
          'Skip the taxi queue: 15% off Rentaro car hire, desk next to the exit.',
          'Scan for 15% off',
          '15% OFF',
        ),
        ar: c(
          'سيارتك بانتظارك',
          'تجنّب طابور سيارات الأجرة: خصم 15٪ على تأجير رينتارو، المكتب بجوار المخرج.',
          'امسح للخصم',
          'خصم 15٪',
        ),
      },
    },
  },
  {
    id: 'c18',
    advertiserId: 'adv-northbank',
    name: 'Northbank Voyager Card',
    objective: 'awareness',
    status: 'active',
    days: [-30, 30],
    weights: {
      'tripPurpose.business': 1,
      'cabin.business': 1,
      'cabin.premium_economy': 0.7,
      'ageBand.a35_44': 1,
      'ageBand.a45_54': 1,
    },
    zones: ['T1-LS', 'T2-LS', 'T2-PLZ', 'T1-PLZ', 'T1-ARR', 'T2-ARR'],
    budget: { total: 240000, dailyCap: 7800, cpm: 17, cap: 25 },
    performance: 0.22,
    creative: {
      template: 'hero_full',
      artwork: 'card',
      palette: { background: '#0B3954', foreground: '#FFFFFF', accent: '#BFD7EA' },
      content: {
        en: c(
          'Every trip earns the next one',
          'The Northbank Voyager Card: 3x points on travel and lounge visits included.',
          'Apply in 5 minutes',
        ),
        ar: c(
          'كل رحلة تقرّبك من التالية',
          'بطاقة نورثبانك فوياجر: 3 أضعاف النقاط على السفر وزيارات الصالة مشمولة.',
          'قدّم خلال 5 دقائق',
        ),
      },
    },
  },
  {
    id: 'c19',
    advertiserId: 'adv-ember',
    name: 'Long delay? Set menu with a view',
    objective: 'conversion',
    status: 'active',
    days: [-16, 14],
    weights: {
      'partyType.couple': 0.9,
      'partyType.group': 0.8,
      'tripPurpose.business': 0.6,
      'tripPurpose.holiday': 0.7,
    },
    minDwell: 45,
    zones: ['T1-PLZ', 'T2-PLZ'],
    budget: { total: 66000, dailyCap: 2400, cpm: 11, cap: 40 },
    triggers: [{ type: 'delay_over', minutes: 45, airlineIata: null, destinations: [], boost: 1.4 }],
    promo: promo('EMBER', 'Two-course set menu with a drink', 'out-10'),
    performance: 0.41,
    competitorGroup: 'dining',
    creative: {
      template: 'offer_split',
      artwork: 'grill',
      palette: { background: '#241310', foreground: '#FFFFFF', accent: '#E74C3C' },
      content: {
        en: c(
          'Time for a proper meal',
          'Two courses and a drink, with a view of the runway. Ember Grill.',
          'Scan for the set menu',
          'SET MENU',
        ),
        ar: c(
          'حان وقت وجبة حقيقية',
          'طبقان ومشروب مع إطلالة على المدرج. إمبر جريل.',
          'امسح لقائمة الطعام',
          'قائمة ثابتة',
        ),
      },
    },
  },
  {
    id: 'c20',
    advertiserId: 'adv-carewing',
    name: 'Travel essentials kit',
    objective: 'conversion',
    status: 'active',
    days: [-30, 30],
    weights: { 'partyType.family': 1, 'ageBand.u12': 1, 'ageBand.a55p': 0.7, 'tripPurpose.holiday': 0.6 },
    zones: ['T1-PLZ', 'T2-PLZ', 'T1-ARR'],
    budget: { total: 36000, dailyCap: 1200, cpm: 7, cap: 40 },
    promo: promo('CARE5', '5 off the travel essentials kit', 'out-12', { mode: 'minutes', minutes: 60 }),
    performance: 0.34,
    creative: {
      template: 'offer_split',
      artwork: 'pharmacy',
      palette: { background: '#EAF7EF', foreground: '#1D3B2A', accent: '#27AE60' },
      content: {
        en: c(
          'Forgot something?',
          'Travel-size essentials, motion-sickness bands and kids’ remedies at CareWing.',
          'Scan for 5 off',
        ),
        ar: c(
          'نسيت شيئاً؟',
          'مستلزمات بحجم السفر وأساور دوار الحركة وأدوية الأطفال في كيروينج.',
          'امسح للخصم',
        ),
      },
    },
  },
  {
    id: 'c21',
    advertiserId: 'adv-gatehouse',
    name: 'Student combo',
    objective: 'conversion',
    status: 'active',
    days: [-12, 18],
    weights: { 'tripPurpose.student': 1, 'ageBand.a18_24': 1, 'partyType.group': 0.8, 'partyType.solo': 0.5 },
    zones: [...T1_AIRSIDE, 'T2-E'],
    budget: { total: 30000, dailyCap: 1080, cpm: 6, cap: 50 },
    promo: promo('STUDY', 'Burger, fries and drink for 9', 'out-31', { mode: 'minutes', minutes: 45 }),
    performance: 0.47,
    competitorGroup: 'dining',
    creative: {
      template: 'offer_split',
      artwork: 'burger',
      palette: { background: '#FFF8E1', foreground: '#2B2B2B', accent: '#D4A017' },
      content: {
        en: c(
          'Student combo, 9',
          'Burger, fries and a drink. Show your student card at Gatehouse.',
          'Scan for the combo',
          '9',
        ),
        ar: c('وجبة الطلاب بـ 9', 'برغر وبطاطس ومشروب. أظهر بطاقة الطالب في جيتهاوس.', 'امسح للوجبة', '9'),
      },
    },
  },
  {
    id: 'c22',
    advertiserId: 'adv-air-ZO',
    name: 'Discover Kastell',
    objective: 'awareness',
    status: 'pending_review',
    days: [1, 30],
    weights: {
      'tripPurpose.holiday': 1,
      'tripPurpose.business': 0.6,
      'ageBand.a25_34': 1,
      'ageBand.a35_44': 1,
    },
    destinations: ['KST'],
    zones: T2_PIERS,
    budget: { total: 108000, dailyCap: 3600, cpm: 14, cap: 40 },
    airlinePriority: true,
    performance: 0.3,
    creative: {
      template: 'destination',
      artwork: 'city',
      palette: { background: '#6B2D8C', foreground: '#FFFFFF', accent: '#F4D35E' },
      content: {
        en: c(
          'Kastell in winter',
          'Markets, museums and mulled wine. Solano partner hotels from 89 a night.',
          'Book with Solano',
        ),
        ar: c(
          'كاستل في الشتاء',
          'أسواق ومتاحف وأجواء دافئة. فنادق شركاء سولانو من 89 لليلة.',
          'احجز مع سولانو',
        ),
      },
    },
  },
  {
    id: 'c23',
    advertiserId: 'adv-air-YA',
    name: 'Aurora lounge pass',
    objective: 'conversion',
    status: 'pending_review',
    days: [2, 30],
    weights: { 'tripPurpose.business': 1, 'partyType.solo': 0.8 },
    zones: ['T2-PLZ', 'T2-D', 'T2-E'],
    budget: { total: 60000, dailyCap: 2100, cpm: 12, cap: 40 },
    airlinePriority: true,
    performance: 0.3,
    creative: {
      template: 'gate_message',
      artwork: 'lounge',
      palette: { background: '#1F4E9C', foreground: '#FFFFFF', accent: '#9AD1F5' },
      content: {
        en: c(
          'Aurora lounge, 29 today',
          'Aurora National passengers: lounge access for 29 with your boarding pass.',
          'Ask at the lounge',
        ),
        ar: c(
          'صالة أورورا، 29 اليوم',
          'ركاب أورورا الوطنية: دخول الصالة مقابل 29 مع بطاقة الصعود.',
          'اسأل في الصالة',
        ),
      },
    },
  },
  {
    id: 'c24',
    advertiserId: 'adv-aurelia',
    name: 'Gulf travellers – oud collection',
    objective: 'conversion',
    status: 'completed',
    days: [-30, -4],
    weights: {
      'tripPurpose.business': 0.9,
      'tripPurpose.holiday': 0.6,
      'ageBand.a35_44': 1,
      'ageBand.a45_54': 1,
    },
    regions: ['gulf'],
    zones: T2_AIRSIDE,
    budget: { total: 144000, dailyCap: 6000, cpm: 15, cap: 40 },
    promo: promo('OUD10', '10% off the oud collection', 'out-03'),
    performance: 0.39,
    competitorGroup: 'perfume',
    creative: {
      template: 'offer_split',
      artwork: 'oud',
      palette: { background: '#3B2314', foreground: '#FFFFFF', accent: '#D4A017' },
      content: {
        en: c(
          'Flying to Zarhan? Take the oud',
          '10% off our oud collection at Aurelia Gulf Boutique.',
          'Scan for 10% off',
          '10% OFF',
        ),
        ar: c(
          'مسافر إلى زرهان؟ خذ العود معك',
          'خصم 10٪ على مجموعة العود في بوتيك أوريليا الخليج.',
          'امسح للخصم',
          'خصم 10٪',
        ),
      },
    },
  },
  {
    id: 'c25',
    advertiserId: 'adv-kite',
    name: 'School holiday activity packs',
    objective: 'conversion',
    status: 'completed',
    days: [-30, -9],
    weights: { 'partyType.family': 1, 'ageBand.u12': 1, 'ageBand.a12_17': 0.7 },
    zones: ['T1-PLZ', 'T2-PLZ'],
    budget: { total: 54000, dailyCap: 2700, cpm: 10, cap: 40 },
    promo: promo('PACK', 'Activity pack for 12', 'out-26', { mode: 'minutes', minutes: 90 }),
    performance: 0.6,
    creative: {
      template: 'offer_split',
      artwork: 'toys',
      palette: { background: '#E6F4FF', foreground: '#1B2A41', accent: '#E94F37' },
      content: {
        en: c(
          'Bored on board? Not today',
          'Colouring, puzzles and stickers in one activity pack, 12 at Kite & Kin.',
          'Scan for the pack',
          '12',
        ),
        ar: c(
          'ملل على متن الطائرة؟ ليس اليوم',
          'تلوين وألغاز وملصقات في حقيبة أنشطة واحدة، بـ 12 في كايت آند كين.',
          'امسح للحقيبة',
          '12',
        ),
      },
    },
  },
];
