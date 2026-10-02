const { analyze, genreTracks, allGenres, parseTitle, extractVideoId, videoInfo } = window.SimilarCore;

const $ = (id) => document.getElementById(id);
const isAndroid = /Android/i.test(navigator.userAgent);

let state = { tab: 'similar', data: null, genres: null, videoId: null };
let requestSeq = 0;
try { state.tab = localStorage.getItem('tab') || 'similar'; } catch {}

// ---------- helpers ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

// On Android, open straight in the YouTube app; fall back to the website.
function youtubeLink(path) {
  const web = 'https://www.youtube.com' + path;
  if (!isAndroid) return web;
  return 'intent://www.youtube.com' + path +
    '#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=' +
    encodeURIComponent(web) + ';end';
}

const searchLink = (t) => youtubeLink('/results?search_query=' + encodeURIComponent(`${t.artist} ${t.title}`));
const mixLink = (id) => youtubeLink(`/watch?v=${id}&list=RD${id}`);

// ---------- rendering ----------

function trackRow(t) {
  const img = el('img', { class: 'cover', src: t.cover, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => (img.style.visibility = 'hidden'));
  return el('a', { class: 'row', href: searchLink(t) }, [
    img,
    el('div', { class: 'meta' }, [
      el('div', { class: 'title', text: t.title, dir: 'auto' }),
      el('div', { class: 'artist', text: t.artist, dir: 'auto' })
    ]),
    el('span', { class: 'play', text: '▶' })
  ]);
}

function trackList(tracks, emptyText) {
  if (!tracks?.length) return el('div', { class: 'msg', text: emptyText });
  return el('div', { class: 'list' }, tracks.map(trackRow));
}

function genreView(body) {
  const d = state.data;
  const select = el('select', { class: 'select' });
  const list = el('div', {}, trackList(d.byGenre, "לא זוהה ז'אנר לשיר הזה. אפשר לבחור ז'אנר מהרשימה."));

  const fill = (genres) => {
    select.replaceChildren(el('option', { value: '', text: "בחרו ז'אנר…" }));
    for (const g of genres) {
      const opt = el('option', { value: String(g.id), text: g.name });
      if (d.genres[0]?.id === g.id) opt.selected = true;
      select.append(opt);
    }
  };
  fill(state.genres || d.genres);
  if (!state.genres) {
    allGenres().then((genres) => { state.genres = genres; fill(genres); }).catch(() => {});
  }

  select.addEventListener('change', async () => {
    if (!select.value) return;
    list.replaceChildren(el('div', { class: 'msg', text: 'טוען…' }));
    try {
      list.replaceChildren(trackList(await genreTracks(Number(select.value)), "אין שירים בז'אנר הזה."));
    } catch (e) {
      list.replaceChildren(el('div', { class: 'msg err', text: 'שגיאה: ' + e.message }));
    }
  });

  const label = d.genres.length
    ? "ז'אנר השיר: " + d.genres.map((g) => g.name).join(', ')
    : "ז'אנר השיר לא זוהה";
  body.append(el('div', { class: 'genre-head' }, [el('span', { text: label }), select]), list);
}

function renderSource(info) {
  const box = $('source');
  box.replaceChildren();
  const d = state.data;
  const thumb = info?.thumb || d?.matched?.cover;
  if (thumb) box.append(el('img', { class: 'thumb', src: thumb, alt: '' }));

  const text = el('div', { class: 'source-text' });
  if (d?.found) {
    text.append(
      el('div', { class: 'muted small', text: 'מחפש שירים דומים ל:' }),
      el('div', { class: 'title', text: d.matched.title, dir: 'auto' }),
      el('div', { class: 'artist', text: d.matched.artist, dir: 'auto' })
    );
  } else if (info?.title) {
    text.append(el('div', { class: 'title', text: info.title, dir: 'auto' }));
  }
  if (state.videoId) {
    text.append(el('a', { class: 'mix', href: mixLink(state.videoId), text: '▶ מיקס של יוטיוב' }));
  }
  box.append(text);
}

function renderBody() {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  }
  const body = $('body');
  body.replaceChildren();
  const d = state.data;
  if (!d) return body.append(el('div', { class: 'msg', text: 'מחפש שירים דומים…' }));
  if (d.error) return body.append(el('div', { class: 'msg err', text: 'שגיאה: ' + d.error }));
  if (!d.found) return body.append(el('div', { class: 'msg', text: 'לא מצאתי את השיר. נסו לכתוב "אמן - שיר" בתיבת החיפוש.' }));

  if (state.tab === 'similar') body.append(trackList(d.similar, 'לא נמצאו שירים דומים.'));
  else if (state.tab === 'artist') body.append(trackList(d.sameArtist, 'לא נמצאו עוד שירים של האמן.'));
  else genreView(body);
}

// ---------- flow ----------

// Input can be a YouTube link, text that contains one (as shared by the app), or "artist - song".
async function run(input) {
  input = String(input || '').trim();
  if (!input) return;
  const seq = ++requestSeq;
  const videoId = extractVideoId(input);

  state = { ...state, data: null, videoId };
  $('intro').hidden = true;
  $('result').hidden = false;
  renderSource(null);
  renderBody();

  try {
    let query, info = null;
    if (videoId) {
      info = await videoInfo(videoId);
      if (seq !== requestSeq) return;
      renderSource(info);
      query = parseTitle(info.title, info.channel);
      $('query').value = query.artist ? `${query.artist} - ${query.song}` : query.song;
      history.replaceState(null, '', '?v=' + videoId);
    } else {
      const [a, ...rest] = input.split(/\s+[-–—]\s+/);
      query = rest.length ? { artist: a, song: rest.join(' ') } : parseTitle(input);
      history.replaceState(null, '', '?q=' + encodeURIComponent(input));
    }
    const data = await analyze(query);
    if (seq !== requestSeq) return;
    state.data = data;
    renderSource(info);
  } catch (e) {
    if (seq !== requestSeq) return;
    state.data = { error: e.message };
  }
  renderBody();
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    try { localStorage.setItem('tab', state.tab); } catch {}
    renderBody();
  });
}

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  $('query').blur();
  run($('query').value);
});

$('paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    $('query').value = text;
    run(text);
  } catch {
    $('query').focus(); // no clipboard permission: let the user paste by hand
  }
});

// "Add to home screen" button, when the browser offers it.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install').hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Share target (?title=&text=&url=), a reload (?v= / ?q=), or nothing.
const params = new URLSearchParams(location.search);
const v = params.get('v');
const shared = v
  ? 'https://youtu.be/' + v
  : [params.get('url'), params.get('text'), params.get('title'), params.get('q')].filter(Boolean).join(' ');
if (shared) {
  // Shared text sometimes has a link plus a title; the link wins when there is one.
  const id = extractVideoId(shared);
  run(id ? 'https://youtu.be/' + id : params.get('q') || params.get('title') || params.get('text') || '');
}
