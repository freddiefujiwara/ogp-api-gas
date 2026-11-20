import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const mockDriveApp = {
  getFolderById: vi.fn(),
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

const mockMimeType = { GOOGLE_DOCS: 'GOOGLE_DOCS' };

const mockUrlFetchApp = {
  fetchAll: vi.fn(),
  fetch: vi.fn(),
};

const mockScriptApp = {
  getProjectTriggers: vi.fn().mockReturnValue([]),
  deleteTrigger: vi.fn(),
  newTrigger: vi.fn(),
  getOAuthToken: vi.fn().mockReturnValue('test-token'),
};

global.CacheService = mockCacheService;
global.ContentService = mockContentService;
global.DriveApp = mockDriveApp;
global.PropertiesService = mockPropertiesService;
global.Utilities = mockUtilities;
global.MimeType = mockMimeType;
global.UrlFetchApp = mockUrlFetchApp;
global.ScriptApp = mockScriptApp;
global.console = { log: vi.fn(), error: vi.fn() };

const blobOf = (byCharset) => ({
  getDataAsString: vi.fn((cs) => byCharset[cs] ?? byCharset['UTF-8'] ?? ''),
});

const responseOf = ({ code = 200, headers = {}, blob, text = '' }) => ({
  getResponseCode: () => code,
  getHeaders: () => headers,
  getBlob: () => blob,
  getContentText: () => text,
});

const URL_A = 'https://example.com/page-a';
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('abnormal cases: ogp-api-gas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheService.getScriptCache.mockReturnValue(mockCache);
    mockCache.getAll.mockReturnValue({});
    mockCache.get.mockReturnValue(null);
    mockProperties.getProperty.mockReturnValue(null);
    mockUrlFetchApp.fetchAll.mockReset();
    mockUrlFetchApp.fetch.mockReset();
  });

  describe('decodeHtmlEntities_ with out-of-range numeric references', () => {
    it('decodes an out-of-range hex reference to U+FFFD instead of throwing', () => {
      expect(Code.decodeHtmlEntities_('&#x110000;')).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_('&#xFFFFFF;')).toBe('\uFFFD');
    });

    it('decodes out-of-range and huge decimal references to U+FFFD instead of throwing', () => {
      expect(Code.decodeHtmlEntities_('&#1114112;')).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_('&#99999999999999999999;')).toBe('\uFFFD');
    });

    it('decodes surrogate references to U+FFFD instead of leaking a lone surrogate', () => {
      expect(Code.decodeHtmlEntities_('&#xD800;')).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_('&#xDFFF;')).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_('&#55296;')).toBe('\uFFFD');
    });

    it('decodes the NUL reference to U+FFFD instead of leaking a NUL character', () => {
      expect(Code.decodeHtmlEntities_('&#0;')).toBe('\uFFFD');
      expect(Code.decodeHtmlEntities_('&#x0;')).toBe('\uFFFD');
    });

    it('still decodes valid references exactly', () => {
      expect(Code.decodeHtmlEntities_('&#x1F600;')).toBe('\u{1F600}');
      expect(Code.decodeHtmlEntities_('&#65;')).toBe('A');
      expect(Code.decodeHtmlEntities_('&amp;&lt;&gt;&quot;&apos;&nbsp;')).toBe('&<>"\' ');
      // Unknown named references and malformed ones stay literal.
      expect(Code.decodeHtmlEntities_('&copy;')).toBe('&copy;');
      expect(Code.decodeHtmlEntities_('&#xZZ;')).toBe('&#xZZ;');
    });

    it('one bad reference in a page does not kill the whole extraction', () => {
      const html = '<head>'
        + '<meta property="og:title" content="a &#x110000; b">'
        + '<meta property="og:image" content="https://example.com/i.jpg">'
        + '<meta property="og:description" content="fine">'
        + '</head>';
      const data = Code.parseOgData_(html, URL_A);
      expect(data.title).toBe('a \uFFFD b');
      expect(data.image).toBe('https://example.com/i.jpg');
      expect(data.description).toBe('fine');
    });
  });

  describe('parseOgData_ with deformed meta tags', () => {
    it('extracts unquoted attribute values', () => {
      const html = '<head><meta property=og:title content=Hello>'
        + '<meta property=og:image content=https://example.com/i.jpg></head>';
      const data = Code.parseOgData_(html, URL_A);
      expect(data.title).toBe('Hello');
      expect(data.image).toBe('https://example.com/i.jpg');
    });

    it('does not truncate a tag at a > inside a quoted attribute value', () => {
      const html = '<head><meta property="og:description" content="a > b">'
        + '<meta property="og:title" content="After"></head>';
      const data = Code.parseOgData_(html, URL_A);
      expect(data.description).toBe('a > b');
      expect(data.title).toBe('After');
    });

    it('handles single quotes, attribute order and uppercase tags (pins)', () => {
      const html = "<HEAD><META CONTENT='Reordered' PROPERTY='og:title'></HEAD>";
      expect(Code.parseOgData_(html, URL_A).title).toBe('Reordered');
    });

    it('keeps the first of duplicate og:title tags (pin)', () => {
      const html = '<head><meta property="og:title" content="First">'
        + '<meta property="og:title" content="Second"></head>';
      expect(Code.parseOgData_(html, URL_A).title).toBe('First');
    });

    it('falls back to the title tag when og:title content is empty (pin)', () => {
      const html = '<head><meta property="og:title" content=""><title>Tag Title</title></head>';
      expect(Code.parseOgData_(html, URL_A).title).toBe('Tag Title');
    });

    it('never splits a surrogate pair at the description limit', () => {
      const desc = `${'a'.repeat(139)}\u{1F600}${'b'.repeat(10)}`;
      const html = `<head><meta property="og:description" content="${desc}"></head>`;
      const data = Code.parseOgData_(html, URL_A);
      expect(data.description.length).toBeLessThanOrEqual(Code.OG_DESCRIPTION_LIMIT);
      expect(hasLoneSurrogate(data.description)).toBe(false);
      // The pair does not fit whole, so it is dropped whole.
      expect(data.description).toBe('a'.repeat(139));
    });

    it('keeps a surrogate pair that fits exactly at the limit (pin)', () => {
      const desc = `${'a'.repeat(138)}\u{1F600}`;
      const html = `<head><meta property="og:description" content="${desc}"></head>`;
      expect(Code.parseOgData_(html, URL_A).description).toBe(desc);
    });
  });

  describe('doGet / doPost with deformed URL parameters', () => {
    it('doGet accepts an uppercase scheme instead of rejecting the URL', () => {
      const upper = 'HTTPS://example.com/page-a';
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(upper)]: JSON.stringify({ title: 'Cached', image: '', description: '' }),
      });
      const out = Code.doGet({ parameter: { url: upper } });
      expect(JSON.parse(out.text)).toEqual({ url: upper, title: 'Cached', image: '', description: '' });
    });

    it('doGet keeps mixed-case scheme entries in a urls batch', () => {
      const upper = 'HTTPS://example.com/page-b';
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(upper)]: JSON.stringify({ title: 'Cached B', image: '', description: '' }),
      });
      const out = Code.doGet({ parameter: { urls: `${upper}` } });
      expect(JSON.parse(out.text).results[upper]).toEqual({ title: 'Cached B', image: '', description: '' });
    });

    it('doPost drops one unstringifiable entry instead of failing the whole batch', () => {
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached A', image: '', description: '' }),
      });
      const body = JSON.stringify({ urls: [{ toString: [] }, URL_A] });
      const out = Code.doPost({ postData: { contents: body } });
      const parsed = JSON.parse(out.text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.results[URL_A]).toEqual({ title: 'Cached A', image: '', description: '' });
    });

    it('doGet dedupes a batch with empty segments and a trailing separator (pin)', () => {
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached A', image: '', description: '' }),
      });
      const out = Code.doGet({ parameter: { urls: `|${URL_A}||${URL_A}|` } });
      expect(Object.keys(JSON.parse(out.text).results)).toEqual([URL_A]);
    });
  });

  describe('list data source with deformed items', () => {
    const LIST_URL = 'https://script.google.com/macros/s/LIST/exec';

    beforeEach(() => {
      mockProperties.getProperty.mockImplementation((k) => (k === 'LIST_DATA_URL' ? LIST_URL : null));
    });

    it('does not invent prices or counts from non-numeric cells', () => {
      expect(Code.listDataDescription_({ price: true, unit: 1, props: '' })).toBe('');
      expect(Code.listDataDescription_({ price: [500], unit: 1, props: '' })).toBe('');
      expect(Code.listDataDescription_({ price: { toString: [] }, unit: 1, props: '' })).toBe('');
      expect(Code.listDataDescription_({ price: 100, unit: [3], props: '' })).toBe('¥100');
      expect(Code.listDataDescription_({ price: 100, unit: true, props: '' })).toBe('¥100');
      // Numeric strings from the sheet still count as numbers (pin).
      expect(Code.listDataDescription_({ price: '1500', unit: '2', props: '' })).toBe('¥1,500 ×2');
    });

    it('reads an unstringifiable or array props value as empty instead of throwing or leaking', () => {
      expect(Code.listDataDescription_({ price: 0, props: { toString: [] } })).toBe('');
      expect(Code.listDataDescription_({ price: 0, props: ['a', 'b'] })).toBe('');
    });

    it('never splits a surrogate pair at the props limit', () => {
      const props = `${'a'.repeat(89)}\u{1F600}bbb`;
      const out = Code.listDataDescription_({ price: 0, props });
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(out).toBe(`${'a'.repeat(89)}…`);
    });

    it('skips a deformed item and still maps the well-formed ones', () => {
      const items = [
        { url: URL_A, title: '良い商品', image: 'https://example.com/ok.jpg', price: 100, unit: 1 },
        { url: 'https://example.com/bad', title: { toString: [] }, image: '' },
        { url: ['https://example.com/arr'], title: '配列URL', image: '' },
      ];
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ text: JSON.stringify(items) }));
      const map = Code.fetchListDataMap_();
      expect(Object.keys(map)).toEqual([URL_A]);
      expect(map[URL_A].title).toBe('良い商品');
    });

    it('still answers from the list source when one item in it is deformed', () => {
      const items = [
        { url: URL_A, title: '良い商品', image: 'https://example.com/ok.jpg', price: 100, unit: 1 },
        { url: 'https://example.com/bad', title: { toString: [] }, image: '' },
      ];
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ text: JSON.stringify(items) }));
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A].title).toBe('良い商品');
      expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
    });
  });

  describe('charset helpers at the boundary (pins)', () => {
    it('decodeBody_ falls back to UTF-8 when the sniffed charset decode throws', () => {
      const blob = {
        getDataAsString: vi.fn((cs) => {
          if (cs === 'Shift_JIS') throw new Error('unsupported');
          return '<html><head><meta charset="Shift_JIS"></head></html>';
        }),
      };
      expect(Code.decodeBody_(blob, '')).toContain('Shift_JIS');
    });

    it('headerCharset_ returns null when reading headers throws', () => {
      const res = { getHeaders: () => { throw new Error('no headers'); } };
      expect(Code.headerCharset_(res)).toBeNull();
      expect(Code.headerCharset_(null)).toBeNull();
    });

    it('decodeBody_ returns an empty string for a null blob', () => {
      expect(Code.decodeBody_(null, '')).toBe('');
    });
  });
});
