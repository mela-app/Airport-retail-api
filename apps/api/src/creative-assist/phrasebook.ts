/**
 * Copy for the offline creative assistant, per product category, in English and Arabic. `{brand}` and
 * `{offer}` are filled in; brand names stay in Latin script in Arabic copy, as on airport signage.
 */

export interface Copy {
  en: string;
  ar: string;
}

export interface CategoryCopy {
  artworks: readonly string[];
  headlines: readonly Copy[];
  /** With an offer: `{offer}` is the offer phrase (e.g. "15% off"). */
  bodyOffer: Copy;
  body: Copy;
  cta: Copy;
}

export const CATEGORY_COPY = new Map<string, CategoryCopy>([
  [
    'fragrance',
    {
      artworks: ['perfume', 'oud'],
      headlines: [
        { en: 'Fly with a new fragrance', ar: 'سافر بعطر جديد' },
        { en: 'Your signature scent for the journey', ar: 'عطرك المميز لرحلتك' },
        { en: 'Arrive unforgettable', ar: 'اصنع حضورًا لا يُنسى' },
      ],
      bodyOffer: {
        en: 'Time before boarding? {offer} on fragrances at {brand}, a short walk from your gate.',
        ar: 'لديك وقت قبل الصعود؟ {offer} على العطور في {brand}، على بعد خطوات من بوابتك.',
      },
      body: {
        en: 'Discover new fragrances at {brand} before you board, a short walk from your gate.',
        ar: 'اكتشف عطورًا جديدة في {brand} قبل صعودك إلى الطائرة، على بعد خطوات من بوابتك.',
      },
      cta: { en: 'Scan for your offer', ar: 'امسح للحصول على العرض' },
    },
  ],
  [
    'coffee',
    {
      artworks: ['coffee'],
      headlines: [
        { en: 'Your coffee is ready before boarding', ar: 'قهوتك جاهزة قبل الصعود' },
        { en: 'A fresh cup for the road', ar: 'كوب طازج لرحلتك' },
        { en: 'Slow down, sip, fly', ar: 'استرخِ، تذوّق، ثم سافر' },
      ],
      bodyOffer: {
        en: '{offer} at {brand}. Freshly made and ready in minutes.',
        ar: '{offer} في {brand}. محضّرة طازجة وجاهزة خلال دقائق.',
      },
      body: {
        en: 'Freshly made coffee at {brand}, ready in minutes before your flight.',
        ar: 'قهوة محضّرة طازجة في {brand}، جاهزة خلال دقائق قبل رحلتك.',
      },
      cta: { en: 'Scan to order ahead', ar: 'امسح للطلب مسبقًا' },
    },
  ],
  [
    'dining',
    {
      artworks: ['grill', 'burger'],
      headlines: [
        { en: 'A proper meal before you fly', ar: 'وجبة شهية قبل أن تسافر' },
        { en: 'Hungry? Your table is waiting', ar: 'جائع؟ طاولتك بانتظارك' },
        { en: 'Taste the city one last time', ar: 'تذوّق نكهات المدينة مرة أخيرة' },
      ],
      bodyOffer: {
        en: '{offer} at {brand}. Served fast, so you never miss boarding.',
        ar: '{offer} في {brand}. تقديم سريع حتى لا يفوتك موعد الصعود.',
      },
      body: {
        en: 'Fresh food at {brand}, served fast so you never miss boarding.',
        ar: 'طعام طازج في {brand}، يُقدَّم بسرعة حتى لا يفوتك موعد الصعود.',
      },
      cta: { en: 'Scan for the menu', ar: 'امسح لعرض القائمة' },
    },
  ],
  [
    'sweets',
    {
      artworks: ['sweets'],
      headlines: [
        { en: 'Take something sweet home', ar: 'خذ معك شيئًا حلوًا' },
        { en: 'A gift they will remember', ar: 'هدية لا تُنسى' },
        { en: 'Sweeten the journey', ar: 'رحلة أحلى' },
      ],
      bodyOffer: {
        en: '{offer} on gift boxes at {brand}, packed for travel.',
        ar: '{offer} على علب الهدايا في {brand}، مغلّفة للسفر.',
      },
      body: {
        en: 'Gift boxes at {brand}, beautifully packed for travel.',
        ar: 'علب هدايا في {brand}، مغلّفة بعناية للسفر.',
      },
      cta: { en: 'Scan for gift ideas', ar: 'امسح لأفكار الهدايا' },
    },
  ],
  [
    'toys',
    {
      artworks: ['toys'],
      headlines: [
        { en: 'Happy kids, happy flight', ar: 'أطفال سعداء، رحلة سعيدة' },
        { en: 'Playtime for the journey', ar: 'وقت اللعب طوال الرحلة' },
        { en: 'A little surprise for the flight', ar: 'مفاجأة صغيرة للرحلة' },
      ],
      bodyOffer: {
        en: '{offer} at {brand}. Travel-sized games and toys for every age.',
        ar: '{offer} في {brand}. ألعاب بحجم مناسب للسفر لجميع الأعمار.',
      },
      body: {
        en: 'Travel-sized games and toys for every age at {brand}.',
        ar: 'ألعاب بحجم مناسب للسفر لجميع الأعمار في {brand}.',
      },
      cta: { en: 'Scan for the family offer', ar: 'امسح لعرض العائلة' },
    },
  ],
  [
    'electronics',
    {
      artworks: ['headphones'],
      headlines: [
        { en: 'Hear less engine, more music', ar: 'موسيقى أكثر، ضجيج أقل' },
        { en: 'Power up before take-off', ar: 'استعد قبل الإقلاع' },
        { en: 'Travel tech, sorted', ar: 'كل ما تحتاجه من تقنيات السفر' },
      ],
      bodyOffer: {
        en: '{offer} on headphones and chargers at {brand}.',
        ar: '{offer} على السماعات والشواحن في {brand}.',
      },
      body: {
        en: 'Headphones, chargers and adapters at {brand}, near your gate.',
        ar: 'سماعات وشواحن ومحوّلات في {brand}، بالقرب من بوابتك.',
      },
      cta: { en: 'Scan for your offer', ar: 'امسح للحصول على العرض' },
    },
  ],
  [
    'books',
    {
      artworks: ['books'],
      headlines: [
        { en: 'Your next chapter starts here', ar: 'فصلك التالي يبدأ هنا' },
        { en: 'A good book makes the flight shorter', ar: 'كتاب جيد يجعل الرحلة أقصر' },
        { en: 'Read your way there', ar: 'اقرأ طوال الطريق' },
      ],
      bodyOffer: {
        en: '{offer} on bestselling titles at {brand}.',
        ar: '{offer} على أكثر الكتب مبيعًا في {brand}.',
      },
      body: {
        en: 'New releases and travel reads at {brand}, a short walk from your gate.',
        ar: 'أحدث الإصدارات وكتب السفر في {brand}، على بعد خطوات من بوابتك.',
      },
      cta: { en: 'Scan for reading picks', ar: 'امسح لاقتراحات القراءة' },
    },
  ],
  [
    'fashion',
    {
      artworks: ['fashion'],
      headlines: [
        { en: 'Arrive in style', ar: 'صل بأناقة' },
        { en: 'Your travel wardrobe, refreshed', ar: 'جدّد أزياء سفرك' },
        { en: 'Pack something new', ar: 'أضف قطعة جديدة إلى حقيبتك' },
      ],
      bodyOffer: {
        en: '{offer} on the new collection at {brand}.',
        ar: '{offer} على المجموعة الجديدة في {brand}.',
      },
      body: {
        en: 'The new collection at {brand}, curated for travellers.',
        ar: 'المجموعة الجديدة في {brand}، مختارة للمسافرين.',
      },
      cta: { en: 'Scan to shop', ar: 'امسح للتسوّق' },
    },
  ],
  [
    'pharmacy',
    {
      artworks: ['pharmacy'],
      headlines: [
        { en: 'Travel essentials, all in one place', ar: 'مستلزمات السفر في مكان واحد' },
        { en: 'Feel good on every flight', ar: 'راحة في كل رحلة' },
        { en: 'Forgot something? We have it', ar: 'نسيت شيئًا؟ لدينا ما تحتاجه' },
      ],
      bodyOffer: {
        en: '{offer} on travel kits at {brand}.',
        ar: '{offer} على حقائب مستلزمات السفر في {brand}.',
      },
      body: {
        en: 'Travel kits, sun care and comfort essentials at {brand}.',
        ar: 'حقائب السفر ومستحضرات الحماية من الشمس ومستلزمات الراحة في {brand}.',
      },
      cta: { en: 'Scan for essentials', ar: 'امسح للمستلزمات' },
    },
  ],
  [
    'lounge',
    {
      artworks: ['lounge'],
      headlines: [
        { en: 'Wait in comfort', ar: 'انتظر براحة' },
        { en: 'Your quiet corner before take-off', ar: 'ركنك الهادئ قبل الإقلاع' },
        { en: 'Delayed? Make it a pleasure', ar: 'رحلتك متأخرة؟ اجعل الانتظار متعة' },
      ],
      bodyOffer: {
        en: '{offer} on a day pass at {brand}: quiet seats, food and fast Wi-Fi.',
        ar: '{offer} على تذكرة الدخول اليومية إلى {brand}: مقاعد هادئة وطعام وإنترنت سريع.',
      },
      body: {
        en: 'Quiet seats, food and fast Wi-Fi at {brand}, minutes from your gate.',
        ar: 'مقاعد هادئة وطعام وإنترنت سريع في {brand}، على بعد دقائق من بوابتك.',
      },
      cta: { en: 'Scan to book a pass', ar: 'امسح لحجز تذكرة' },
    },
  ],
  [
    'services',
    {
      artworks: ['currency', 'car', 'card', 'esim'],
      headlines: [
        { en: 'Land ready', ar: 'صل مستعدًا' },
        { en: 'Sorted before you arrive', ar: 'كل شيء جاهز قبل وصولك' },
        { en: 'One less thing to think about', ar: 'شيء أقل للتفكير فيه' },
      ],
      bodyOffer: {
        en: '{offer} with {brand}. Set it up now, use it the moment you land.',
        ar: '{offer} مع {brand}. جهّزه الآن واستخدمه فور وصولك.',
      },
      body: {
        en: 'Set it up now with {brand} and use it the moment you land.',
        ar: 'جهّزه الآن مع {brand} واستخدمه فور وصولك.',
      },
      cta: { en: 'Scan to get started', ar: 'امسح للبدء' },
    },
  ],
  [
    'airline',
    {
      artworks: ['seat', 'flatbed', 'city'],
      headlines: [
        { en: 'Upgrade your journey', ar: 'ارتقِ برحلتك' },
        { en: 'More room, more rest', ar: 'مساحة أكبر وراحة أكثر' },
        { en: 'Your next destination awaits', ar: 'وجهتك التالية بانتظارك' },
      ],
      bodyOffer: {
        en: '{offer} on seat upgrades with {brand} on today’s flights.',
        ar: '{offer} على ترقية المقعد مع {brand} في رحلات اليوم.',
      },
      body: {
        en: 'Ask {brand} at the gate about seat upgrades on today’s flights.',
        ar: 'اسأل {brand} عند البوابة عن ترقية المقعد في رحلات اليوم.',
      },
      cta: { en: 'Scan for upgrade options', ar: 'امسح لخيارات الترقية' },
    },
  ],
  [
    'duty_free',
    {
      artworks: ['voucher', 'perfume', 'sweets'],
      headlines: [
        { en: 'Treat yourself before take-off', ar: 'دلّل نفسك قبل الإقلاع' },
        { en: 'Tax-free favourites, steps away', ar: 'منتجاتك المفضلة معفاة من الضرائب' },
        { en: 'The last stop before your flight', ar: 'محطتك الأخيرة قبل رحلتك' },
      ],
      bodyOffer: {
        en: '{offer} at {brand}, a short walk from your gate.',
        ar: '{offer} في {brand}، على بعد خطوات من بوابتك.',
      },
      body: {
        en: 'Beauty, treats and gifts at {brand}, a short walk from your gate.',
        ar: 'منتجات التجميل والحلويات والهدايا في {brand}، على بعد خطوات من بوابتك.',
      },
      cta: { en: 'Scan for your offer', ar: 'امسح للحصول على العرض' },
    },
  ],
]);

/** Category from the brief's words first, then the advertiser's category. */
const KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  ['fragrance', ['perfume', 'fragrance', 'scent', 'oud', 'parfum', 'عطر']],
  ['coffee', ['coffee', 'latte', 'espresso', 'flat white', 'قهوة']],
  ['dining', ['meal', 'burger', 'grill', 'noodle', 'dinner', 'lunch', 'breakfast', 'restaurant', 'food']],
  ['sweets', ['sweet', 'chocolate', 'dates', 'baklava', 'candy', 'حلويات']],
  ['toys', ['toy', 'kids', 'children', 'family', 'game', 'ألعاب']],
  ['electronics', ['headphone', 'charger', 'electronic', 'tech', 'gadget']],
  ['books', ['book', 'novel', 'read', 'magazine']],
  ['fashion', ['fashion', 'dress', 'clothes', 'collection', 'style']],
  ['pharmacy', ['pharmacy', 'health', 'travel kit', 'sunscreen']],
  ['lounge', ['lounge', 'day pass', 'quiet']],
  ['services', ['currency', 'exchange', 'car hire', 'rental', 'esim', 'data', 'card', 'payment']],
  ['airline', ['upgrade', 'seat', 'flatbed', 'business class', 'destination', 'flight']],
];

const ADVERTISER_CATEGORY = new Map<string, string>([
  ['perfume', 'fragrance'],
  ['duty free', 'duty_free'],
  ['coffee', 'coffee'],
  ['dining', 'dining'],
  ['quick service', 'dining'],
  ['sweets', 'sweets'],
  ['toys', 'toys'],
  ['electronics', 'electronics'],
  ['books', 'books'],
  ['fashion', 'fashion'],
  ['pharmacy', 'pharmacy'],
  ['lounges', 'lounge'],
  ['currency exchange', 'services'],
  ['car hire', 'services'],
  ['mobile data', 'services'],
  ['payments', 'services'],
  ['low-cost airline', 'airline'],
  ['full-service airline', 'airline'],
]);

export function categoryFor(brief: string, advertiserCategory: string | undefined): string {
  const text = brief.toLowerCase();
  for (const [category, words] of KEYWORDS) if (words.some((w) => text.includes(w))) return category;
  return ADVERTISER_CATEGORY.get((advertiserCategory ?? '').toLowerCase()) ?? 'duty_free';
}

export interface Offer {
  en: string;
  ar: string;
  badgeEn: string;
  badgeAr: string;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Read an offer from the brief without regular expressions: "15%" / "15 %" / "2 for 1". */
export function findOffer(brief: string): Offer | null {
  const text = brief.toLowerCase();
  const pct = text.indexOf('%') >= 0 ? text.indexOf('%') : text.indexOf('٪');
  if (pct > 0) {
    let i = pct - 1;
    while (i >= 0 && text.charAt(i) === ' ') i -= 1;
    let digits = '';
    while (i >= 0) {
      const ch = text.charAt(i);
      const arabic = ARABIC_DIGITS.indexOf(ch);
      if (ch >= '0' && ch <= '9') digits = ch + digits;
      else if (arabic >= 0) digits = String(arabic) + digits;
      else break;
      i -= 1;
    }
    const n = Number(digits);
    if (digits.length > 0 && digits.length <= 2 && n > 0 && n < 100)
      return { en: `${n}% off`, ar: `خصم ${n}٪`, badgeEn: `${n}% OFF`, badgeAr: `خصم ${n}٪` };
  }
  if (text.includes('2 for 1') || text.includes('two for one') || text.includes('buy one get one'))
    return { en: '2 for 1', ar: 'اثنان بسعر واحد', badgeEn: '2 FOR 1', badgeAr: '٢ بسعر ١' };
  if (text.includes('free ') || text.endsWith('free'))
    return { en: 'A free gift', ar: 'هدية مجانية', badgeEn: 'GIFT', badgeAr: 'هدية' };
  return null;
}

export const fill = (template: string, brand: string, offer: string) =>
  template.replace(/\{brand\}/g, brand).replace(/\{offer\}/g, offer);

/** Sentence case for an offer phrase at the start of a sentence. */
export const capitalise = (s: string) => (s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s);
