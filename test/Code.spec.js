import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// Mock GAS Globals
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

const mockDocumentApp = {
  openById: vi.fn(),
  ElementType: { PARAGRAPH: 'PARAGRAPH', TEXT: 'TEXT' },
  Attribute: { LINK_URL: 'LINK_URL' },
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
global.DocumentApp = mockDocumentApp;
global.PropertiesService = mockPropertiesService;
global.Utilities = mockUtilities;
global.MimeType = mockMimeType;
global.UrlFetchApp = mockUrlFetchApp;
global.ScriptApp = mockScriptApp;
global.console = { log: vi.fn(), error: vi.fn() };

const ogHtml = (title = 'Example Title') => `<html><head>
<meta property="og:title" content="${title}">
<meta property="og:image" content="https://example.com/og.jpg">
<meta property="og:description" content="Example description">
</head><body></body></html>`;

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

describe('ogp-api-gas Code.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheService.getScriptCache.mockReturnValue(mockCache);
    mockCache.getAll.mockReturnValue({});
    mockProperties.getProperty.mockReturnValue(null);
  });

  describe('parseOgData_', () => {
    it('extracts og title, image and description', () => {
      const data = Code.parseOgData_(ogHtml(), URL_A);
      expect(data).toEqual({
        title: 'Example Title',
        image: 'https://example.com/og.jpg',
        description: 'Example description',
      });
    });

    it('falls back to the title tag and resolves relative image URLs', () => {
      const html = '<html><head><title>Plain Title</title><meta property="og:image" content="/img.jpg"></head></html>';
      const data = Code.parseOgData_(html, 'https://example.com/dir/page');
      expect(data.title).toBe('Plain Title');
      expect(data.image).toBe('https://example.com/img.jpg');
    });
  });

  describe('charset handling', () => {
    it('normalizes common charset names', () => {
      expect(Code.normalizeCharset_('Shift_JIS')).toBe('Shift_JIS');
      expect(Code.normalizeCharset_('text/html; charset=windows-31j')).toBe('Shift_JIS');
      expect(Code.normalizeCharset_('EUC-JP')).toBe('EUC-JP');
      expect(Code.normalizeCharset_('utf8')).toBe('UTF-8');
      expect(Code.normalizeCharset_('')).toBeNull();
      expect(Code.normalizeCharset_('unknown-xyz')).toBeNull();
    });

    it('sniffs the charset from a meta tag', () => {
      expect(Code.sniffCharset_('<meta charset="Shift_JIS">')).toBe('Shift_JIS');
      expect(Code.sniffCharset_('<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">')).toBe('EUC-JP');
      expect(Code.sniffCharset_('<title>no meta</title>')).toBeNull();
    });

    it('decodeBody_ decodes with the meta charset when the header has none', () => {
      const sjisText = `<html><head><meta charset="Shift_JIS"><meta property="og:title" content="正しい題名"></head></html>`;
      const blob = blobOf({ 'UTF-8': '<html><head><meta charset="Shift_JIS"></head></html>', 'Shift_JIS': sjisText });
      const decoded = Code.decodeBody_(blob, '');
      expect(blob.getDataAsString).toHaveBeenCalledWith('Shift_JIS');
      expect(decoded).toContain('正しい題名');
    });

    it('decodeBody_ prefers the HTTP header charset over the meta tag', () => {
      const blob = blobOf({ 'UTF-8': '<html><head><meta charset="Shift_JIS"></head></html>' });
      Code.decodeBody_(blob, 'text/html; charset=UTF-8');
      expect(blob.getDataAsString).toHaveBeenCalledTimes(1);
      expect(blob.getDataAsString).toHaveBeenCalledWith('UTF-8');
    });
  });

  describe('resolveOgData_', () => {
    beforeEach(() => {
      mockUrlFetchApp.fetchAll.mockReset();
      mockUrlFetchApp.fetch.mockReset();
    });

    it('returns an empty map for no URLs', () => {
      expect(Code.resolveOgData_([])).toEqual({});
      expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
    });

    it('uses cached data without fetching', () => {
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached', image: '', description: '' }),
      });
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A].title).toBe('Cached');
      expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
    });

    it('fetches a miss, decodes the body and caches it for 6 hours', () => {
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) })]);
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A].title).toBe('Example Title');
      expect(mockCache.put).toHaveBeenCalledWith(
        Code.ogCacheKey_(URL_A),
        expect.stringContaining('Example Title'),
        Code.OG_CACHE_TTL,
      );
    });

    it('decodes a Shift_JIS page correctly end to end', () => {
      const sjisHtml = `<html><head><meta charset="Shift_JIS"><meta property="og:title" content="楽天の商品"></head></html>`;
      const blob = blobOf({ 'UTF-8': '<meta charset="Shift_JIS">', 'Shift_JIS': sjisHtml });
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ blob })]);
      expect(Code.resolveOgData_([URL_A])[URL_A].title).toBe('楽天の商品');
    });

    it('caches failures briefly on HTTP errors', () => {
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ code: 404, blob: blobOf({}) })]);
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A]).toBeUndefined();
      expect(mockCache.put).toHaveBeenCalledWith(
        Code.ogCacheKey_(URL_A),
        JSON.stringify({}),
        Code.OG_FAILURE_CACHE_TTL,
      );
    });

    it('fetches misses in batches of OG_FETCH_BATCH_SIZE', () => {
      const urls = Array.from({ length: Code.OG_FETCH_BATCH_SIZE + 5 }, (_, i) => `https://example.com/item-${i}`);
      mockUrlFetchApp.fetchAll.mockImplementation((requests) => requests.map(() => responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) })));
      const result = Code.resolveOgData_(urls);
      expect(mockUrlFetchApp.fetchAll).toHaveBeenCalledTimes(2);
      expect(mockUrlFetchApp.fetchAll.mock.calls[0][0]).toHaveLength(Code.OG_FETCH_BATCH_SIZE);
      expect(mockUrlFetchApp.fetchAll.mock.calls[1][0]).toHaveLength(5);
      expect(Object.keys(result)).toHaveLength(urls.length);
    });

    it('contains a throwing batch to that batch only', () => {
      const urls = Array.from({ length: Code.OG_FETCH_BATCH_SIZE + 1 }, (_, i) => `https://example.com/item-${i}`);
      let call = 0;
      mockUrlFetchApp.fetchAll.mockImplementation((requests) => {
        call += 1;
        if (call === 1) throw new Error('batch aborted');
        return requests.map(() => responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) }));
      });
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ code: 500, blob: blobOf({}) }));
      const result = Code.resolveOgData_(urls);
      expect(result[urls[0]]).toBeUndefined();
      expect(result[urls[Code.OG_FETCH_BATCH_SIZE]].title).toBe('Example Title');
    });

    it('stops fetching once the time budget is spent', () => {
      const urls = Array.from({ length: Code.OG_FETCH_BATCH_SIZE + 5 }, (_, i) => `https://example.com/item-${i}`);
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValue(1000 + Code.OG_API_BUDGET_MS + 1);
      try {
        expect(Code.resolveOgData_(urls)).toEqual({});
        expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('list data source', () => {
    const LIST_URL = 'https://script.google.com/macros/s/LIST/exec';
    const sheetItem = {
      title: 'シートの商品', image: 'https://example.com/sheet.jpg', url: URL_A,
      price: 1500, unit: 2, genre: '服', comment: 'ブラック',
    };

    beforeEach(() => {
      mockUrlFetchApp.fetchAll.mockReset();
      mockUrlFetchApp.fetch.mockReset();
      mockCache.get.mockReturnValue(null);
      mockProperties.getProperty.mockImplementation((k) => (k === 'LIST_DATA_URL' ? LIST_URL : null));
    });

    it('builds card descriptions from price, unit and comment', () => {
      expect(Code.listDataDescription_(sheetItem)).toBe('¥1,500 ×2 ブラック');
      expect(Code.listDataDescription_({ ...sheetItem, unit: 1 })).toBe('¥1,500 ブラック');
      expect(Code.listDataDescription_({ ...sheetItem, price: 0, comment: '' })).toBe('');
    });

    it('answers a miss from the list data without fetching any page', () => {
      mockUrlFetchApp.fetch.mockImplementation((url) => {
        if (url === LIST_URL) return responseOf({ text: JSON.stringify([sheetItem]) });
        throw new Error(`unexpected fetch: ${url}`);
      });
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A]).toEqual({
        title: 'シートの商品', image: 'https://example.com/sheet.jpg', description: '¥1,500 ×2 ブラック',
      });
      expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
      expect(mockCache.put).toHaveBeenCalledWith(
        Code.ogCacheKey_(URL_A), expect.stringContaining('シートの商品'), Code.OG_CACHE_TTL,
      );
    });

    it('falls through to page fetching for URLs not in the list', () => {
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ text: JSON.stringify([sheetItem]) }));
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) })]);
      const result = Code.resolveOgData_(['https://example.com/not-in-list']);
      expect(result['https://example.com/not-in-list'].title).toBe('Example Title');
      expect(mockUrlFetchApp.fetchAll).toHaveBeenCalledTimes(1);
    });

    it('fetchListDataMap_ returns null when the property is not set', () => {
      mockProperties.getProperty.mockReturnValue(null);
      expect(Code.fetchListDataMap_()).toBeNull();
      expect(mockUrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('falls back to page fetching when the list data cannot be loaded', () => {
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ code: 500, text: 'err' }));
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) })]);
      const result = Code.resolveOgData_([URL_A]);
      expect(result[URL_A].title).toBe('Example Title');
    });
  });

  describe('doGet', () => {
    it('rejects a missing url parameter', () => {
      const out = Code.doGet({ parameter: {} });
      expect(JSON.parse(out.text)).toEqual({ error: 'url parameter is required' });
    });

    it('returns the OG data for a url', () => {
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached', image: 'https://example.com/i.jpg', description: 'D' }),
      });
      const out = Code.doGet({ parameter: { url: URL_A } });
      expect(JSON.parse(out.text)).toEqual({
        url: URL_A, title: 'Cached', image: 'https://example.com/i.jpg', description: 'D',
      });
      expect(mockUrlFetchApp.fetchAll).not.toHaveBeenCalled();
    });

    it('returns empty fields when no OG data is available', () => {
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ code: 500, blob: blobOf({}) })]);
      const out = Code.doGet({ parameter: { url: URL_A } });
      expect(JSON.parse(out.text)).toEqual({ url: URL_A, title: '', image: '', description: '' });
    });

    it('answers a pipe-separated urls batch in one call', () => {
      const URL_B = 'https://example.com/page-b';
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached A', image: '', description: '' }),
      });
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ code: 404, blob: blobOf({}) })]);
      const out = Code.doGet({ parameter: { urls: `${URL_A}|${URL_B}|not-a-url` } });
      const parsed = JSON.parse(out.text);
      expect(parsed.results[URL_A]).toEqual({ title: 'Cached A', image: '', description: '' });
      expect(parsed.results[URL_B]).toBeUndefined();
    });

    it('rejects an empty urls batch', () => {
      const out = Code.doGet({ parameter: { urls: 'not-a-url' } });
      expect(JSON.parse(out.text)).toEqual({ error: 'urls parameter is required' });
    });
  });

  describe('doPost', () => {
    const postEvent = (body) => ({
      postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) },
    });

    it('rejects a request without urls', () => {
      expect(JSON.parse(Code.doPost(postEvent({})).text)).toEqual({ error: 'urls array is required' });
      expect(JSON.parse(Code.doPost(postEvent('not json')).text).error).toContain('invalid request');
    });

    it('returns results for many urls in one call, omitting ones without data', () => {
      const URL_B = 'https://example.com/page-b';
      mockCache.getAll.mockReturnValue({
        [Code.ogCacheKey_(URL_A)]: JSON.stringify({ title: 'Cached A', image: '', description: '' }),
      });
      mockUrlFetchApp.fetchAll.mockReturnValue([responseOf({ code: 404, blob: blobOf({}) })]);
      const out = Code.doPost(postEvent({ urls: [URL_A, URL_B, 'not-a-url'] }));
      const parsed = JSON.parse(out.text);
      expect(parsed.results[URL_A]).toEqual({ title: 'Cached A', image: '', description: '' });
      expect(parsed.results[URL_B]).toBeUndefined();
    });

    it('fetches misses in one batched resolve', () => {
      mockUrlFetchApp.fetchAll.mockImplementation((requests) => requests.map(() => responseOf({ blob: blobOf({ 'UTF-8': ogHtml() }) })));
      const out = Code.doPost(postEvent({ urls: [URL_A, 'https://example.com/page-b'] }));
      const parsed = JSON.parse(out.text);
      expect(Object.keys(parsed.results)).toHaveLength(2);
      expect(mockUrlFetchApp.fetchAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('warming', () => {
    it('collectDocUrlsFromText_ collects lines that are exactly a URL and dedupes', () => {
      const text = `Title line\n${URL_A}\nsee ${URL_A} for details\n${URL_A}\n  https://example.com/page-b  \n`;
      expect(Code.collectDocUrlsFromText_(text)).toEqual([URL_A, 'https://example.com/page-b']);
    });

    it('collectDocUrlsFromText_ returns nothing for prose without standalone URLs', () => {
      expect(Code.collectDocUrlsFromText_('ただの文章です\nリンクはありません')).toEqual([]);
    });

    it('collectWarmUrls_ reads docs through the web export endpoint and dedupes', () => {
      mockProperties.getProperty.mockImplementation((k) => (k === 'WARM_FOLDER_IDS' ? 'folder-1' : null));
      const files = [{ getId: () => 'doc-1' }];
      let i = 0;
      mockDriveApp.getFolderById.mockReturnValue({
        getFilesByType: () => ({ hasNext: () => i < files.length, next: () => files[i++] }),
      });
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ text: `記事タイトル\n${URL_A}\n本文です\n${URL_A}\n` }));
      expect(Code.collectWarmUrls_()).toEqual([URL_A]);
      const [calledUrl, calledOpts] = mockUrlFetchApp.fetch.mock.calls[0];
      expect(calledUrl).toBe('https://docs.google.com/document/d/doc-1/export?format=txt');
      expect(calledOpts.headers.Authorization).toBe('Bearer test-token');
    });

    it('collectWarmUrls_ skips a doc whose export fails', () => {
      mockProperties.getProperty.mockImplementation((k) => (k === 'WARM_FOLDER_IDS' ? 'folder-1' : null));
      const files = [{ getId: () => 'doc-1' }];
      let i = 0;
      mockDriveApp.getFolderById.mockReturnValue({
        getFilesByType: () => ({ hasNext: () => i < files.length, next: () => files[i++] }),
      });
      mockUrlFetchApp.fetch.mockReturnValue(responseOf({ code: 403, text: 'forbidden' }));
      expect(Code.collectWarmUrls_()).toEqual([]);
    });

    it('setupWarmTrigger replaces existing warm triggers with one 6-hour trigger', () => {
      const old = { getHandlerFunction: () => 'warmOgCache' };
      const other = { getHandlerFunction: () => 'somethingElse' };
      mockScriptApp.getProjectTriggers.mockReturnValue([old, other]);
      const builder = { everyHours: vi.fn().mockReturnThis(), create: vi.fn() };
      const timeBased = vi.fn().mockReturnValue(builder);
      mockScriptApp.newTrigger.mockReturnValue({ timeBased });
      Code.setupWarmTrigger();
      expect(mockScriptApp.deleteTrigger).toHaveBeenCalledTimes(1);
      expect(mockScriptApp.deleteTrigger).toHaveBeenCalledWith(old);
      expect(builder.everyHours).toHaveBeenCalledWith(6);
      expect(builder.create).toHaveBeenCalled();
    });
  });
});
