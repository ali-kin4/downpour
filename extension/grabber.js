'use strict';

/**
 * Downpour link grabber — the picker.
 *
 * Opened in a tab by the service worker after it has injected the collector.
 * The collected list arrives through chrome.storage.session (read via the
 * worker), keyed by the `id` in this page's query string.
 *
 * NOTHING IS QUEUED UNTIL THE USER PRESSES SEND. That is the entire reason
 * this page exists: "grab links" on a busy page can find several hundred
 * URLs, and silently firing all of them at the download manager would be a
 * hostile thing to do.
 *
 * This page holds no protocol knowledge. It asks the worker for the list and
 * hands the worker a list of URLs back; cookies, chunking, the 500-item batch
 * cap and error wording all live in exactly one place, background.js.
 */

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!reply) {
        reject(new Error('No reply from the Downpour service worker.'));
        return;
      }
      if (reply.ok) resolve(reply.data);
      else reject(Object.assign(new Error(reply.error), { kind: reply.kind }));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Kinds
 *
 * Extension-driven, because that is what the user is actually looking for:
 * "the mp4s", "the zips". The element a URL was found in is only a fallback,
 * for the very common case of an <img> or <video> whose URL carries no
 * extension at all (CDN paths, signed URLs, /media/12345).
 * ------------------------------------------------------------------ */

const GROUPS = [
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Images' },
  { id: 'archive', label: 'Archives' },
  { id: 'document', label: 'Documents' },
  { id: 'program', label: 'Programs' },
  { id: 'other', label: 'Other' }
];

const EXT_GROUPS = {
  video: [
    'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv',
    '3gp', '3g2', 'ts', 'm2ts', 'mts', 'vob', 'rmvb', 'm3u8', 'mpd', 'divx'
  ],
  audio: [
    'mp3', 'flac', 'wav', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'm4b', 'wma', 'aiff',
    'aif', 'alac', 'ape', 'mid', 'midi', 'amr', 'ac3', 'dts'
  ],
  image: [
    'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif',
    'tiff', 'heic', 'heif', 'raw', 'cr2', 'nef', 'psd'
  ],
  archive: [
    'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'zst', 'lz', 'lzma',
    'cab', 'arj', 'iso', 'img', 'z', 'ace', 'part'
  ],
  document: [
    'pdf', 'epub', 'mobi', 'azw', 'azw3', 'djvu', 'doc', 'docx', 'odt', 'rtf', 'txt',
    'md', 'xls', 'xlsx', 'ods', 'csv', 'tsv', 'ppt', 'pptx', 'odp', 'json', 'xml',
    'srt', 'vtt', 'sub', 'ass', 'torrent'
  ],
  program: [
    'exe', 'msi', 'msix', 'appx', 'apk', 'aab', 'ipa', 'deb', 'rpm', 'pkg', 'dmg',
    'appimage', 'jar', 'bat', 'cmd', 'sh', 'run', 'bin', 'snap', 'flatpak', 'whl'
  ]
};

const EXT_TO_GROUP = (() => {
  const map = new Map();
  for (const group of Object.keys(EXT_GROUPS)) {
    for (const ext of EXT_GROUPS[group]) map.set(ext, group);
  }
  return map;
})();

/** Element-origin hints from the collector, used only when the extension says nothing. */
const KIND_FALLBACK = { video: 'video', audio: 'audio', image: 'image', background: 'image' };

function extensionOf(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch (_) {
    path = String(url).split(/[?#]/)[0];
  }
  const base = path.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  // Must be short, alphanumeric, and contain at least one letter. The letter
  // test is what stops a version segment from being read as an extension:
  // "app.v1.2" has no extension, it is not a ".2" file. Real extensions with
  // digits in them (7z, mp4, m4a, 3gp) all still qualify.
  if (!/^[a-z0-9]{1,9}$/.test(ext)) return '';
  return /[a-z]/.test(ext) ? ext : '';
}

function fileNameOf(url) {
  try {
    const u = new URL(url);
    const base = (u.pathname.split('/').pop() || '').trim();
    return decodeURIComponent(base) || u.hostname;
  } catch (_) {
    return url;
  }
}

function groupFor(item) {
  const byExt = EXT_TO_GROUP.get(item.ext);
  if (byExt) return byExt;
  const byOrigin = KIND_FALLBACK[item.kind];
  if (byOrigin) return byOrigin;
  return 'other';
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  record: null,
  items: [], // { url, label, kind, ext, group, name, haystack }
  selected: new Set(), // URLs
  shown: [], // URLs passing the current filter, in display order
  kind: 'all',
  ext: 'all',
  query: '',
  regex: false,

  // Live references into the rendered DOM. Selection changes update these in
  // place instead of rebuilding the list: a full re-render of a thousand rows
  // on every checkbox click is both visibly slow and steals keyboard focus.
  rowBoxes: new Map(), // url -> <input type=checkbox>
  groupBoxes: [] // { box, urls }
};

/* ------------------------------------------------------------------ *
 * Load
 * ------------------------------------------------------------------ */

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    fatal('This page was opened without a grab to show. Use “Grab links from this page” from the Downpour popup or the right-click menu.');
    return;
  }

  let record;
  try {
    record = await send({ type: 'getGrab', id });
  } catch (err) {
    fatal(err.message);
    return;
  }

  state.record = record;
  state.items = (record.items || []).map((raw) => {
    const ext = extensionOf(raw.url);
    const name = fileNameOf(raw.url);
    const item = {
      url: raw.url,
      label: raw.label || '',
      kind: raw.kind || 'link',
      ext,
      name
    };
    item.group = groupFor(item);
    item.haystack = (raw.url + ' ' + (raw.label || '')).toLowerCase();
    return item;
  });

  document.title = 'Downpour — ' + state.items.length + ' links grabbed';
  $('pageLabel').textContent = record.pageTitle || record.pageUrl || '';
  $('pageLabel').title = record.pageUrl || '';

  buildKindChips();
  buildExtFilter();
  applyFilter();

  if (record.truncated) {
    note(
      'This page had more links than the grabber collects in one pass — the list was capped. Everything shown is still real.',
      'warn'
    );
  }
}

function fatal(message) {
  $('list').innerHTML = '';
  $('empty').hidden = false;
  $('empty').textContent = message;
  $('send').disabled = true;
}

function note(message, kind) {
  const box = $('sendMsg');
  box.className = 'msg ' + (kind || '');
  box.textContent = message;
  box.hidden = false;
}

/* ------------------------------------------------------------------ *
 * Filter controls
 * ------------------------------------------------------------------ */

function countsByGroup() {
  const counts = new Map();
  for (const item of state.items) counts.set(item.group, (counts.get(item.group) || 0) + 1);
  return counts;
}

function buildKindChips() {
  const counts = countsByGroup();
  const holder = $('kindChips');
  holder.textContent = '';

  const chips = [{ id: 'all', label: 'Everything', n: state.items.length }].concat(
    GROUPS.filter((g) => counts.get(g.id)).map((g) => ({ id: g.id, label: g.label, n: counts.get(g.id) }))
  );

  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (state.kind === chip.id ? ' on' : '');
    btn.dataset.kind = chip.id;
    btn.setAttribute('aria-pressed', String(state.kind === chip.id));
    btn.append(chip.label, badge(String(chip.n)));
    btn.addEventListener('click', () => {
      state.kind = chip.id;
      buildKindChips();
      applyFilter();
    });
    holder.append(btn);
  }
}

function badge(text) {
  const span = document.createElement('span');
  span.className = 'chip-n';
  span.textContent = text;
  return span;
}

function buildExtFilter() {
  const counts = new Map();
  for (const item of state.items) {
    const key = item.ext || '(none)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const select = $('extFilter');
  select.textContent = '';
  select.append(new Option('All extensions (' + state.items.length + ')', 'all'));
  Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([ext, n]) => {
      select.append(new Option((ext === '(none)' ? 'no extension' : '.' + ext) + '  (' + n + ')', ext));
    });
  select.value = state.ext;
}

/**
 * Build the matcher for the search box.
 *
 * An invalid regex is reported inline and treated as "no filter" rather than
 * as "matches nothing": a half-typed pattern should not make the whole list
 * vanish while the user is still typing it.
 */
function buildMatcher() {
  const query = state.query.trim();
  $('filterMsg').hidden = true;
  if (!query) return null;

  if (state.regex) {
    try {
      const re = new RegExp(query, 'i');
      return (item) => re.test(item.url) || re.test(item.label);
    } catch (err) {
      $('filterMsg').textContent = 'Not a valid regular expression: ' + err.message;
      $('filterMsg').hidden = false;
      return null;
    }
  }

  const needle = query.toLowerCase();
  return (item) => item.haystack.includes(needle);
}

function applyFilter() {
  const matcher = buildMatcher();
  const visible = state.items.filter((item) => {
    if (state.kind !== 'all' && item.group !== state.kind) return false;
    if (state.ext !== 'all' && (item.ext || '(none)') !== state.ext) return false;
    if (matcher && !matcher(item)) return false;
    return true;
  });
  state.shown = visible.map((i) => i.url);
  render(visible);
  syncSelectionUi();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(visible) {
  const list = $('list');
  list.textContent = '';
  state.rowBoxes = new Map();
  state.groupBoxes = [];

  if (visible.length === 0) {
    $('empty').hidden = false;
    $('empty').textContent = state.items.length
      ? 'Nothing matches those filters.'
      : 'Nothing downloadable was found on that page.';
    return;
  }
  $('empty').hidden = true;

  // One fragment for the whole list: a page of 1000 rows appended one at a
  // time forces a layout per row.
  const frag = document.createDocumentFragment();

  for (const group of GROUPS) {
    const rows = visible.filter((item) => item.group === group.id);
    if (rows.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'grab-group';

    const head = document.createElement('div');
    head.className = 'grab-group-head';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'group-box';
    box.setAttribute('aria-label', 'Select all ' + group.label.toLowerCase());
    const groupUrls = rows.map((r) => r.url);
    box.addEventListener('change', () => {
      setSelected(groupUrls, box.checked);
    });
    state.groupBoxes.push({ box, urls: groupUrls });

    const title = document.createElement('span');
    title.className = 'grab-group-title';
    title.textContent = group.label;

    head.append(box, title, badge(String(rows.length)));
    section.append(head);

    for (const item of rows) section.append(renderRow(item));
    frag.append(section);
  }

  list.append(frag);
}

/**
 * Push `state.selected` into the rendered checkboxes and the counters.
 * Cheap: it touches only the rows that are currently on screen.
 */
function syncSelectionUi() {
  state.rowBoxes.forEach((box, url) => {
    const on = state.selected.has(url);
    if (box.checked !== on) box.checked = on;
  });
  for (const group of state.groupBoxes) {
    const on = group.urls.filter((u) => state.selected.has(u)).length;
    group.box.checked = on === group.urls.length && on > 0;
    group.box.indeterminate = on > 0 && on < group.urls.length;
  }
  updateCounts();
}

/** Select or deselect a set of URLs and refresh the UI without re-rendering. */
function setSelected(urls, on) {
  for (const url of urls) {
    if (on) state.selected.add(url);
    else state.selected.delete(url);
  }
  syncSelectionUi();
}

function renderRow(item) {
  const row = document.createElement('label');
  row.className = 'grab-row';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(item.url);
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(item.url);
    else state.selected.delete(item.url);
    syncSelectionUi();
  });
  state.rowBoxes.set(item.url, box);

  const main = document.createElement('div');
  main.className = 'grab-row-main';

  const top = document.createElement('div');
  top.className = 'grab-row-title';
  top.textContent = item.label || item.name;
  top.title = item.label || item.name;

  const url = document.createElement('div');
  url.className = 'grab-row-url';
  url.textContent = item.url;
  url.title = item.url;

  main.append(top, url);

  const tag = document.createElement('span');
  tag.className = 'grab-ext';
  tag.textContent = item.ext ? '.' + item.ext : item.kind;

  row.append(box, main, tag);
  return row;
}

function updateCounts() {
  const total = state.items.length;
  const shown = state.shown.length;
  const selected = state.selected.size;

  $('count').textContent =
    selected + ' selected · ' + shown + ' shown' + (shown === total ? '' : ' of ' + total);

  $('send').disabled = selected === 0;
  $('sendSummary').textContent =
    selected === 0 ? 'Nothing selected' : selected === 1 ? '1 link selected' : selected + ' links selected';
}

/* ------------------------------------------------------------------ *
 * Bulk selection — always scoped to what is currently SHOWN, except
 * "select none", which clears everything. Selecting inside a filter and
 * then discovering you also queued the 300 links you had filtered out
 * would be the single worst bug this page could have.
 * ------------------------------------------------------------------ */

$('selectAll').addEventListener('click', () => {
  setSelected(state.shown, true);
});

// "None" is the one bulk action that is NOT scoped to the filter: it is the
// panic button, and "clear the selection" must mean the whole selection.
$('selectNone').addEventListener('click', () => {
  state.selected.clear();
  syncSelectionUi();
});

$('invert').addEventListener('click', () => {
  for (const url of state.shown) {
    if (state.selected.has(url)) state.selected.delete(url);
    else state.selected.add(url);
  }
  syncSelectionUi();
});

/* ------------------------------------------------------------------ *
 * Filter inputs
 * ------------------------------------------------------------------ */

let searchTimer = 0;
$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  // Re-rendering a thousand rows on every keystroke is visible; 120ms is not.
  searchTimer = setTimeout(applyFilter, 120);
});

$('useRegex').addEventListener('change', (e) => {
  state.regex = e.target.checked;
  applyFilter();
});

$('extFilter').addEventListener('change', (e) => {
  state.ext = e.target.value;
  applyFilter();
});

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

$('send').addEventListener('click', async () => {
  const urls = state.items.filter((i) => state.selected.has(i.url)).map((i) => i.url);
  if (urls.length === 0) return;

  const startMode = document.querySelector('input[name="startMode"]:checked').value;
  const button = $('send');
  button.disabled = true;
  note('Sending ' + urls.length + ' links to Downpour…', '');

  try {
    const result = await send({
      type: 'queueGrabbed',
      urls,
      startMode,
      pageUrl: state.record && state.record.pageUrl,
      pageTitle: state.record && state.record.pageTitle
    });

    const accepted = Number(result && result.accepted) || 0;
    const rejected = Number(result && result.rejected) || 0;
    note(
      'Sent ' +
        accepted +
        (accepted === 1 ? ' link' : ' links') +
        ' to Downpour' +
        (startMode === 'start' ? ' and started them.' : ' (added to the queue, not started).') +
        (rejected > 0 ? ' ' + rejected + ' were rejected by the app.' : ''),
      rejected > 0 ? 'warn' : 'ok'
    );

    // Clear what was just queued so a second press cannot double-queue it.
    for (const url of urls) state.selected.delete(url);
    syncSelectionUi();
  } catch (err) {
    note(
      err.message +
        (err.kind === 'offline'
          ? ' Nothing was queued — start Downpour and press Send again; this list stays as it is.'
          : ''),
      'err'
    );
  } finally {
    button.disabled = state.selected.size === 0;
  }
});

load();
