import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import * as Code from '../src/Code.js';

// Mock GAS Globals (same harness as test/Code.spec.js)
const mockCache = {
  get: vi.fn(),
  put: vi.fn(),
  getAll: vi.fn(),
  removeAll: vi.fn(),
};

const mockCacheService = {
  getScriptCache: vi.fn().mockReturnValue(mockCache),
};

const mockContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput: vi.fn().mockImplementation((text) => ({
    text,
    mime: null,
    setMimeType(m) { this.mime = m; return this; },
  })),
};

const mockProperties = {
  getProperty: vi.fn(),
  setProperty: vi.fn(),
  deleteProperty: vi.fn(),
};

const mockPropertiesService = {
  getScriptProperties: vi.fn().mockReturnValue(mockProperties),
};

const mockUtilities = {
  computeDigest: vi.fn().mockImplementation((algo, bytes) => [bytes.reduce((a, b) => a + b, 0) % 256, bytes[bytes.length - 1] || 0]),
  DigestAlgorithm: { MD5: 'MD5' },
  newBlob: vi.fn().mockImplementation((s) => ({
    getBytes: () => Array.from(String(s)).map((c) => c.charCodeAt(0)),
  })),
};

const mockUrlFetchApp = {
  fetchAll: vi.fn(),
  fetch: vi.fn(),
};

global.CacheService = mockCacheService;
global.ContentService = mockContentService;
global.PropertiesService = mockPropertiesService;
global.Utilities = mockUtilities;
global.UrlFetchApp = mockUrlFetchApp;
global.console = { log: vi.fn(), error: vi.fn() };

const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

// Text built from whole fragments only, so generated inputs never carry
// a lone surrogate of their own: any lone surrogate in an output must
// have been produced by the code under test.
const fragmentArb = fc.constantFrom(
  'a', 'Z', '0', ' ', 'あ', '漢', '\u{1F600}', '&', ';', '#', 'x',
  '&amp;', '&#65;', '&#x41;', '&#x1F600;', '&copy;', '<', '>', '"', "'",
);
const textArb = fc.array(fragmentArb, { maxLength: 40 }).map((parts) => parts.join(''));

const validCodePointArb = fc.integer({ min: 1, max: 0x10FFFF })
  .filter((cp) => !(cp >= 0xD800 && cp <= 0xDFFF));
const forbiddenCodePointArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0xD800, max: 0xDFFF }),
  fc.integer({ min: 0x110000, max: 0x7FFFFFFF }),
);

const safeTextArb = (maxLength) => fc.array(
  fc.constantFrom(...'abcde AIUEO あいうえお 12345'.split('')),
  { maxLength },
).map((chars) => chars.join(''));

const jsonDomainArb = fc.oneof(fc.jsonValue(), fc.constant({ toString: [] }));

describe('property-based: ogp-api-gas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheService.getScriptCache.mockReturnValue(mockCache);
    mockCache.getAll.mockReturnValue({});
    mockCache.get.mockReturnValue(null);
    mockProperties.getProperty.mockReturnValue(null);
    mockUrlFetchApp.fetchAll.mockReset();
    mockUrlFetchApp.fetch.mockReset();
  });

  it('decodeHtmlEntities_ never throws and always returns a string', () => {
    fc.assert(fc.property(textArb, (s) => {
      const out = Code.decodeHtmlEntities_(s);
      expect(typeof out).toBe('string');
    }), { numRuns: 100 });
  });

  it('decodeHtmlEntities_ decodes every valid numeric reference exactly', () => {
    fc.assert(fc.property(validCodePointArb, (cp) => {
      const ch = String.fromCodePoint(cp);
      expect(Code.decodeHtmlEntities_(`&#${cp};`)).toBe(ch);
      expect(Code.decodeHtmlEntities_(`&#x${cp.toString(16)};`)).toBe(ch);
    }), { numRuns: 100 });
  });

  it('decodeHtmlEntities_ maps every forbidden numeric reference to U+FFFD', () => {
    fc.assert(fc.property(forbiddenCodePointArb, (cp) => {
      expect(Code.decodeHtmlEntities_(`&#${cp};`)).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_(`&#x${cp.toString(16)};`)).toBe('\uFFFD');
    }), { numRuns: 100 });
  });

  it('parseOgData_ never throws and keeps its output shape over deformed pages', () => {
    fc.assert(fc.property(textArb, textArb, (head, tail) => {
      const html = `<head>${head}</head><body>${tail}</body>`;
      const data = Code.parseOgData_(html, 'https://example.com/dir/page');
      expect(typeof data.title).toBe('string');
      expect(typeof data.image).toBe('string');
      expect(typeof data.description).toBe('string');
      expect(data.description.length).toBeLessThanOrEqual(Code.OG_DESCRIPTION_LIMIT);
      expect(hasLoneSurrogate(data.title)).toBe(false);
      expect(hasLoneSurrogate(data.description)).toBe(false);
    }), { numRuns: 100 });
  });

  it('parseOgData_ extracts well-formed pages identically', () => {
    const pageArb = fc.record({
      title: safeTextArb(40),
      desc: safeTextArb(60),
      img: safeTextArb(20),
    });
    fc.assert(fc.property(pageArb, ({ title, desc, img }) => {
      const image = `https://example.com/${img.replace(/\s+/g, '-')}.jpg`;
      const html = '<head>'
        + `<meta property="og:title" content="${title}">`
        + `<meta property="og:image" content="${image}">`
        + `<meta property="og:description" content="${desc}">`
        + '</head>';
      const data = Code.parseOgData_(html, 'https://example.com/page');
      expect(data).toEqual({ title, image, description: desc });
    }), { numRuns: 100 });
  });

  it('collectDocUrlsFromText_ returns a deduped, order-preserving subsequence of URL lines', () => {
    const lineArb = fc.oneof(
      fc.constantFrom('https://example.com/a', 'https://example.com/b', 'http://example.org/c'),
      fc.constantFrom('ただの文章', 'see https://example.com/a for details', '', '  '),
      fc.constantFrom('  https://example.com/a  ', '\thttps://example.com/b\t'),
    );
    fc.assert(fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
      const out = Code.collectDocUrlsFromText_(lines.join('\n'));
      expect(new Set(out).size).toBe(out.length);
      out.forEach((u) => expect(u).toMatch(/^https?:\/\/\S+$/));
      const trimmed = lines.map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l));
      expect(out).toEqual([...new Set(trimmed)]);
    }), { numRuns: 100 });
  });

  it('resolveUrl_ never throws for string inputs and passes absolute URLs through', () => {
    fc.assert(fc.property(textArb, (rel) => {
      const out = Code.resolveUrl_(rel, 'https://example.com/dir/page');
      expect(typeof out).toBe('string');
    }), { numRuns: 100 });
    const absoluteArb = fc.tuple(
      fc.constantFrom('https://', 'http://', 'HTTPS://'),
      safeTextArb(20),
    ).map(([scheme, rest]) => `${scheme}example.com/${rest.replace(/\s+/g, '')}`);
    fc.assert(fc.property(absoluteArb, (abs) => {
      expect(Code.resolveUrl_(abs, 'https://example.com/dir/page')).toBe(abs);
    }), { numRuns: 100 });
  });

  it('charset helpers never throw and only return known charsets', () => {
    const known = [null, 'Shift_JIS', 'EUC-JP', 'ISO-2022-JP', 'UTF-8'];
    fc.assert(fc.property(fc.string(), (s) => {
      expect(known).toContain(Code.normalizeCharset_(s));
      expect(known).toContain(Code.sniffCharset_(s));
    }), { numRuns: 100 });
  });

  it('listDataDescription_ never throws over the JSON domain and invents no price from deformed cells', () => {
    const itemArb = fc.record(
      { price: jsonDomainArb, unit: jsonDomainArb, props: jsonDomainArb },
      { requiredKeys: [] },
    );
    fc.assert(fc.property(itemArb, (item) => {
      const out = Code.listDataDescription_(item);
      expect(typeof out).toBe('string');
      expect(hasLoneSurrogate(out)).toBe(false);
    }), { numRuns: 100 });

    const deformedPriceArb = fc.oneof(
      fc.boolean(),
      fc.array(fc.jsonValue(), { maxLength: 3 }),
      fc.object(),
      fc.constant(null),
      fc.constant({ toString: [] }),
    );
    fc.assert(fc.property(deformedPriceArb, (price) => {
      const out = Code.listDataDescription_({ price, unit: 2, props: '' });
      expect(out).not.toContain('¥');
      expect(out).not.toContain('×');
    }), { numRuns: 100 });

    fc.assert(fc.property(
      fc.integer({ min: 1, max: 999999999 }),
      fc.integer({ min: 2, max: 99 }),
      (price, unit) => {
        const out = Code.listDataDescription_({ price, unit, props: '' });
        expect(out).toBe(`¥${price.toLocaleString('ja-JP')} ×${unit}`);
      },
    ), { numRuns: 100 });
  });

  it('doGet answers a urls batch with exactly one entry per distinct valid URL', () => {
    mockCache.getAll.mockImplementation((keys) => Object.fromEntries(
      keys.map((k) => [k, JSON.stringify({ title: 'T', image: 'https://example.com/i.jpg', description: 'D' })]),
    ));
    const urlArb = fc.tuple(
      fc.constantFrom('https://', 'HTTPS://', 'http://'),
      fc.integer({ min: 0, max: 999 }),
    ).map(([scheme, n]) => `${scheme}example.com/item-${n}`);
    fc.assert(fc.property(fc.array(urlArb, { minLength: 1, maxLength: 30 }), (urls) => {
      const out = Code.doGet({ parameter: { urls: urls.join('|') } });
      const parsed = JSON.parse(out.text);
      expect(Object.keys(parsed.results).sort()).toEqual([...new Set(urls)].sort());
    }), { numRuns: 100 });
  });
});
