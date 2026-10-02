// Song lookup logic: parse a YouTube title, find it on Deezer, collect similar songs.
// Deezer has no CORS, so the browser talks to it through JSONP (a <script> tag).

(function (global) {
  const API = 'https://api.deezer.com';
  const QUOTA_ERROR = 4; // Deezer allows ~50 requests per 5 seconds
  const MAX_PARALLEL = 4;
  const cache = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => encodeURIComponent(s.trim());

  let callbackSeq = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const name = '__dz' + ++callbackSeq;
      const script = document.createElement('script');
      const timer = setTimeout(() => done(new Error('הבקשה לקחה יותר מדי זמן')), 12000);
      function done(err, data) {
        clearTimeout(timer);
        global[name] = () => {}; // a late reply must not throw
        script.remove();
        err ? reject(err) : resolve(data);
      }
      global[name] = (data) => done(null, data);
      script.onerror = () => done(new Error('אין חיבור לאינטרנט'));
      script.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + name;
      document.head.append(script);
    });
  }

  let transport = jsonp;
  let active = 0;
  const waiting = [];

  async function withSlot(fn) {
    if (active >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function dz(path) {
    if (cache.has(path)) return cache.get(path);
    for (let attempt = 0; ; attempt++) {
      const json = await withSlot(() => transport(API + path));
      if (json.error?.code === QUOTA_ERROR && attempt < 4) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (json.error) throw new Error(json.error.message || 'Deezer error');
      cache.set(path, json);
      return json;
    }
  }

  function slimTrack(t) {
    return {
      id: t.id,
      title: t.title_short || t.title,
      artist: t.artist?.name || '',
      cover: t.album?.cover_medium || t.album?.cover_small || t.artist?.picture_medium || ''
    };
  }

  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const sameName = (a, b) => {
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x.includes(y) || y.includes(x));
  };

  // The artist matters most (similar songs are based on it), so a wrong song by the
  // right artist beats a right-sounding song by someone else.
  async function findTrack(artist, song) {
    if (artist && song) {
      const hits = (await dz(`/search?q=${q(`${artist} ${song}`)}&limit=10`)).data || [];
      const best = hits.find((t) => sameName(t.artist.name, artist));
      if (best) return best;
    }
    if (artist) {
      // Artist search also handles transliterations (e.g. "Eden Hason" -> "עדן חסון").
      const found = (await dz(`/search/artist?q=${q(artist)}&limit=1`)).data?.[0];
      if (found) {
        const top = (await dz(`/artist/${found.id}/top?limit=50`)).data || [];
        const match = song && top.find((t) => sameName(t.title, song));
        if (match || top[0]) return match || top[0];
      }
    }
    const fallback = await dz(`/search?q=${q(song || artist)}&limit=1`);
    return fallback.data?.[0] || null;
  }

  async function genreTracks(genreId) {
    const chart = (await dz(`/chart/${genreId}/tracks?limit=25`)).data || [];
    if (chart.length) return chart.map(slimTrack);

    // Some genres have no chart; build a list from the genre's artists instead.
    const artists = (await dz(`/genre/${genreId}/artists`)).data || [];
    const lists = await Promise.all(
      artists.slice(0, 12).map((a) =>
        dz(`/artist/${a.id}/top?limit=2`).then((r) => r.data || []).catch(() => [])
      )
    );
    return lists.flat().map(slimTrack);
  }

  async function analyze({ artist, song }) {
    const track = await findTrack(artist, song);
    if (!track) return { found: false };

    const artistId = track.artist.id;
    const [related, top, album] = await Promise.all([
      dz(`/artist/${artistId}/related?limit=8`).catch(() => ({ data: [] })),
      dz(`/artist/${artistId}/top?limit=12`).catch(() => ({ data: [] })),
      dz(`/album/${track.album.id}`).catch(() => null)
    ]);

    // Two top songs from each related artist, interleaved so the list mixes artists.
    const perArtist = await Promise.all(
      (related.data || []).map((a) =>
        dz(`/artist/${a.id}/top?limit=2`).then((r) => r.data || []).catch(() => [])
      )
    );
    // Deezer sometimes lists the artist as related to itself; leave those out.
    const similar = [];
    for (let i = 0; i < 2; i++) {
      for (const list of perArtist) {
        const t = list[i];
        if (t && !sameName(t.artist.name, track.artist.name)) similar.push(slimTrack(t));
      }
    }

    const sameArtist = (top.data || [])
      .filter((t) => !sameName(t.title_short || t.title, track.title_short || track.title))
      .map(slimTrack);

    const genres = (album?.genres?.data || []).map((g) => ({ id: g.id, name: g.name }));
    const byGenre = genres.length ? await genreTracks(genres[0].id).catch(() => []) : [];

    return { found: true, matched: slimTrack(track), similar, sameArtist, genres, byGenre };
  }

  async function allGenres() {
    const res = await dz('/genre');
    return (res.data || []).filter((g) => g.id !== 0).map((g) => ({ id: g.id, name: g.name }));
  }

  // ---------- YouTube side ----------

  const NOISE = [
    /official\s*(music\s*)?(video|audio|clip|lyric video)/gi,
    /lyric(s)?\s*video/gi,
    /\b(hd|hq|4k|mv|m\/v|remaster(ed)?)\b/gi,
    /הקליפ הרשמי|קליפ רשמי|הקליפ|גרסת אולפן|מילים/g
  ];

  function cleanArtist(name) {
    return name
      .replace(/\s*-\s*topic$/i, '')
      .replace(/\s*-\s*נושא$/, '')
      .replace(/vevo$/i, '')
      .replace(/\s*official$/i, '')
      .replace(/\s+(ft\.?|feat\.?|featuring|x|ו?מארח(ת)?)\s+.*$/i, '')
      .trim();
  }

  function parseTitle(title, channel = '') {
    let t = title.replace(/\s*[(\[【{].*?[)\]】}]/g, ' ');
    for (const re of NOISE) t = t.replace(re, ' ');
    t = t.replace(/\s+/g, ' ').trim();

    const parts = t.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
    let artist, song;
    if (parts.length >= 2) {
      artist = parts[0];
      song = parts[1];
    } else {
      artist = channel;
      song = t;
    }
    song = song.replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, '').replace(/["“”']/g, '').trim();
    return { artist: cleanArtist(artist || ''), song };
  }

  // Accepts youtu.be, youtube.com/watch, /shorts, music.youtube.com, with or without extra text.
  function extractVideoId(text) {
    const m = String(text || '').match(
      /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/i
    );
    return m ? m[1] : null;
  }

  async function videoInfo(videoId) {
    const url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const res = await fetch(url);
    if (!res.ok) throw new Error('לא הצלחתי לקרוא את פרטי הסרטון');
    const json = await res.json();
    return { title: json.title || '', channel: json.author_name || '', thumb: json.thumbnail_url || '' };
  }

  global.SimilarCore = {
    analyze, genreTracks, allGenres, parseTitle, extractVideoId, videoInfo,
    setTransport: (fn) => (transport = fn)
  };
})(typeof window !== 'undefined' ? window : globalThis);
