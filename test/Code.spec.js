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
  computeDigest: vi.fn().mockImplementation((algo, bytes) => [bytes.length % 256, (bytes[0] || 0) % 256]),
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

const responseOf = ({ code = 200, headers = {}, blob }) => ({
  getResponseCode: () => code,
  getHeaders: () => headers,
  getBlob: () => blob,
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
  });

  describe('warming', () => {
    const linkPara = (url) => ({
      getType: () => 'PARAGRAPH',
      asParagraph: () => ({
        getNumChildren: () => 1,
        getChild: () => ({
          getType: () => 'TEXT',
          asText: () => ({
            getText: () => url,
            getTextAttributeIndices: () => [0],
            getAttributes: () => ({ LINK_URL: url }),
          }),
        }),
      }),
    });

    it('standaloneLinkUrl_ detects a bare link paragraph', () => {
      const p = linkPara(URL_A).asParagraph();
      expect(Code.standaloneLinkUrl_(p)).toBe(URL_A);
    });

    it('collectWarmUrls_ scans the configured folders and dedupes', () => {
      mockProperties.getProperty.mockImplementation((k) => (k === 'WARM_FOLDER_IDS' ? 'folder-1' : null));
      const files = [{ getId: () => 'doc-1' }];
      let i = 0;
      mockDriveApp.getFolderById.mockReturnValue({
        getFilesByType: () => ({ hasNext: () => i < files.length, next: () => files[i++] }),
      });
      mockDocumentApp.openById.mockReturnValue({
        getBody: () => ({
          getNumChildren: () => 2,
          getChild: () => linkPara(URL_A),
        }),
      });
      expect(Code.collectWarmUrls_()).toEqual([URL_A]);
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
