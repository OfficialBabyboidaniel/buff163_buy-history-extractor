// ─── Constants ───────────────────────────────────────────────────────────────
const API       = 'https://buff.163.com/api/market/buy_order/history';
const GOODS_API = 'https://buff.163.com/api/market/goods/info';
const GAMES     = ['csgo', 'dota2', 'tf2', 'rust'];
const PAGE_SIZE = 20;
const DELAY_MS  = 800;
const MAX_RETRY = 3;

// ─── State ────────────────────────────────────────────────────────────────────
let allOrders  = [];
let goodsCache = {};   // goods_id -> { name, short_name, exterior, quality, ... }
let stopFlag   = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const dot            = document.getElementById('dot');
const statusText     = document.getElementById('status-text');
const statFetched    = document.getElementById('stat-fetched');
const statTotal      = document.getElementById('stat-total');
const statPage       = document.getElementById('stat-page');
const progressBar    = document.getElementById('progress-bar');
const progressLabel  = document.getElementById('progress-label');
const logEl          = document.getElementById('log');
const btnValidate    = document.getElementById('btn-validate');
const btnFetch       = document.getElementById('btn-fetch');
const btnFetchToday  = document.getElementById('btn-fetch-today');
const btnStop        = document.getElementById('btn-stop');
const btnCsv         = document.getElementById('btn-csv');
const btnXlsx        = document.getElementById('btn-xlsx');
const resumeNote     = document.getElementById('resume-note');
const resumeCount    = document.getElementById('resume-count');
const btnDebug       = document.getElementById('btn-debug');
const btnClearCkpt   = document.getElementById('btn-clear-checkpoint');
const btnTrackerCsv  = document.getElementById('btn-tracker-csv');
const btnTrackerCopy = document.getElementById('btn-tracker-copy');

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg, type = '') {
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(state, text) {
  dot.className = 'dot ' + (state === 'ok' ? 'green' : state === 'err' ? 'red' : 'yellow');
  statusText.textContent = text;
}

function updateStats(fetched, total, page) {
  statFetched.textContent = fetched;
  statTotal.textContent   = total ?? '—';
  statPage.textContent    = page  ?? '—';
  if (total) {
    const pct = Math.min(100, Math.round(fetched / total * 100));
    progressBar.style.width   = pct + '%';
    progressLabel.textContent = `${pct}% (${fetched} / ${total})`;
  }
}

function setBusy(busy) {
  btnValidate.disabled     = busy;
  btnFetch.disabled        = busy;
  btnFetchToday.disabled   = busy;
  btnStop.disabled         = !busy;
}

function setExportReady(yes) {
  btnCsv.disabled          = !yes;
  btnXlsx.disabled         = !yes;
  btnDebug.disabled        = !yes;
  btnTrackerCsv.disabled   = !yes;
  btnTrackerCopy.disabled  = !yes;
}

// ─── Cookie helper ────────────────────────────────────────────────────────────
async function getCsrfToken() {
  const cookies = await chrome.cookies.getAll({ domain: 'buff.163.com' });
  const c = cookies.find(c => c.name === 'csrf_token');
  return c ? c.value : '';
}

// ─── API fetch with retry ─────────────────────────────────────────────────────
async function fetchPage(pageNum, game) {
  const csrf = await getCsrfToken();
  const url  = `${API}?page_num=${pageNum}&page_size=${PAGE_SIZE}&game=${game}`;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken':      csrf,
          'Referer':          'https://buff.163.com/market/buy_order/history'
        }
      });

      if (resp.status === 429) {
        log(`Rate limited — waiting 5s (attempt ${attempt})`, 'err');
        await sleep(5000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const json = await resp.json();
      if (json.code !== 'OK') throw new Error(json.error || `API: ${json.code}`);

      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRY) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

// ─── Session validation ───────────────────────────────────────────────────────
async function validateSession() {
  btnValidate.disabled = true;
  setStatus('yellow', 'Validating…');
  log('Checking session…', 'info');
  try {
    // Try csgo first as it's the most common
    const data = await fetchPage(1, 'csgo');
    const total = data.total_count ?? 0;
    setStatus('ok', `Logged in — ${total.toLocaleString()} csgo purchases found`);
    log(`Session valid. ${total} orders in csgo.`, 'ok');
    btnFetch.disabled = false;
    btnFetchToday.disabled = false;
  } catch (e) {
    setStatus('err', 'Not logged in — open buff.163.com and sign in');
    log(`Session invalid: ${e.message}`, 'err');
    btnFetch.disabled = true;
  }
  btnValidate.disabled = false;
}

// ─── Main fetch loop ──────────────────────────────────────────────────────────
async function fetchAllOrders(todayOnly = false) {
  stopFlag  = false;
  allOrders = [];

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Try to restore checkpoint (skip for today-only — we want a clean slate)
  if (!todayOnly) {
    const saved = await loadCheckpoint();
    if (saved.length) {
      allOrders = saved;
      log(`Resumed from checkpoint: ${allOrders.length} orders`, 'info');
    }
  }

  setBusy(true);
  setExportReady(false);
  setStatus('yellow', 'Fetching…');
  log('Starting fetch across all games…', 'info');

  try {
    for (const game of GAMES) {
      if (stopFlag) break;
      log(`--- Game: ${game} ---`, 'info');
      let page = 1;

      while (!stopFlag) {
        log(`Fetching page ${page} (${game})…`);
        const data = await fetchPage(page, game);
        const total = data.total_count ?? 0;

        if (page === 1) log(`${game}: ${total} total orders`, 'ok');

        const items = (data.items || []).map(o => ({ ...o, _game: game }));
        if (!items.length) break;

        if (todayOnly) {
          const todayItems = items.filter(o => {
            const d = o.created_at ? new Date(o.created_at * 1000).toISOString().slice(0, 10) : '';
            return d === todayStr;
          });
          allOrders.push(...todayItems);
          // If any item is older than today, stop paginating this game
          const hasOlder = items.some(o => {
            const d = o.created_at ? new Date(o.created_at * 1000).toISOString().slice(0, 10) : '';
            return d < todayStr;
          });
          if (hasOlder) break;
        } else {
          allOrders.push(...items);
        }
        // Deduplicate by id
        allOrders = [...new Map(allOrders.map(o => [o.id, o])).values()];

        updateStats(allOrders.length, null, page);
        await saveCheckpoint(allOrders);

        const totalPages = data.total_page ?? Math.ceil(total / PAGE_SIZE);
        if (page >= totalPages || !total) break;
        page++;
        await sleep(DELAY_MS);
      }
    }

    if (stopFlag) {
      log(`Stopped — ${allOrders.length} orders saved.`, 'err');
      setStatus('yellow', `Partial: ${allOrders.length} orders`);
    } else {
      log(`Done! ${allOrders.length} total orders. Now fetching item names…`, 'ok');
      await enrichGoodsNames();
      allOrders.reverse(); // oldest first for all exports
      setStatus('ok', `Complete — ${allOrders.length} orders`);
    }
  } catch (e) {
    log(`Error: ${e.message}`, 'err');
    setStatus('err', `Error — ${allOrders.length} orders saved`);
  }

  setBusy(false);
  if (allOrders.length) setExportReady(true);
}

// ─── Goods name enrichment ────────────────────────────────────────────────────
// buy_order/history omits item names; fetch them via goods/info endpoint
async function enrichGoodsNames() {
  let pending = [...new Set(
    allOrders.map(o => o.goods_id || o.asset_info?.goods_id).filter(Boolean)
  )].filter(id => !goodsCache[id]);

  log(`Fetching names for ${pending.length} unique items…`, 'info');
  let done = 0;

  while (pending.length) {
    const id = pending.shift();
    try {
      const csrf = await getCsrfToken();
      const resp = await fetch(`${GOODS_API}?goods_id=${id}`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf }
      });
      if (resp.status === 429) {
        log(`Rate limited — waiting 15s… (${pending.length + 1} remaining)`, 'err');
        pending.unshift(id); // put back at front
        await sleep(15000);
        continue;
      }
      const json = await resp.json();
      if (json.code === 'OK' && json.data) {
        const d = json.data;
        goodsCache[id] = {
          name:       d.name        || d.market_name || d.market_hash_name || '',
          short_name: d.short_name  || '',
        };
      }
    } catch (e) { log(`Name fetch failed for ${id}: ${e.message}`, 'err'); }
    done++;
    if (done % 10 === 0) {
      log(`Names: ${done} done, ${pending.length} remaining`, 'info');
      await chrome.storage.local.set({ goodsCache });
    }
    await sleep(1200);
  }

  await chrome.storage.local.set({ goodsCache });
  const missing = allOrders.filter(o => {
    const id = o.goods_id || o.asset_info?.goods_id;
    return id && !goodsCache[id]?.name;
  }).length;
  log(`Item names loaded. ${missing > 0 ? `⚠️ ${missing} items still missing names.` : 'All names resolved.'}`, missing > 0 ? 'err' : 'ok');
}

// ─── Checkpoint (chrome.storage.local) ───────────────────────────────────────
async function saveCheckpoint(orders) {
  await chrome.storage.local.set({ checkpoint: orders, goodsCache });
}

async function loadCheckpoint() {
  const r = await chrome.storage.local.get(['checkpoint', 'goodsCache']);
  if (r.goodsCache) Object.assign(goodsCache, r.goodsCache);
  return r.checkpoint || [];
}

async function clearCheckpoint() {
  await chrome.storage.local.remove(['checkpoint', 'goodsCache']);
  allOrders = [];
  goodsCache = {};
  resumeNote.style.display = 'none';
  updateStats(0, null, null);
  setExportReady(false);
  log('Checkpoint cleared.', 'info');
}

// ─── Field extraction ─────────────────────────────────────────────────────────
function extractRow(o) {
  const goodsId = o.goods_id || o.asset_info?.goods_id || '';
  const cached  = goodsCache[goodsId] || {};
  const ai      = o.asset_info || {};

  const price = parseFloat(o.price || o.list_page_price || o.real_price) || 0;
  const fee   = parseFloat(o.fee   || o.buyer_fee || o.buff_fee)         || 0;
  const total = parseFloat(o.total_price || o.income) || price;

  return {
    'Order ID':       o.id              || '',
    'Date':           o.created_at ? new Date(o.created_at * 1000).toISOString().replace('T',' ').slice(0,19) : '',
    'Item Name':      cached.name       || '',
    'Short Name':     cached.short_name || '',
    'Game':           o._game           || o.game || '',
    'Float Value':    ai.paintwear      || '',
    'Price (¥)':      price,
    'Currency':       'CNY',
    'Quantity':       o.num             || 1,
    'Buyer Fee (¥)':  fee,
    'Total Cost (¥)': total,
    'Seller ID':      o.seller_id       || '',
    'State':          o.state_text      || o.state || '',
    'Pay Method':     o.pay_method_text || '',
    'Item URL':       goodsId           ? `https://buff.163.com/goods/${goodsId}` : '',
    'Goods ID':       goodsId,
    'Asset ID':       ai.assetid        || o.asset_id || '',
    'Icon URL':       ai.info?.icon_url || '',
  };
}

// ─── CSV export ───────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allOrders.length) return;
  const rows = allOrders.map(extractRow);
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  download('\uFEFF' + csv, 'buff163_purchases.csv', 'text/csv');
  log('CSV exported.', 'ok');
}

// ─── Excel export (SheetJS) ───────────────────────────────────────────────────
function exportXLSX() {
  if (!allOrders.length) return;
  if (typeof XLSX === 'undefined') {
    log('SheetJS not loaded — see README to add lib/xlsx.full.min.js', 'err');
    return;
  }

  const rows = allOrders.map(extractRow);
  const wb   = XLSX.utils.book_new();

  // Sheet 1: Raw orders
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Orders');

  // Sheet 2: Summary
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(rows), 'Summary');

  XLSX.writeFile(wb, 'buff163_purchases.xlsx');
  log('Excel exported.', 'ok');
}

function buildSummarySheet(rows) {
  const prices = rows.map(r => r['Price (¥)']).filter(Boolean);
  const total  = prices.reduce((a, b) => a + b, 0);
  const avg    = prices.length ? total / prices.length : 0;

  // By month
  const byMonth = {};
  const byYear  = {};
  const byItem  = {};

  for (const r of rows) {
    const d = r['Date'];
    if (d) {
      const ym = d.slice(0, 7);
      const y  = d.slice(0, 4);
      byMonth[ym] = (byMonth[ym] || 0) + 1;
      byYear[y]   = (byYear[y]   || 0) + 1;
    }
    const name = r['Item Name'];
    if (name) byItem[name] = (byItem[name] || 0) + 1;
  }

  const topItems = Object.entries(byItem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ 'Item Name': name, 'Purchase Count': count }));

  const summaryData = [
    { Metric: 'Total Purchases',       Value: rows.length },
    { Metric: 'Total Spend (¥)',        Value: +total.toFixed(2) },
    { Metric: 'Average Price (¥)',      Value: +avg.toFixed(2) },
    { Metric: '', Value: '' },
    { Metric: '— By Month —',           Value: '' },
    ...Object.entries(byMonth).sort().map(([m, c]) => ({ Metric: m, Value: c })),
    { Metric: '', Value: '' },
    { Metric: '— By Year —',            Value: '' },
    ...Object.entries(byYear).sort().map(([y, c]) => ({ Metric: y, Value: c })),
    { Metric: '', Value: '' },
    { Metric: '— Top 20 Items —',       Value: '' },
    ...topItems.map(r => ({ Metric: r['Item Name'], Value: r['Purchase Count'] })),
  ];

  return XLSX.utils.json_to_sheet(summaryData);
}

// ─── Tracker export (Skin, CNY, EUR, SEK, Date) ───────────────────────────────
async function getRates() {
  try {
    const resp = await fetch('https://api.frankfurter.app/latest?from=CNY&to=EUR,SEK');
    const json = await resp.json();
    return { eur: json.rates.EUR, sek: json.rates.SEK };
  } catch (e) {
    log('Could not fetch exchange rates — using fallback rates', 'err');
    return { eur: 0.1288, sek: 1.414 };
  }
}

function buildTrackerRows(rates) {
  return allOrders.map(o => {
    const goodsId = o.goods_id || o.asset_info?.goods_id || '';
    const cached  = goodsCache[goodsId] || {};
    const cny     = parseFloat(o.price || o.list_page_price || o.real_price) || 0;
    const date    = o.created_at ? new Date(o.created_at * 1000).toISOString().slice(0, 10) : '';
    return {
      'Skin':              cached.name || '',
      'Buy Price (¥)':     cny,
      'Buy Price (€)':     +(cny * rates.eur).toFixed(2),
      'Buy Price (SEK)':   +(cny * rates.sek).toFixed(2),
      'Buy Date':          date,
    };
  });
}

async function exportTrackerCSV() {
  if (!allOrders.length) return;
  log('Fetching exchange rates…', 'info');
  const rates   = await getRates();
  const rows    = buildTrackerRows(rates);
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  download('\uFEFF' + csv, 'buff163_tracker.csv', 'text/csv');
  log(`Tracker CSV exported (1¥ = €${rates.eur} / ${rates.sek}kr).`, 'ok');
}

async function copyTrackerToClipboard() {
  if (!allOrders.length) return;
  log('Fetching exchange rates…', 'info');
  const rates   = await getRates();
  const rows    = buildTrackerRows(rates);
  const headers = Object.keys(rows[0]);
  const tsv = rows.map(r => headers.map(h => r[h]).join('\t')).join('\n');
  await navigator.clipboard.writeText(tsv);
  log(`${rows.length} rows copied (1¥ = €${rates.eur} / ${rates.sek}kr) — paste into your sheet!`, 'ok');
}

// ─── Download helper ──────────────────────────────────────────────────────────
function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportDebug() {
  if (!allOrders.length) return;
  // Dump first 3 raw orders so we can see the exact field structure
  const sample = JSON.stringify(allOrders.slice(0, 3), null, 2);
  download(sample, 'buff163_raw_sample.json', 'application/json');
}



// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const saved = await loadCheckpoint();
  if (saved.length) {
    allOrders = saved;
    resumeNote.style.display = 'block';
    resumeCount.textContent  = saved.length;
    updateStats(saved.length, null, null);
    setExportReady(true);
    log(`Checkpoint found: ${saved.length} orders available.`, 'info');
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
btnValidate.addEventListener('click', validateSession);
btnFetch.addEventListener('click', () => fetchAllOrders(false));
btnFetchToday.addEventListener('click', () => fetchAllOrders(true));
btnStop.addEventListener('click', () => { stopFlag = true; log('Stopping after current page…', 'err'); });
btnCsv.addEventListener('click', exportCSV);
btnXlsx.addEventListener('click', exportXLSX);
btnDebug.addEventListener('click', exportDebug);
btnClearCkpt.addEventListener('click', clearCheckpoint);
btnTrackerCsv.addEventListener('click', exportTrackerCSV);
btnTrackerCopy.addEventListener('click', copyTrackerToClipboard);

init();
