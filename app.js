// FRESHEN MUSIC RADIO 2.0 — GLOBAL RADIO CONTROL
// Используй только Publishable key. Никогда не вставляй service_role или secret key.
//
// Как это работает:
//  • Вся «правда» об эфире лежит в одной строке таблицы public.radio_control (id = 1).
//  • Админ (и только он) пишет в эту строку: старт/стоп, трек, громкость, джингл, очередь, AutoDJ.
//  • Все посетители подписаны на эту строку через Supabase Realtime и воспроизводят ровно то,
//    что в ней записано, с тем же местом в треке (позиция вычисляется по времени).
//  • Админская вкладка дополнительно следит за концом трека и сама включает следующий (AutoDJ).
const SUPABASE_URL = "https://dyuybnfbtcvtkkyauqmd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_iqNXYa5VEjr81zOaQvS0uQ_QXyvV-2o";
const BUCKET = "tracks";
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ADMIN_USER_ID = "62a01512-f7b0-47b4-90d9-c28a960cf4e9";
const CLIENT_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const $ = id => document.getElementById(id);
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const audio = $("audio-player");
const jingleAudio = new Audio();
jingleAudio.preload = "auto";

let tracks = [];
let jingles = [];
let trackMap = new Map();
let currentUser = null;
let isAdmin = false;
let playlists = [];
let selectedPlaylistId = null;
let selectedPlaylistTracks = [];
let selectedDuckJingleId = null;
let selectedBetweenJingleId = null;

// ---------- состояние эфира ----------
function defaultRadio() {
  return {
    id: 1,
    status: "stopped",
    current_track_id: null,
    playback_started_at: null,
    playback_position: 0,
    master_volume: 0.8,
    autodj_enabled: false,
    queue_track_ids: [],
    queue_index: 0,
    jingle_track_id: null,
    jingle_started_at: null,
    settings: {},
    updated_at: null
  };
}
let radio = defaultRadio();
let radioLoaded = false;
let clockOffset = 0;
let listening = false;      // посетитель нажал ▶ на плеере
let monitorMuted = false;   // админ: заглушить звук у себя (на слушателей не влияет)
let listenerVolume = 1;
let advancing = false;
let seekDragging = false;
let lastJingleSig = "";
let lastLibKey = "";
let artKey = null;
const durationCache = new Map();

const AUTODJ_SETTINGS_KEY = "freshen-radio-autodj-settings";
const LISTENER_VOLUME_KEY = "freshen-listener-volume";

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
const smooth = x => { const p = Math.min(1, Math.max(0, x)); return p * p * (3 - 2 * p); };
const lerp = (a, b, t) => a + (b - a) * t;
const iso = ms => new Date(ms).toISOString();
function serverNow() { return Date.now() + clockOffset; }

// Синхронизация часов с сервером (нужна, чтобы у всех позиция трека совпадала).
// Работает, если в базе есть функция server_time() (см. инструкцию), иначе используются часы устройства.
async function syncClock() {
  try {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const {data, error} = await client.rpc("server_time");
      const t1 = Date.now();
      if (error || !data) return;
      const server = Date.parse(data);
      if (!Number.isFinite(server)) return;
      const rtt = t1 - t0;
      const offset = server + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = {rtt, offset};
    }
    if (best) clockOffset = best.offset;
  } catch (error) {
    clockOffset = 0;
  }
}

function normalizeRadioRow(row) {
  const base = defaultRadio();
  return {
    ...base,
    ...row,
    playback_position: Number(row.playback_position) || 0,
    master_volume: clampNumber(row.master_volume, 0, 1, 0.8),
    queue_track_ids: Array.isArray(row.queue_track_ids) ? row.queue_track_ids : [],
    queue_index: Number(row.queue_index) || 0,
    settings: row.settings && typeof row.settings === "object" ? row.settings : {}
  };
}

// ---------- настройки AutoDJ ----------
function normalizeAutoDJ(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    mode: s.mode === "duck" ? "duck" : "between",
    frequency: Math.round(clampNumber(s.frequency, 1, 1000, 2)),
    duckReturnTime: clampNumber(s.duckReturnTime ?? s.duckFadeIn, 0.1, 10, 2),
    duckDb: clampNumber(s.duckDb, 0, 40, 12),
    transitionEnabled: s.transitionEnabled === true,
    transitionFadeOut: clampNumber(s.transitionFadeOut, 0.1, 10, 2),
    transitionFadeIn: clampNumber(s.transitionFadeIn, 0.1, 10, 2),
    duckJingleId: s.duckJingleId || null,
    betweenJingleId: s.betweenJingleId || null
  };
}
function readAutoDJForm() {
  return normalizeAutoDJ({
    mode: $("jingle-mode").value,
    frequency: $("jingle-frequency").value,
    duckReturnTime: $("duck-return-time").value,
    duckDb: $("duck-volume-db").value,
    transitionEnabled: $("transition-enabled").checked,
    transitionFadeOut: $("transition-fade-out").value,
    transitionFadeIn: $("transition-fade-in").value,
    duckJingleId: $("duck-jingle-select")?.value || selectedDuckJingleId,
    betweenJingleId: $("between-jingle-select")?.value || selectedBetweenJingleId
  });
}
function fillAutoDJForm(cfg) {
  $("jingle-mode").value = cfg.mode;
  $("jingle-frequency").value = cfg.frequency;
  $("duck-return-time").value = cfg.duckReturnTime;
  $("duck-volume-db").value = cfg.duckDb;
  $("transition-enabled").checked = cfg.transitionEnabled;
  $("transition-fade-out").value = cfg.transitionFadeOut;
  $("transition-fade-in").value = cfg.transitionFadeIn;
  selectedDuckJingleId = cfg.duckJingleId;
  selectedBetweenJingleId = cfg.betweenJingleId;
  updateJingleModeControls();
}
function saveAutoDJLocal(cfg) {
  try { localStorage.setItem(AUTODJ_SETTINGS_KEY, JSON.stringify(cfg)); }
  catch (error) { console.warn("Не удалось сохранить настройки AutoDJ", error); }
}
function loadAutoDJLocal() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(AUTODJ_SETTINGS_KEY) || "{}"); } catch (error) { raw = {}; }
  fillAutoDJForm(normalizeAutoDJ(raw));
}
function onAutoDJFormChange() {
  const cfg = readAutoDJForm();
  selectedDuckJingleId = cfg.duckJingleId;
  selectedBetweenJingleId = cfg.betweenJingleId;
  $("jingle-frequency").value = cfg.frequency;
  saveAutoDJLocal(cfg);
  if (isAdmin && radioLoaded) commitRadio({}, null, cfg);
}
function applyRadioToAdminForm() {
  if (radio.settings && radio.settings.autodj) {
    fillAutoDJForm(normalizeAutoDJ(radio.settings.autodj));
    renderJingleSelectors();
  } else {
    commitRadio({}, null, readAutoDJForm());
  }
}

// ---------- утилиты UI ----------
let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function setConnection(ok, text) {
  $("connection-status").classList.toggle("error", !ok);
  $("connection-status").innerHTML = `<i></i> ${text}`;
}
function trackUrl(track) {
  return client.storage.from(BUCKET).getPublicUrl(track.file_path).data.publicUrl;
}
function coverUrl(track) {
  return client.storage.from(BUCKET).getPublicUrl(track.cover_path).data.publicUrl;
}
function measureAudioDuration(url) {
  return new Promise(resolve => {
    const temp = new Audio();
    let done = false;
    const finish = value => { if (done) return; done = true; temp.src = ""; resolve(value); };
    temp.preload = "metadata";
    temp.onloadedmetadata = () => finish(Number.isFinite(temp.duration) ? temp.duration : null);
    temp.onerror = () => finish(null);
    setTimeout(() => finish(null), 7000);
    temp.src = url;
  });
}
async function jingleDuration(j) {
  if (durationCache.has(j.id)) return durationCache.get(j.id);
  const measured = await measureAudioDuration(trackUrl(j));
  const value = measured && measured > 0 ? measured : (Number(j.duration) || 5);
  durationCache.set(j.id, value);
  return value;
}
function prefetchJingleDurations() {
  jingles.forEach(j => { jingleDuration(j); });
}
function jingleDur(j) {
  if (!j) return 0;
  if (jingleAudio.dataset.key === "j:" + j.id && Number.isFinite(jingleAudio.duration) && jingleAudio.duration > 0) return jingleAudio.duration;
  if (durationCache.has(j.id)) return durationCache.get(j.id);
  return Number(j.duration) > 0 ? Number(j.duration) + 0.5 : 30;
}
function currentTrack() { return trackMap.get(radio.current_track_id) || null; }
function trackPositionAt(s, nowMs) {
  const base = Number(s.playback_position) || 0;
  if (s.status !== "playing" || !s.playback_started_at) return base;
  return base + (nowMs - Date.parse(s.playback_started_at)) / 1000;
}
function trackDuration(track) {
  if (!track) return 0;
  if (audio.dataset.trackId === track.id && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return Number(track.duration) || 0;
}

// ---------- запись состояния эфира (только админ) ----------
let writeChain = Promise.resolve(true);
function commitRadio(patch = {}, runtimePatch = null, autodjCfg = null) {
  if (!isAdmin) return Promise.resolve(false);
  const prev = radio.settings || {};
  const settings = {
    autodj: autodjCfg || prev.autodj || readAutoDJForm(),
    runtime: {...(prev.runtime || {}), ...(runtimePatch || {}), writer: CLIENT_ID}
  };
  const updated_at = iso(serverNow());
  radio = {...radio, ...patch, settings, updated_at};
  afterRadioChange();
  const body = {...patch, settings, updated_at};
  writeChain = writeChain.then(async () => {
    const {data, error} = await client.from("radio_control").update(body).eq("id", 1).select("id");
    if (error) {
      console.error(error);
      toast("Ошибка синхронизации эфира: " + error.message);
      return false;
    }
    if (!data || !data.length) {
      toast("Эфир не обновился: нет прав или нет строки radio_control (id = 1).");
      return false;
    }
    return true;
  });
  return writeChain;
}

// ---------- управление эфиром (админ) ----------
function onAirTrack(trackId, opts = {}) {
  const {queue = [], queueIndex = 0, autodj = false} = opts;
  unlockAudio();
  return commitRadio({
    status: "playing",
    current_track_id: trackId,
    playback_position: 0,
    playback_started_at: iso(serverNow()),
    queue_track_ids: queue,
    queue_index: queueIndex,
    autodj_enabled: autodj,
    jingle_track_id: null,
    jingle_started_at: null
  }, {songsSinceJingle: 0, jingleKind: null});
}
function toggleOnAir() {
  if (!isAdmin) return;
  unlockAudio();
  if (radio.status === "playing") {
    const pos = Math.max(0, trackPositionAt(radio, serverNow()));
    commitRadio({status: "stopped", playback_position: pos, playback_started_at: null, jingle_track_id: null, jingle_started_at: null});
    toast("Эфир выключен для всех");
    return;
  }
  const track = currentTrack();
  if (!track) {
    if (!tracks.length) return toast("Сначала добавь треки в медиатеку");
    onAirTrack(tracks[0].id);
    toast("Эфир включён");
    return;
  }
  let pos = Number(radio.playback_position) || 0;
  const dur = trackDuration(track);
  if (dur && pos >= dur - 0.5) pos = 0;
  commitRadio({status: "playing", playback_position: pos, playback_started_at: iso(serverNow())});
  toast("Эфир включён для всех");
}
function stepTrack(delta) {
  if (!isAdmin) return;
  const q = radio.queue_track_ids || [];
  const list = q.length ? q : tracks.map(t => t.id);
  if (!list.length) return toast("Медиатека пуста");
  let cur = q.length && q[radio.queue_index] === radio.current_track_id ? radio.queue_index : list.indexOf(radio.current_track_id);
  if (cur < 0) cur = delta > 0 ? -1 : 0;
  for (let k = 1; k <= list.length; k++) {
    const idx = (((cur + delta * k) % list.length) + list.length) % list.length;
    if (trackMap.has(list[idx])) {
      unlockAudio();
      return commitRadio({
        status: "playing",
        current_track_id: list[idx],
        queue_index: q.length ? idx : 0,
        playback_position: 0,
        playback_started_at: iso(serverNow()),
        jingle_track_id: null,
        jingle_started_at: null
      });
    }
  }
}
function adminPrevious() {
  const pos = trackPositionAt(radio, serverNow());
  if (pos > 3 && radio.current_track_id) {
    commitRadio({playback_position: 0, playback_started_at: radio.status === "playing" ? iso(serverNow()) : null});
  } else {
    stepTrack(-1);
  }
}
function adminSeek(percent) {
  const track = currentTrack();
  const dur = trackDuration(track);
  if (!track || !dur) return;
  const pos = dur * clampNumber(percent, 0, 100, 0) / 100;
  commitRadio({playback_position: pos, playback_started_at: radio.status === "playing" ? iso(serverNow()) : null});
}
let volCool = false;
let volPending = null;
function setMasterVolume(v) {
  radio = {...radio, master_volume: v};
  syncPlayback();
  if (volCool) { volPending = v; return; }
  volCool = true;
  commitRadio({master_volume: v});
  setTimeout(() => {
    volCool = false;
    if (volPending !== null) { const p = volPending; volPending = null; setMasterVolume(p); }
  }, 250);
}
function playJingleOnAir(id) {
  if (!isAdmin) return;
  const j = jingles.find(x => x.id === id);
  if (!j) return toast("Выбери джингл");
  unlockAudio();
  commitRadio({jingle_track_id: j.id, jingle_started_at: iso(serverNow())}, {jingleKind: "duck"});
  toast(`Джингл «${j.title}» в эфире`);
}
function playLibraryTrack(id) {
  if (!isAdmin) return;
  if (radio.current_track_id === id && radio.status === "playing") {
    toggleOnAir();
    return;
  }
  if (radio.autodj_enabled) toast("AutoDJ выключен: включён выбранный трек");
  onAirTrack(id);
}
function startAutoDJ() {
  if (!isAdmin) return;
  if (!selectedPlaylistTracks.length) return toast("Сначала выбери плейлист с песнями");
  const queue = selectedPlaylistTracks.map(item => item.track_id).filter(id => trackMap.has(id));
  if (!queue.length) return toast("В плейлисте нет доступных треков");
  onAirTrack(queue[0], {queue, queueIndex: 0, autodj: true});
  toast("AutoDJ запущен для всех слушателей");
}
function stopAutoDJ() {
  if (!isAdmin) return;
  commitRadio({autodj_enabled: false, queue_track_ids: []}, {songsSinceJingle: 0});
  toast("AutoDJ остановлен. Текущий трек доиграет до конца");
}
function playSelectedPlaylist() {
  if (!isAdmin || !selectedPlaylistTracks.length) return;
  const queue = selectedPlaylistTracks.map(x => x.track_id).filter(id => trackMap.has(id));
  if (!queue.length) return;
  onAirTrack(queue[0], {queue, queueIndex: 0, autodj: false});
  toast("Плейлист запущен в эфир");
}

// Контроллер: следит за концом трека и включает следующий (работает только в админской вкладке).
async function controllerTick() {
  if (!isAdmin || !radioLoaded || advancing || radio.status !== "playing" || !radio.playback_started_at) return;
  const track = currentTrack();
  if (!track) return;
  const now = serverNow();
  const dur = trackDuration(track);
  const startMs = Date.parse(radio.playback_started_at);
  if (!dur) {
    if ((now - startMs) / 1000 > 20) await advanceOnAir();
    return;
  }
  const endMs = startMs + (dur - (Number(radio.playback_position) || 0)) * 1000;
  if (now >= endMs + 100) await advanceOnAir();
}
async function advanceOnAir() {
  if (advancing) return;
  advancing = true;
  try {
    const q = radio.queue_track_ids || [];
    let nextIdx = -1;
    if (q.length) {
      const base = q[radio.queue_index] === radio.current_track_id ? radio.queue_index : q.indexOf(radio.current_track_id);
      for (let k = 1; k <= q.length; k++) {
        const idx = (((base + k) % q.length) + q.length) % q.length;
        if (trackMap.has(q[idx])) { nextIdx = idx; break; }
      }
    }
    if (nextIdx < 0) {
      await commitRadio({status: "stopped", playback_position: 0, playback_started_at: null, autodj_enabled: false});
      return;
    }
    const nextId = q[nextIdx];
    const rt = (radio.settings && radio.settings.runtime) || {};
    const cfg = normalizeAutoDJ(radio.settings && radio.settings.autodj);
    const common = {status: "playing", current_track_id: nextId, queue_index: nextIdx, playback_position: 0};
    if (radio.autodj_enabled) {
      let since = (Number(rt.songsSinceJingle) || 0) + 1;
      const jingleId = cfg.mode === "duck" ? cfg.duckJingleId : cfg.betweenJingleId;
      const jingle = jingles.find(item => item.id === jingleId) || jingles[0];
      if (jingle && since >= cfg.frequency) {
        if (cfg.mode === "between") {
          const jd = await jingleDuration(jingle);
          const t = serverNow();
          await commitRadio({
            ...common,
            playback_started_at: iso(t + Math.round(jd * 1000)),
            jingle_track_id: jingle.id,
            jingle_started_at: iso(t)
          }, {songsSinceJingle: 0, jingleKind: "between"});
        } else {
          const t = serverNow();
          await commitRadio({
            ...common,
            playback_started_at: iso(t),
            jingle_track_id: jingle.id,
            jingle_started_at: iso(t)
          }, {songsSinceJingle: 0, jingleKind: "duck"});
        }
        return;
      }
      await commitRadio({...common, playback_started_at: iso(serverNow())}, {songsSinceJingle: since});
      return;
    }
    await commitRadio({...common, playback_started_at: iso(serverNow())});
  } finally {
    advancing = false;
  }
}

// ---------- воспроизведение (у всех) ----------
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  [audio, jingleAudio].forEach(el => {
    if (el.dataset.key) return;
    el.dataset.key = "silent";
    el.src = SILENT_WAV;
    el.play().catch(() => {});
  });
}
function engaged() { return isAdmin ? true : listening; }
function setAudioSrc(el, key, url) {
  if (el.dataset.key === key) return false;
  el.dataset.key = key;
  el.src = url;
  return true;
}
let lastBlockedToast = 0;
function playBlocked(err) {
  if (!err || err.name !== "NotAllowedError") return;
  if (!isAdmin && listening) { listening = false; updatePresence(); renderRadioUI(); }
  const t = Date.now();
  if (t - lastBlockedToast > 8000) {
    lastBlockedToast = t;
    toast("Браузер заблокировал звук. Нажми ▶ на плеере.");
  }
}
function tryPlay(el, stamp) {
  const t = Date.now();
  if (t - stamp.at < 800) return;
  stamp.at = t;
  el.play().catch(playBlocked);
}
const musicStamp = {at: 0};
const jingleStamp = {at: 0};
let lastMusicSeek = 0;
let lastJingleSeek = 0;

function nextIsDuckJingle(s) {
  const cfg = normalizeAutoDJ(s.settings && s.settings.autodj);
  const rt = (s.settings && s.settings.runtime) || {};
  if (cfg.mode !== "duck") return false;
  const j = trackMap.get(cfg.duckJingleId) || jingles[0];
  if (!j) return false;
  return (Number(rt.songsSinceJingle) || 0) + 1 >= cfg.frequency;
}
// Громкость музыки как функция времени: приглушение под джингл и переходы между треками.
function musicGain(s, track, pos, now) {
  const cfg = normalizeAutoDJ(s.settings && s.settings.autodj);
  const rt = (s.settings && s.settings.runtime) || {};
  let g = 1;
  let duckOverlap = false;
  if (s.jingle_track_id && s.jingle_started_at && rt.jingleKind !== "between") {
    const j = trackMap.get(s.jingle_track_id);
    if (j) {
      const jt = (now - Date.parse(s.jingle_started_at)) / 1000;
      const jdur = jingleDur(j);
      const factor = Math.pow(10, -cfg.duckDb / 20);
      const down = 0.4;
      if (jt >= 0) {
        if (jt < down) g *= lerp(1, factor, smooth(jt / down));
        else if (jt < jdur) g *= factor;
        else if (jt < jdur + cfg.duckReturnTime) g *= lerp(factor, 1, smooth((jt - jdur) / cfg.duckReturnTime));
      }
      if (s.playback_started_at && Math.abs(Date.parse(s.playback_started_at) - Date.parse(s.jingle_started_at)) < 600) duckOverlap = true;
    }
  }
  if (s.autodj_enabled && cfg.transitionEnabled && track) {
    if (pos >= 0 && pos < cfg.transitionFadeIn && !duckOverlap) g *= smooth(pos / cfg.transitionFadeIn);
    const dur = trackDuration(track);
    if (dur && !nextIsDuckJingle(s)) {
      const rem = dur - pos;
      if (rem < cfg.transitionFadeOut) g *= smooth(Math.max(0, rem) / cfg.transitionFadeOut);
    }
  }
  return g;
}
function syncPlayback() {
  const now = serverNow();
  const s = radio;
  const track = currentTrack();
  const on = engaged();
  audio.muted = isAdmin ? monitorMuted : false;
  jingleAudio.muted = audio.muted;

  const pos = track ? trackPositionAt(s, now) : 0;
  const musicOn = on && s.status === "playing" && !!track;
  if (musicOn) {
    const changed = setAudioSrc(audio, "t:" + track.id, trackUrl(track));
    audio.dataset.trackId = track.id;
    if (pos < 0) {
      if (!audio.paused) audio.pause();
    } else {
      const dur = trackDuration(track);
      if (dur && pos >= dur - 0.05) {
        if (!audio.paused) audio.pause();
      } else {
        const t = Date.now();
        if (changed && pos > 0.5) {
          try { audio.currentTime = pos; } catch (e) { /* metadata ещё не загружены */ }
          lastMusicSeek = t;
        } else if (audio.readyState >= 1 && !audio.seeking && Math.abs(audio.currentTime - pos) > 1.5 && t - lastMusicSeek > 1500) {
          try { audio.currentTime = pos; } catch (e) { /* ignore */ }
          lastMusicSeek = t;
        }
        if (audio.paused) tryPlay(audio, musicStamp);
      }
    }
  } else if (!audio.paused) {
    audio.pause();
  }

  const master = clampNumber(s.master_volume, 0, 1, 0.8);
  const local = isAdmin ? 1 : listenerVolume;
  audio.volume = clampNumber(master * local * (track ? musicGain(s, track, pos, now) : 1), 0, 1, 0);
  jingleAudio.volume = clampNumber(master * local, 0, 1, 0);

  const jTrack = trackMap.get(s.jingle_track_id) || null;
  let jt = null;
  if (jTrack && s.jingle_started_at) jt = (now - Date.parse(s.jingle_started_at)) / 1000;
  const jingleOn = on && jTrack && jt !== null && jt >= 0 && jt < jingleDur(jTrack);
  if (jingleOn) {
    const changed = setAudioSrc(jingleAudio, "j:" + jTrack.id, trackUrl(jTrack));
    const t = Date.now();
    if (changed && jt > 0.5) {
      try { jingleAudio.currentTime = jt; } catch (e) { /* ignore */ }
      lastJingleSeek = t;
    } else if (jingleAudio.readyState >= 1 && !jingleAudio.seeking && Math.abs(jingleAudio.currentTime - jt) > 1.2 && t - lastJingleSeek > 1500) {
      try { jingleAudio.currentTime = jt; } catch (e) { /* ignore */ }
      lastJingleSeek = t;
    }
    if (jingleAudio.paused) tryPlay(jingleAudio, jingleStamp);
  } else if (!jingleAudio.paused && jingleAudio.dataset.key !== "silent") {
    jingleAudio.pause();
  }
}
function activeBetweenJingle() {
  const s = radio;
  const rt = (s.settings && s.settings.runtime) || {};
  if (rt.jingleKind !== "between" || !s.jingle_track_id || !s.jingle_started_at) return null;
  const j = trackMap.get(s.jingle_track_id);
  if (!j) return null;
  const jt = (serverNow() - Date.parse(s.jingle_started_at)) / 1000;
  return jt >= 0 && jt < jingleDur(j) ? j : null;
}
function updateProgress() {
  const track = currentTrack();
  let pos = 0;
  let dur = 0;
  if (track) {
    dur = trackDuration(track);
    pos = Math.max(0, trackPositionAt(radio, serverNow()));
    if (dur) pos = Math.min(pos, dur);
  }
  $("current-time").textContent = formatTime(pos);
  $("total-time").textContent = formatTime(dur);
  if (!seekDragging) $("seek").value = dur ? pos / dur * 100 : 0;
}

// ---------- отрисовка ----------
function renderRadioUI() {
  const track = currentTrack();
  const playing = radio.status === "playing";
  const jingle = activeBetweenJingle();
  lastJingleSig = jingle ? jingle.id : "";
  let title;
  let artist;
  if (jingle) {
    title = jingle.title;
    artist = "Радиоджингл · FRESHEN MUSIC RADIO";
  } else if (track && (playing || isAdmin)) {
    title = track.title;
    artist = track.artist || "Неизвестный исполнитель";
  } else if (!playing) {
    title = "Эфир сейчас выключен";
    artist = isAdmin ? "Выбери трек из библиотеки и включи эфир" : (listening ? "Музыка начнётся сразу, как только эфир включится" : "Мы скоро вернёмся в эфир");
  } else {
    title = "Подключаем эфир...";
    artist = "FRESHEN MUSIC RADIO";
  }
  $("now-title").textContent = title;
  $("now-artist").textContent = artist;

  const airText = playing ? "● ON AIR" : "OFF AIR";
  $("air-status").textContent = airText;
  $("air-status").classList.toggle("live", playing);
  $("air-badge").textContent = airText;
  $("air-badge").classList.toggle("live", playing);

  const key = jingle ? "j:" + jingle.id : (track ? "t:" + track.id : "none");
  if (artKey !== key) {
    artKey = key;
    const artwork = document.querySelector(".player-art-logo");
    if (artwork) {
      const src = !jingle && track && track.cover_path ? coverUrl(track) : "Freshen Logo.png";
      artwork.onerror = () => { artwork.onerror = null; artwork.src = "Freshen Logo.png"; };
      artwork.src = src;
    }
  }

  const playIcon = isAdmin ? playing : (listening && playing);
  $("play-button").textContent = isAdmin ? (playing ? "Ⅱ" : "▶") : (listening ? "Ⅱ" : "▶");
  $("play-button").classList.toggle("is-playing", playIcon);
  $("play-button").title = isAdmin ? (playing ? "Выключить эфир для всех" : "Включить эфир для всех") : (listening ? "Выключить звук" : "Слушать эфир");
  $("listen-hint").textContent = isAdmin
    ? "Ты управляешь эфиром: любое действие мгновенно применяется у всех слушателей."
    : "Прямой эфир. Нажми ▶, чтобы слушать. Радио играет для всех одновременно.";

  $("onair-toggle").textContent = playing ? "⏹ Выключить эфир" : "▶ Включить эфир";
  $("monitor-toggle").textContent = monitorMuted ? "🔇 Мониторинг: выкл" : "🔊 Мониторинг: вкл";
  const dj = !!radio.autodj_enabled;
  $("autodj-status").textContent = dj ? "● AUTODJ ON AIR" : "AUTODJ OFFLINE";
  $("autodj-status").classList.toggle("dj-active", dj);
  syncVolumeSlider();
  updateProgress();
}
function syncVolumeSlider() {
  const slider = $("volume");
  if (document.activeElement === slider) return;
  slider.value = isAdmin ? radio.master_volume : listenerVolume;
  $("volume-label").textContent = isAdmin ? "ЭФИР" : "VOL";
}
function afterRadioChange() {
  syncPlayback();
  renderRadioUI();
  const key = radio.status + "|" + radio.current_track_id;
  if (key !== lastLibKey) {
    lastLibKey = key;
    renderTracks();
  }
}
function renderTracks() {
  const query = $("search-input").value.trim().toLowerCase();
  const filtered = tracks.filter(t => `${t.title} ${t.artist || ""}`.toLowerCase().includes(query));
  $("track-count").textContent = tracks.length;
  const list = $("library-list");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">${tracks.length ? "Ничего не найдено." : "Медиатека пока пуста."}</div>`;
    return;
  }
  const liveId = radio.status === "playing" ? radio.current_track_id : null;
  list.innerHTML = filtered.map(t => {
    const index = tracks.findIndex(x => x.id === t.id);
    const live = t.id === liveId;
    const lead = isAdmin
      ? `<button class="track-play" data-play="${t.id}" title="${live ? "Выключить эфир" : "Поставить в эфир"}">${live ? "Ⅱ" : "▶"}</button>`
      : `<span class="track-onair ${live ? "on" : ""}" title="${live ? "Сейчас в эфире" : ""}">${live ? "●" : ""}</span>`;
    return `<div class="track-row ${live ? "on-air" : ""}">
      <span class="track-number">${String(index + 1).padStart(2, "0")}</span>
      ${lead}
      <div class="track-info"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist || "Неизвестный исполнитель")}${live ? " · В ЭФИРЕ" : ""}</small></div>
      <span class="track-duration">${t.duration ? formatTime(t.duration) : "--:--"}</span>
      ${isAdmin ? `<button class="mini-action" data-add-playlist="${t.id}" title="Добавить в выбранный плейлист">＋</button><button class="delete-track" data-delete="${t.id}" title="Удалить">×</button>` : ""}
    </div>`;
  }).join("");
  if (!isAdmin) return;
  list.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => playLibraryTrack(b.dataset.play)));
  list.querySelectorAll("[data-add-playlist]").forEach(b => b.addEventListener("click", () => addTrackToPlaylist(b.dataset.addPlaylist)));
  list.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", () => deleteTrack(b.dataset.delete)));
}
async function loadTracks(silent = false) {
  if (!silent) $("library-list").innerHTML = `<div class="empty-state">Загружаем медиатеку...</div>`;
  const {data, error} = await client.from("tracks").select("*").order("created_at", {ascending: true});
  if (error) {
    $("library-list").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    $("library-message").textContent = "Проверь доступ к таблице и настройки RLS.";
    return false;
  }
  const all = data || [];
  tracks = all.filter(t => !t.is_jingle);
  jingles = all.filter(t => t.is_jingle === true);
  trackMap = new Map(all.map(t => [t.id, t]));
  $("library-message").textContent = "";
  renderJingles();
  renderTracks();
  syncPlayback();
  renderRadioUI();
  if (isAdmin) prefetchJingleDurations();
  return true;
}
async function deleteTrack(id) {
  if (!isAdmin) return;
  const track = tracks.find(t => t.id === id);
  if (!track || !confirm(`Удалить «${track.title}» из медиатеки?`)) return;
  if (radio.current_track_id === id) {
    await commitRadio({status: "stopped", current_track_id: null, playback_position: 0, playback_started_at: null});
  }
  const pathsToRemove = [track.file_path, track.cover_path].filter(Boolean);
  const {error: storageError} = await client.storage.from(BUCKET).remove(pathsToRemove);
  if (storageError) return toast(`Ошибка удаления файла: ${storageError.message}`);
  const {error: dbError} = await client.from("tracks").delete().eq("id", id);
  if (dbError) {
    toast(`Файл удален, но запись осталась: ${dbError.message}`);
    await loadTracks(true);
    await loadPlaylists();
    return;
  }
  toast("Трек удален");
  await loadTracks(true);
  await loadPlaylists();
}
function getDuration(file) {
  return new Promise(resolve => {
    const temp = document.createElement("audio");
    const url = URL.createObjectURL(file);
    temp.preload = "metadata";
    temp.onloadedmetadata = () => { const d = Math.round(temp.duration); URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : null); };
    temp.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    temp.src = url;
  });
}

// ---------- получение состояния эфира ----------
function stamp(row) {
  const t = Date.parse(row && row.updated_at);
  return Number.isFinite(t) ? t : 0;
}
async function handleRadioRow(row, fromPoll = false) {
  if (!row) return;
  if (isAdmin && row.settings && row.settings.runtime && row.settings.runtime.writer === CLIENT_ID) return;
  const incoming = stamp(row);
  const known = stamp(radio);
  if (fromPoll ? incoming <= known : incoming < known) return;
  radio = normalizeRadioRow(row);
  radioLoaded = true;
  const missing = [radio.current_track_id, radio.jingle_track_id].filter(Boolean).some(id => !trackMap.has(id));
  if (missing) await loadTracks(true);
  afterRadioChange();
}
async function loadRadio() {
  const {data, error} = await client.from("radio_control").select("*").eq("id", 1).maybeSingle();
  if (error) {
    console.error(error);
    toast("Не удалось получить состояние эфира: " + error.message);
    return false;
  }
  if (!data) {
    if (isAdmin) await client.from("radio_control").insert({id: 1});
    radioLoaded = true;
    return false;
  }
  radio = normalizeRadioRow(data);
  radioLoaded = true;
  lastLibKey = "";
  const missing = [radio.current_track_id, radio.jingle_track_id].filter(Boolean).some(id => !trackMap.has(id));
  if (missing) await loadTracks(true);
  afterRadioChange();
  return true;
}
let radioChannel = null;
function subscribeRadio() {
  if (radioChannel) return;
  radioChannel = client.channel("radio-control-" + CLIENT_ID)
    .on("postgres_changes", {event: "*", schema: "public", table: "radio_control"}, payload => {
      if (payload.new && payload.new.id === 1) handleRadioRow(payload.new);
    })
    .subscribe();
  setInterval(async () => {
    const {data} = await client.from("radio_control").select("*").eq("id", 1).maybeSingle();
    if (data) handleRadioRow(data, true);
  }, 10000);
}

// ---------- слушатели (presence) ----------
let presenceChannel = null;
let presenceReady = false;
function setupPresence() {
  try {
    presenceChannel = client.channel("radio-presence", {config: {presence: {key: CLIENT_ID}}});
    presenceChannel.on("presence", {event: "sync"}, () => {
      const state = presenceChannel.presenceState();
      const count = Object.values(state).filter(list => list.some(p => p.listening)).length;
      $("listeners-count").textContent = `СЛУШАТЕЛИ: ${count}`;
    });
    presenceChannel.subscribe(status => {
      if (status === "SUBSCRIBED") { presenceReady = true; updatePresence(); }
    });
  } catch (error) {
    console.warn("Presence недоступен", error);
  }
}
function updatePresence() {
  if (!presenceReady || !presenceChannel || isAdmin) return;
  if (listening) presenceChannel.track({listening: true});
  else presenceChannel.untrack();
}

// ---------- плейлисты (только админ) ----------
async function loadPlaylists() {
  if (!isAdmin) return;
  const {data, error} = await client.from("playlists").select("*").order("created_at", {ascending: true});
  if (error) {
    $("playlist-list").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    return;
  }
  playlists = data || [];
  if (!playlists.some(p => p.id === selectedPlaylistId)) selectedPlaylistId = playlists[0]?.id || null;
  renderPlaylists();
  if (selectedPlaylistId) await loadPlaylistTracks();
  else { selectedPlaylistTracks = []; renderPlaylistTracks(); }
}
function renderPlaylists() {
  const list = $("playlist-list");
  if (!playlists.length) {
    list.innerHTML = '<div class="empty-state">Плейлистов пока нет.</div>';
    $("selected-playlist-name").textContent = "Выбери плейлист";
    return;
  }
  list.innerHTML = playlists.map(p => `<button class="playlist-item ${p.id === selectedPlaylistId ? "active" : ""}" data-playlist="${p.id}">${escapeHtml(p.name)}</button>`).join("");
  list.querySelectorAll("[data-playlist]").forEach(b => b.addEventListener("click", async () => {
    selectedPlaylistId = b.dataset.playlist;
    renderPlaylists();
    await loadPlaylistTracks();
  }));
}
async function loadPlaylistTracks() {
  if (!selectedPlaylistId) { selectedPlaylistTracks = []; return renderPlaylistTracks(); }
  const playlist = playlists.find(p => p.id === selectedPlaylistId);
  $("selected-playlist-name").textContent = playlist?.name || "Плейлист";
  const {data, error} = await client.from("playlist_tracks")
    .select("id,playlist_id,track_id,position,tracks(id,title,artist,duration,file_path)")
    .eq("playlist_id", selectedPlaylistId)
    .order("position", {ascending: true});
  if (error) {
    $("playlist-track-list").innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }
  selectedPlaylistTracks = data || [];
  renderPlaylistTracks();
}
function renderPlaylistTracks() {
  const list = $("playlist-track-list");
  $("playlist-admin").classList.toggle("hidden", !isAdmin);
  $("playlist-delete").classList.toggle("hidden", !isAdmin || !selectedPlaylistId);
  $("playlist-play").disabled = !selectedPlaylistTracks.length;
  if (!selectedPlaylistId) {
    list.innerHTML = "";
    $("selected-playlist-name").textContent = "Выбери плейлист";
    $("playlist-hint").textContent = "Создай плейлист или выбери существующий.";
    return;
  }
  $("playlist-hint").textContent = selectedPlaylistTracks.length + " трек(ов) в плейлисте";
  if (!selectedPlaylistTracks.length) {
    list.innerHTML = '<div class="empty-state">Здесь пока пусто. Добавь песни из медиатеки.</div>';
    return;
  }
  list.innerHTML = selectedPlaylistTracks.map((item, i) => {
    const t = item.tracks;
    if (!t) return "";
    return `<div class="playlist-track-row">
      <span class="track-number">${String(i + 1).padStart(2, "0")}</span>
      <div class="track-info"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist || "Неизвестный исполнитель")}</small></div>
      <span class="track-duration">${t.duration ? formatTime(t.duration) : "--:--"}</span>
      <button class="mini-action" data-up="${item.id}" ${i === 0 ? "disabled" : ""}>↑</button><button class="mini-action" data-down="${item.id}" ${i === selectedPlaylistTracks.length - 1 ? "disabled" : ""}>↓</button><button class="delete-track" data-remove="${item.id}">×</button>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => movePlaylistTrack(b.dataset.up, -1)));
  list.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => movePlaylistTrack(b.dataset.down, 1)));
  list.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => removePlaylistTrack(b.dataset.remove)));
}
async function createPlaylist(e) {
  e.preventDefault();
  if (!isAdmin) return toast("Сначала войди в аккаунт");
  const name = $("playlist-name").value.trim();
  if (!name) return;
  const {data, error} = await client.from("playlists").insert({name, created_by: currentUser.id}).select().single();
  if (error) return toast("Ошибка создания: " + error.message);
  $("playlist-create-form").reset();
  selectedPlaylistId = data.id;
  await loadPlaylists();
  toast("Плейлист создан");
}
async function addTrackToPlaylist(id) {
  if (!isAdmin) return toast("Сначала войди в аккаунт");
  if (!selectedPlaylistId) return toast("Сначала создай или выбери плейлист");
  const maxPosition = selectedPlaylistTracks.reduce((m, x) => Math.max(m, x.position || 0), -1);
  const {error} = await client.from("playlist_tracks").insert({
    playlist_id: selectedPlaylistId, track_id: id, position: maxPosition + 1
  });
  if (error) return toast(error.code === "23505" ? "Этот трек уже есть в плейлисте" : error.message);
  await loadPlaylistTracks();
  toast("Трек добавлен в плейлист");
}
async function removePlaylistTrack(id) {
  if (!isAdmin) return;
  const {error} = await client.from("playlist_tracks").delete().eq("id", id);
  if (error) return toast(error.message);
  await loadPlaylistTracks();
}
async function movePlaylistTrack(id, delta) {
  if (!isAdmin) return;
  const index = selectedPlaylistTracks.findIndex(x => x.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= selectedPlaylistTracks.length) return;
  const rows = [...selectedPlaylistTracks];
  [rows[index], rows[target]] = [rows[target], rows[index]];
  for (let i = 0; i < rows.length; i++) {
    const {error} = await client.from("playlist_tracks").update({position: i}).eq("id", rows[i].id);
    if (error) return toast("Ошибка изменения порядка: " + error.message);
  }
  await loadPlaylistTracks();
}
async function deletePlaylist() {
  if (!isAdmin || !selectedPlaylistId) return;
  const p = playlists.find(x => x.id === selectedPlaylistId);
  if (!confirm(`Удалить плейлист «${p?.name || ""}»? Сами треки останутся в медиатеке.`)) return;
  const {error} = await client.from("playlists").delete().eq("id", selectedPlaylistId);
  if (error) return toast(error.message);
  selectedPlaylistId = null;
  await loadPlaylists();
  toast("Плейлист удален");
}

// ---------- джинглы и AutoDJ (только админ) ----------
function updateJingleModeControls() {
  const mode = $("jingle-mode").value;
  $("between-jingle-setting").classList.toggle("hidden", mode !== "between");
  $("duck-jingle-setting").classList.toggle("hidden", mode !== "duck");
  $("duck-fade-settings").classList.toggle("hidden", mode !== "duck");
}
function renderJingleSelectors() {
  const betweenSelect = $("between-jingle-select");
  const duckSelect = $("duck-jingle-select");
  const onairSelect = $("onair-jingle-select");
  const previousBetween = selectedBetweenJingleId || betweenSelect.value;
  const previousDuck = selectedDuckJingleId || duckSelect.value;
  const previousOnair = onairSelect.value;
  function fillSelect(select, previousId) {
    select.innerHTML = "";
    if (!jingles.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Нет загруженных джинглов";
      select.appendChild(option);
      return "";
    }
    jingles.forEach(jingle => {
      const option = document.createElement("option");
      option.value = jingle.id;
      option.textContent = jingle.title;
      select.appendChild(option);
    });
    const exists = jingles.some(jingle => jingle.id === previousId);
    const selectedId = exists ? previousId : jingles[0].id;
    select.value = selectedId;
    return selectedId;
  }
  selectedBetweenJingleId = fillSelect(betweenSelect, previousBetween) || null;
  selectedDuckJingleId = fillSelect(duckSelect, previousDuck) || null;
  fillSelect(onairSelect, previousOnair);
  const cfg = readAutoDJForm();
  saveAutoDJLocal(cfg);
  updateJingleModeControls();
  const live = radio.settings && radio.settings.autodj;
  if (isAdmin && radioLoaded && live && (live.duckJingleId !== cfg.duckJingleId || live.betweenJingleId !== cfg.betweenJingleId)) {
    commitRadio({}, null, cfg);
  }
}
function renderJingles() {
  const list = $("jingle-list");
  $("jingle-count").textContent = jingles.length + " JINGLES";
  renderJingleSelectors();
  if (!jingles.length) {
    list.innerHTML = '<div class="empty-state">Джинглов пока нет.</div>';
    return;
  }
  if (!isAdmin) { list.innerHTML = ""; return; }
  list.innerHTML = jingles.map(j => `
    <div class="track-row">
      <button class="track-play" data-play-jingle="${j.id}" title="Пустить в эфир">▶</button>
      <div class="track-info"><strong>${escapeHtml(j.title)}</strong><small>RADIO JINGLE · нажми ▶, чтобы пустить в эфир</small></div>
      <button class="delete-track" data-delete-jingle="${j.id}">×</button>
    </div>
  `).join("");
  list.querySelectorAll("[data-play-jingle]").forEach(b => b.addEventListener("click", () => playJingleOnAir(b.dataset.playJingle)));
  list.querySelectorAll("[data-delete-jingle]").forEach(b => b.addEventListener("click", () => deleteJingle(b.dataset.deleteJingle)));
}
async function uploadJingle() {
  if (!isAdmin) return toast("Сначала войди в аккаунт");
  const file = $("jingle-file").files[0];
  const title = $("jingle-title").value.trim() || (file ? file.name.replace(/\.[^.]+$/, "") : "");
  if (!file) return $("jingle-message").textContent = "Выбери аудиофайл.";
  if (file.size > MAX_FILE_SIZE) return $("jingle-message").textContent = "Файл больше 50 МБ.";
  const button = $("jingle-upload");
  button.disabled = true;
  $("jingle-message").textContent = "Загружаю джингл...";
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const {error: uploadError} = await client.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600", upsert: false, contentType: file.type || "audio/mpeg"
  });
  if (uploadError) {
    button.disabled = false;
    $("jingle-message").textContent = uploadError.message;
    return;
  }
  const duration = await getDuration(file);
  const {error} = await client.from("tracks").insert({
    title, artist: "FRESHEN MUSIC RADIO", file_path: path, duration, is_jingle: true
  });
  if (error) {
    await client.storage.from(BUCKET).remove([path]);
    button.disabled = false;
    $("jingle-message").textContent = error.message;
    return;
  }
  $("jingle-file").value = "";
  $("jingle-title").value = "";
  $("jingle-file-label").textContent = "Загрузить джингл";
  $("jingle-message").textContent = "Джингл загружен.";
  button.disabled = false;
  await loadTracks(true);
  toast("Джингл добавлен");
}
async function deleteJingle(id) {
  if (!isAdmin) return;
  const j = jingles.find(x => x.id === id);
  if (!j || !confirm(`Удалить джингл «${j.title}»?`)) return;
  const {error: storageError} = await client.storage.from(BUCKET).remove([j.file_path]);
  if (storageError) return toast(storageError.message);
  const {error} = await client.from("tracks").delete().eq("id", id);
  if (error) return toast(error.message);
  if (radio.jingle_track_id === id) await commitRadio({jingle_track_id: null, jingle_started_at: null});
  await loadTracks(true);
  toast("Джингл удален");
}

// ---------- роли: админ / посетитель ----------
function setAuthUI(user) {
  const wasAdmin = isAdmin;
  currentUser = user;
  isAdmin = !!user && user.id === ADMIN_USER_ID;
  $("login-open").classList.toggle("hidden", !!user);
  $("logout-button").classList.toggle("hidden", !user);
  ["admin-panel", "onair-panel", "playlist-section", "autodj-section", "jingle-section", "jingle-admin"]
    .forEach(id => $(id).classList.toggle("hidden", !isAdmin));
  ["prev-button", "next-button"].forEach(id => $(id).classList.toggle("hidden", !isAdmin));
  $("seek").disabled = !isAdmin;
  document.body.classList.toggle("is-admin", isAdmin);
  if (isAdmin && !wasAdmin) {
    listening = false;
    updatePresence();
    onBecameAdmin();
  }
  if (!isAdmin && wasAdmin) onLostAdmin();
  renderTracks();
  renderJingles();
  renderRadioUI();
}
async function onBecameAdmin() {
  await loadRadio();
  applyRadioToAdminForm();
  prefetchJingleDurations();
  await loadPlaylists();
}
function onLostAdmin() {
  playlists = [];
  selectedPlaylistId = null;
  selectedPlaylistTracks = [];
  monitorMuted = false;
  listening = false;
  syncPlayback();
}

// ---------- обработчики ----------
$("login-open").addEventListener("click", () => {
  $("login-modal").classList.remove("hidden");
  $("login-email").focus();
});
$("login-close").addEventListener("click", () => $("login-modal").classList.add("hidden"));
$("login-modal").addEventListener("click", e => { if (e.target === $("login-modal")) $("login-modal").classList.add("hidden"); });
$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const button = $("login-button");
  button.disabled = true;
  $("login-message").textContent = "Проверяем данные...";
  const {data, error} = await client.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-password").value
  });
  button.disabled = false;
  if (error) { $("login-message").textContent = error.message; return; }
  $("login-message").textContent = "";
  setAuthUI(data.user);
  $("login-modal").classList.add("hidden");
  toast(data.user.id === ADMIN_USER_ID ? "Вход выполнен" : "Вход выполнен. Для этого аккаунта админ-панель недоступна");
});
$("logout-button").addEventListener("click", async () => {
  const {error} = await client.auth.signOut();
  if (error) return toast(error.message);
  setAuthUI(null);
  toast("Вы вышли из аккаунта");
});
$("refresh-button").addEventListener("click", async () => {
  await loadTracks();
  await loadRadio();
  await loadPlaylists();
});
$("playlist-create-form").addEventListener("submit", createPlaylist);
$("playlist-delete").addEventListener("click", deletePlaylist);
$("playlist-play").addEventListener("click", playSelectedPlaylist);
$("search-input").addEventListener("input", renderTracks);
$("audio-file").addEventListener("change", () => {
  const file = $("audio-file").files[0];
  $("file-label").textContent = file ? file.name : "Выбери аудиофайл";
  if (file && !$("track-title").value) $("track-title").value = file.name.replace(/\.[^.]+$/, "");
});
$("cover-file").addEventListener("change", () => {
  const file = $("cover-file").files[0];
  $("cover-file-label").textContent = file ? file.name : "Добавить обложку (необязательно)";
});
$("upload-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isAdmin) return toast("Сначала войди в аккаунт");
  const file = $("audio-file").files[0];
  const coverFile = $("cover-file").files[0];
  const title = $("track-title").value.trim();
  const artist = $("track-artist").value.trim();
  const message = $("upload-message");
  const button = $("upload-button");
  if (!file) { message.textContent = "Сначала выбери файл."; return; }
  if (file.size > MAX_FILE_SIZE) { message.textContent = "Файл больше 50 МБ."; return; }
  if (coverFile) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(coverFile.type)) {
      message.textContent = "Обложка должна быть в формате JPG, PNG или WEBP.";
      return;
    }
    if (coverFile.size > 10 * 1024 * 1024) {
      message.textContent = "Обложка больше 10 МБ.";
      return;
    }
  }
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  let coverPath = null;
  button.disabled = true;
  message.textContent = "Определяем длительность и загружаем файл...";
  const duration = await getDuration(file);
  const {error: uploadError} = await client.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600", upsert: false, contentType: file.type || "audio/mpeg"
  });
  if (uploadError) {
    button.disabled = false;
    message.textContent = `Ошибка загрузки: ${uploadError.message}`;
    return;
  }
  if (coverFile) {
    const imageExt = coverFile.type === "image/png" ? "png" : coverFile.type === "image/webp" ? "webp" : "jpg";
    coverPath = `${Date.now()}-${crypto.randomUUID()}.${imageExt}`;
    const {error: coverError} = await client.storage.from(BUCKET).upload(coverPath, coverFile, {
      cacheControl: "3600", upsert: false, contentType: coverFile.type
    });
    if (coverError) {
      await client.storage.from(BUCKET).remove([path]);
      button.disabled = false;
      message.textContent = `Ошибка загрузки обложки: ${coverError.message}. Аудиофайл удален.`;
      return;
    }
  }
  const {error: insertError} = await client.from("tracks").insert({
    title, artist: artist || null, file_path: path, cover_path: coverPath, duration, is_jingle: false
  });
  if (insertError) {
    await client.storage.from(BUCKET).remove([path, ...(coverPath ? [coverPath] : [])]);
    button.disabled = false;
    message.textContent = `Ошибка записи в базу: ${insertError.message}. Загруженные файлы удалены.`;
    return;
  }
  $("upload-form").reset();
  $("file-label").textContent = "Выбери аудиофайл";
  $("cover-file-label").textContent = "Добавить обложку (необязательно)";
  message.textContent = "Готово! Трек добавлен.";
  button.disabled = false;
  toast("Трек успешно загружен");
  await loadTracks(true);
});

// Плеер
$("play-button").addEventListener("click", () => {
  if (isAdmin) return toggleOnAir();
  listening = !listening;
  syncPlayback();
  if (listening) unlockAudio();
  updatePresence();
  renderRadioUI();
  if (listening && radio.status !== "playing") toast("Эфир сейчас выключен. Музыка начнётся, как только он включится.");
});
$("next-button").addEventListener("click", () => stepTrack(1));
$("prev-button").addEventListener("click", adminPrevious);
$("volume").addEventListener("input", e => {
  const v = clampNumber(e.target.value, 0, 1, 0.8);
  if (isAdmin) {
    setMasterVolume(v);
  } else {
    listenerVolume = v;
    try { localStorage.setItem(LISTENER_VOLUME_KEY, String(v)); } catch (error) { /* ignore */ }
    syncPlayback();
  }
});
$("seek").addEventListener("input", () => { seekDragging = true; });
$("seek").addEventListener("change", e => {
  seekDragging = false;
  if (isAdmin) adminSeek(Number(e.target.value));
});
$("onair-toggle").addEventListener("click", toggleOnAir);
$("monitor-toggle").addEventListener("click", () => {
  monitorMuted = !monitorMuted;
  syncPlayback();
  renderRadioUI();
});
$("onair-jingle-button").addEventListener("click", () => playJingleOnAir($("onair-jingle-select").value));
$("autodj-start").addEventListener("click", startAutoDJ);
$("autodj-stop").addEventListener("click", stopAutoDJ);
$("jingle-upload").addEventListener("click", uploadJingle);
["jingle-mode", "jingle-frequency", "duck-return-time", "duck-volume-db", "transition-enabled", "transition-fade-out", "transition-fade-in", "between-jingle-select", "duck-jingle-select"].forEach(id => {
  $(id).addEventListener("change", () => {
    if (id === "jingle-mode") updateJingleModeControls();
    onAutoDJFormChange();
  });
});
$("jingle-file").addEventListener("change", () => {
  const file = $("jingle-file").files[0];
  $("jingle-file-label").textContent = file ? file.name : "Загрузить джингл";
  if (file && !$("jingle-title").value) $("jingle-title").value = file.name.replace(/\.[^.]+$/, "");
});
document.addEventListener("click", () => { if (isAdmin) unlockAudio(); });

// Главный цикл: держит воспроизведение в синхроне с состоянием эфира.
function startLoops() {
  setInterval(() => {
    syncPlayback();
    updateProgress();
    const sig = activeBetweenJingle()?.id || "";
    if (sig !== lastJingleSig) renderRadioUI();
    controllerTick();
  }, 250);
  setInterval(syncClock, 5 * 60 * 1000);
}

async function init() {
  startLoops();
  loadAutoDJLocal();
  try {
    const stored = parseFloat(localStorage.getItem(LISTENER_VOLUME_KEY));
    listenerVolume = clampNumber(stored, 0, 1, 1);
  } catch (error) { listenerVolume = 1; }
  renderRadioUI();
  try {
    const {data: {session}, error} = await client.auth.getSession();
    if (error) throw error;
    setConnection(true, "SUPABASE ONLINE");
    await syncClock();
    await loadTracks();
    setAuthUI(session?.user || null);
    if (!isAdmin) await loadRadio();
    subscribeRadio();
    setupPresence();
    client.auth.onAuthStateChange((_event, sessionNow) => {
      const nextId = sessionNow?.user?.id || null;
      if (nextId === (currentUser?.id || null)) return;
      setTimeout(() => setAuthUI(sessionNow?.user || null), 0);
    });
  } catch (err) {
    console.error(err);
    setConnection(false, "ОШИБКА ПОДКЛЮЧЕНИЯ");
    $("library-list").innerHTML = `<div class="empty-state">Не удалось подключиться к Supabase. Проверь URL и Publishable key.</div>`;
  }
}
init();
