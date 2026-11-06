/**
 * ogp-api-gas: a small OGP lookup service shared by the sites.
 *
 * - GET ?url=<url> returns { url, title, image, description } as JSON.
 *   OG data is referenced by URL (never copied), cached for 6 hours in
 *   CacheService, and fetched in parallel batches under a time budget,
 *   so a slow or hanging host can never stall a caller for long.
 * - warmOgCache() (run every 6 hours by a time trigger) scans the Docs
 *   in the folders listed in the WARM_FOLDER_IDS script property and
 *   pre-resolves every standalone link, keeping the cache warm so
 *   callers such as blog-gas almost always hit the cache.
 * - URLs that appear in the user's own List of stuff data (the
 *   LIST_DATA_URL script property, list-of-stuff-gas) are answered
 *   from that data before any page is fetched: the sheet already
 *   carries the title and image, and the card description is built
 *   from the price, unit count and the user's own comment. That data
 *   is the user's own record (already public on /list-of-stuff), and
 *   images are still only referenced by URL, never copied.
 * - Page bodies are decoded with the charset the page itself declares
 *   (HTTP header first, then the meta tag). Rakuten Ichiba pages are
 *   Shift_JIS while their headers do not say so, and the default
 *   UrlFetch text decoding garbles them (verified 2026-11-06).
 */
export const OG_CACHE_TTL = 21600; // 6 hours: the CacheService maximum
export const OG_FAILURE_CACHE_TTL = 600;
export const OG_DESCRIPTION_LIMIT = 140;
export const OG_SCAN_LIMIT = 200000;
export const OG_FETCH_BATCH_SIZE = 20;
export const OG_API_BUDGET_MS = 40000;
export const OG_WARM_BUDGET_MS = 300000; // stay under the 6-minute trigger cap
export const OG_POST_MAX_URLS = 100;
export const LIST_DATA_CACHE_KEY = 'list-data:map';
export const LIST_DATA_CACHE_TTL = 3600; // list data changes rarely; 1 hour is plenty

export const log_ = (msg) => {
  console.log(msg);
};

export const json_ = (obj) => ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);

export const jsonError_ = (error) => json_({ error });

/** -----------------------------
 *  OG data resolution (cache + batched fetch)
 *  ----------------------------- */
export const ogCacheKey_ = (url) => {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, Utilities.newBlob(url).getBytes())
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  return `og:${digest}`;
};

export const decodeHtmlEntities_ = (s) => String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
  if (body[0] === '#') {
    const code = (body[1] === 'x' || body[1] === 'X')
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  }
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return Object.prototype.hasOwnProperty.call(named, body) ? named[body] : whole;
});

const metaContent_ = (tag, attrName) => {
  const re = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"|${attrName}\\s*=\\s*'([^']*)'`, 'i');
  const m = String(tag).match(re);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
};

export const resolveUrl_ = (maybeRelative, pageUrl) => {
  const url = String(maybeRelative || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const originMatch = String(pageUrl).match(/^(https?:\/\/[^/]+)/i);
  if (!originMatch) return url;
  if (url.startsWith('//')) return `${originMatch[1].split(':')[0]}:${url}`;
  if (url.startsWith('/')) return `${originMatch[1]}${url}`;
  return `${originMatch[1]}/${url}`;
};

export const parseOgData_ = (html, pageUrl) => {
  const head = String(html || '').slice(0, OG_SCAN_LIMIT).split(/<\/head>/i)[0];
  const metas = {};
  const tagRe = /<meta\s+[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRe.exec(head)) !== null) {
    const tag = tagMatch[0];
    const key = (metaContent_(tag, 'property') || metaContent_(tag, 'name') || '').toLowerCase();
    const content = metaContent_(tag, 'content');
    if (key && content && !(key in metas)) metas[key] = decodeHtmlEntities_(content);
  }
  let title = metas['og:title'] || metas['twitter:title'] || '';
  if (!title) {
    const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = decodeHtmlEntities_(titleMatch[1].replace(/\s+/g, ' ').trim());
  }
  const image = resolveUrl_(metas['og:image'] || metas['twitter:image'] || '', pageUrl);
  const description = (metas['og:description'] || metas.description || '').slice(0, OG_DESCRIPTION_LIMIT);
  return { title, image, description };
};

/** -----------------------------
 *  Charset-aware body decoding
 *  ----------------------------- */
export const normalizeCharset_ = (raw) => {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (s.includes('shift_jis') || s.includes('shift-jis') || s.includes('sjis') || s.includes('windows-31j') || s.includes('x-sjis')) return 'Shift_JIS';
  if (s.includes('euc-jp') || s.includes('eucjp')) return 'EUC-JP';
  if (s.includes('iso-2022-jp')) return 'ISO-2022-JP';
  if (s.includes('utf-8') || s.includes('utf8')) return 'UTF-8';
  return null;
};

export const sniffCharset_ = (headText) => {
  const m = String(headText || '').match(/charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i);
  return m ? normalizeCharset_(m[1]) : null;
};

export const headerCharset_ = (res) => {
  try {
    const headers = (res && res.getHeaders && res.getHeaders()) || {};
    return normalizeCharset_(headers['Content-Type'] || headers['content-type'] || '');
  } catch (e) {
    return null;
  }
};

export const decodeBody_ = (blob, headerCharset) => {
  try {
    let charset = normalizeCharset_(headerCharset) || null;
    if (!charset) {
      let probe = '';
      try { probe = blob.getDataAsString('UTF-8').slice(0, OG_SCAN_LIMIT); } catch (e) { /* ignore */ }
      charset = sniffCharset_(probe);
    }
    return blob.getDataAsString(charset || 'UTF-8');
  } catch (e) {
    try { return blob.getDataAsString('UTF-8'); } catch (e2) { return ''; }
  }
};

/** -----------------------------
 *  List of stuff data source: the user's own possessions list,
 *  served as JSON by list-of-stuff-gas (LIST_DATA_URL property).
 *  ----------------------------- */
export const listDataDescription_ = (item) => {
  const parts = [];
  const price = Number(item && item.price);
  if (price > 0) {
    let head = `¥${price.toLocaleString('ja-JP')}`;
    const unit = Number(item && item.unit);
    if (unit > 1) head += ` ×${unit}`;
    parts.push(head);
  }
  const comment = String((item && item.comment) || '').trim();
  if (comment) parts.push(comment);
  return parts.join(' ').slice(0, OG_DESCRIPTION_LIMIT);
};

export const fetchListDataMap_ = () => {
  const base = PropertiesService.getScriptProperties().getProperty('LIST_DATA_URL');
  if (!base) return null;
  const cache = CacheService.getScriptCache();
  try {
    const raw = cache.get(LIST_DATA_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through and fetch */ }
  const res = UrlFetchApp.fetch(base, { muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`List data returned ${code}`);
  const items = JSON.parse(res.getContentText());
  const map = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || !item.url || !item.title) return;
    map[String(item.url)] = {
      title: String(item.title || ''),
      image: String(item.image || ''),
      description: listDataDescription_(item),
    };
  });
  try {
    cache.put(LIST_DATA_CACHE_KEY, JSON.stringify(map), LIST_DATA_CACHE_TTL);
  } catch (e) { /* map can exceed the cache value limit; use it uncached */ }
  return map;
};

export const resolveOgData_ = (urls, budgetMs = OG_API_BUDGET_MS) => {
  const result = {};
  try {
    if (!urls.length) return result;
    const cache = CacheService.getScriptCache();
    const keys = urls.map(ogCacheKey_);
    const cached = cache.getAll(keys) || {};
    const misses = [];
    urls.forEach((url, idx) => {
      const raw = cached[keys[idx]];
      if (raw) {
        try {
          result[url] = JSON.parse(raw);
          return;
        } catch (e) { /* fall through and refetch */ }
      }
      misses.push(url);
    });
    if (!misses.length) return result;

    // Fetch in batches under an overall time budget. One fetchAll over
    // every miss makes the caller hostage to the slowest or hanging
    // host, and when a giant batch throws, the per-URL fallback turns
    // serial (hundreds of links then blow the execution limit — seen
    // 2026-11-06 with a 203-link article). Batching contains a failure
    // to its batch; once the budget is spent the rest are
    // failure-cached without fetching, so this always finishes.
    const deadline = Date.now() + budgetMs;
    const storeResult_ = (url, data) => {
      if (data && (data.title || data.image)) {
        result[url] = data;
        try { cache.put(ogCacheKey_(url), JSON.stringify(data), OG_CACHE_TTL); } catch (e) { /* ignore */ }
      } else {
        // No usable OG data (or the fetch failed / was skipped):
        // remember briefly so repeated lookups do not refetch at once.
        try { cache.put(ogCacheKey_(url), JSON.stringify({}), OG_FAILURE_CACHE_TTL); } catch (e) { /* ignore */ }
      }
    };
    // The user's own List of stuff data answers first: exact URL
    // matches resolve instantly, with no page fetch at all. Anything
    // not in the list falls through to the batched page fetch below.
    let fetchMisses = misses;
    try {
      const listMap = fetchListDataMap_();
      if (listMap) {
        fetchMisses = [];
        misses.forEach((url) => {
          const d = listMap[url];
          if (d && (d.title || d.image)) {
            storeResult_(url, d);
          } else {
            fetchMisses.push(url);
          }
        });
        if (!fetchMisses.length) return result;
      }
    } catch (e) {
      log_(`List data lookup failed: ${e.message}`);
      fetchMisses = misses;
    }
    for (let b = 0; b < fetchMisses.length; b += OG_FETCH_BATCH_SIZE) {
      const batch = fetchMisses.slice(b, b + OG_FETCH_BATCH_SIZE);
      if (Date.now() > deadline) {
        log_(`OG resolve budget exceeded: skipping ${batch.length} URL(s)`);
        batch.forEach((url) => storeResult_(url, null));
        continue;
      }
      const requests = batch.map((url) => ({
        url,
        headers: {
          Range: 'bytes=0-65535',
          'User-Agent': 'Mozilla/5.0 (compatible; ogp-api link-card)',
        },
        muteHttpExceptions: true,
        followRedirects: true,
      }));
      let responses = [];
      try {
        responses = UrlFetchApp.fetchAll(requests) || [];
      } catch (e) {
        // One unreachable URL can make the whole batch throw. Fall
        // back to per-URL fetches for this batch only, still budgeted.
        log_(`OG fetchAll failed: ${e.message}`);
        responses = requests.map((req) => {
          if (Date.now() > deadline) return null;
          try {
            return UrlFetchApp.fetch(req.url, req);
          } catch (fetchError) {
            log_(`OG fetch failed: ${req.url} (${fetchError.message})`);
            return null;
          }
        });
      }
      batch.forEach((url, i) => {
        let data = null;
        try {
          const res = responses[i];
          if (res && res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
            data = parseOgData_(decodeBody_(res.getBlob(), headerCharset_(res)), url);
            if (data && !data.title && !data.image) log_(`OG no data: ${url}`);
          } else if (res) {
            log_(`OG fetch status ${res.getResponseCode()}: ${url}`);
          }
        } catch (e) {
          data = null;
        }
        storeResult_(url, data);
      });
    }
    return result;
  } catch (e) {
    log_(`OG resolve failed: ${e.message}`);
    return result;
  }
};

/** -----------------------------
 *  Cache warming: scan the configured folders' Docs for standalone
 *  links and resolve them all, every 6 hours (the cache TTL).
 *  ----------------------------- */
/**
 * Decide whether a paragraph is a standalone link, from its text runs
 * ([{ content, linkUrl }]). This mirrors what blog-gas extracts with
 * DocumentApp, but works on the Docs API JSON shape instead:
 * DocumentApp.openById demands the full documents scope, while the
 * Docs API read endpoints are satisfied by documents.readonly, which
 * is all this read-only warmer should need (verified 2026-11-07:
 * warmOgCache scanned 54 docs and opened none of them).
 */
export const standaloneLinkUrlFromRuns_ = (runs) => {
  let text = '';
  let linkUrl = null;
  let hasUnlinkedText = false;
  (runs || []).forEach((run) => {
    const chunk = String((run && run.content) || '');
    if (!chunk) return;
    text += chunk;
    if (!chunk.trim()) return;
    const link = (run && run.linkUrl) || null;
    if (!link) {
      hasUnlinkedText = true;
    } else if (linkUrl && linkUrl !== link) {
      linkUrl = '';
      hasUnlinkedText = true;
    } else {
      linkUrl = link;
    }
  });
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!hasUnlinkedText && linkUrl && trimmed === linkUrl && /^https?:\/\//.test(linkUrl)) return linkUrl;
  if (!linkUrl && /^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  return null;
};

export const fetchDocumentJson_ = (docId) => {
  const res = UrlFetchApp.fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?fields=body.content`,
    {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    },
  );
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`Docs API returned ${code} for doc ${docId}`);
  return JSON.parse(res.getContentText());
};

export const collectDocUrls_ = (doc) => {
  const urls = [];
  const content = (doc && doc.body && doc.body.content) || [];
  content.forEach((el) => {
    if (!el || !el.paragraph) return;
    const runs = (el.paragraph.elements || []).map((pe) => {
      const tr = pe && pe.textRun;
      if (!tr) return null;
      const link = tr.textStyle && tr.textStyle.link;
      return { content: tr.content || '', linkUrl: (link && link.url) || null };
    }).filter(Boolean);
    const url = standaloneLinkUrlFromRuns_(runs);
    if (url && !urls.includes(url)) urls.push(url);
  });
  return urls;
};

export const warmFolderIds_ = () => {
  const raw = PropertiesService.getScriptProperties().getProperty('WARM_FOLDER_IDS') || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

export const collectWarmUrls_ = () => {
  const urls = [];
  warmFolderIds_().forEach((folderId) => {
    const files = DriveApp.getFolderById(folderId).getFilesByType(MimeType.GOOGLE_DOCS);
    while (files.hasNext()) {
      const file = files.next();
      try {
        collectDocUrls_(fetchDocumentJson_(file.getId())).forEach((url) => {
          if (!urls.includes(url)) urls.push(url);
        });
      } catch (e) {
        log_(`Warm scan failed for doc ${file.getId()}: ${e.message}`);
      }
    }
  });
  return urls;
};

export const warmOgCache = () => {
  const urls = collectWarmUrls_();
  log_(`Warm targets: ${urls.length}`);
  const resolved = resolveOgData_(urls, OG_WARM_BUDGET_MS);
  log_(`Warm resolved: ${Object.keys(resolved).length}/${urls.length}`);
};

export const setupWarmTrigger = () => {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach((t) => {
    if (t.getHandlerFunction() === 'warmOgCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmOgCache').timeBased().everyHours(6).create();
  log_('Warm trigger installed (every 6 hours)');
};

/** -----------------------------
 *  Web API: GET ?url=<url>  or  GET ?urls=<url>|<url>|...
 *  ----------------------------- */
export const doGet = (e) => {
  const params = (e && e.parameter) || {};
  if (params.urls) {
    const urls = [...new Set(String(params.urls).split('|').map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u)))].slice(0, OG_POST_MAX_URLS);
    if (!urls.length) return jsonError_('urls parameter is required');
    const data = resolveOgData_(urls);
    const results = {};
    Object.keys(data).forEach((url) => {
      const d = data[url];
      if (d && (d.title || d.image)) {
        results[url] = { title: d.title || '', image: d.image || '', description: d.description || '' };
      }
    });
    return json_({ results });
  }
  const url = String(params.url || '').trim();
  if (!/^https?:\/\//.test(url)) return jsonError_('url parameter is required');
  const data = resolveOgData_([url])[url] || {};
  return json_({ url, title: data.title || '', image: data.image || '', description: data.description || '' });
};

/**
 * Batch lookup for callers converting documents with many links:
 * POST a JSON body { "urls": ["https://...", ...] } and get back
 * { "results": { url: { title, image, description } } }.
 * One HTTP round trip per batch keeps GAS-to-GAS overhead low, and
 * URLs with no usable OG data are simply absent from the results.
 */
export const doPost = (e) => {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const urls = (Array.isArray(body.urls) ? body.urls : [])
      .map((u) => String(u || '').trim())
      .filter((u) => /^https?:\/\//.test(u));
    if (!urls.length) return jsonError_('urls array is required');
    const data = resolveOgData_([...new Set(urls)].slice(0, OG_POST_MAX_URLS));
    const results = {};
    Object.keys(data).forEach((url) => {
      const d = data[url];
      if (d && (d.title || d.image)) {
        results[url] = { title: d.title || '', image: d.image || '', description: d.description || '' };
      }
    });
    return json_({ results });
  } catch (err) {
    return jsonError_(`invalid request: ${err.message}`);
  }
};
