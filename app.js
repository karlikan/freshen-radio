// FRESHEN MUSIC RADIO 1.1
// Используй только Publishable key. Никогда не вставляй service_role или secret key.
const SUPABASE_URL = "https://dyuybnfbtcvtkkyauqmd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_iqNXYa5VEjr81zOaQvS0uQ_QXyvV-2o";
const BUCKET = "tracks";
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const $ = id => document.getElementById(id);
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const audio = $("audio-player");
let tracks = [];
let currentIndex = -1;
let currentUser = null;
let playlists = [];
let selectedPlaylistId = null;
let selectedPlaylistTracks = [];
let activeQueue = null;
let jingles = [];
let selectedDuckJingleId = null;
let selectedBetweenJingleId = null;
let autoDJEnabled = false;
let songsSinceJingle = 0;
let baseVolume = 0.8;
let jingleBusy = false;
let volumeFadeFrame = 0;
let volumeFadeToken = 0;
let musicDucked = false;
let transitionFadeStarted = false;
let transitionPending = false;

const AUTODJ_SETTINGS_KEY = "freshen-radio-autodj-settings";

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
}

function getAutoDJSettings() {
  return {
    mode: $("jingle-mode").value === "duck" ? "duck" : "between",
    frequency: Math.round(clampNumber($("jingle-frequency").value, 1, 1000, 2)),
    duckFadeOut: clampNumber($("duck-fade-out").value, 0.1, 10, 2),
    duckFadeIn: clampNumber($("duck-fade-in").value, 0.1, 10, 2),
    duckDb: clampNumber($("duck-volume-db").value, 0, 40, 12),
    transitionEnabled: $("transition-enabled").checked,
    transitionFadeOut: clampNumber($("transition-fade-out").value, 0.1, 10, 2),
    transitionFadeIn: clampNumber($("transition-fade-in").value, 0.1, 10, 2),
    duckJingleId: $("duck-jingle-select")?.value || selectedDuckJingleId || null,
    betweenJingleId: $("between-jingle-select")?.value || selectedBetweenJingleId || null
  };
}

function saveAutoDJSettings() {
  const settings = getAutoDJSettings();

  selectedDuckJingleId = settings.duckJingleId;
  selectedBetweenJingleId = settings.betweenJingleId;

  $("jingle-frequency").value = settings.frequency;

  try {
    localStorage.setItem(AUTODJ_SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Не удалось сохранить настройки AutoDJ", error);
  }
}

function loadAutoDJSettings() {
  let settings = {};

  try {
    settings = JSON.parse(localStorage.getItem(AUTODJ_SETTINGS_KEY) || "{}");
  } catch (error) {
    settings = {};
  }

  $("jingle-mode").value = settings.mode === "duck" ? "duck" : "between";
  $("jingle-frequency").value = Math.round(clampNumber(settings.frequency, 1, 1000, 2));

  $("duck-fade-out").value = clampNumber(settings.duckFadeOut ?? settings.fadeOut, 0.1, 10, 2);
  $("duck-fade-in").value = clampNumber(settings.duckFadeIn ?? settings.fadeIn, 0.1, 10, 2);
  $("duck-volume-db").value = clampNumber(settings.duckDb, 0, 40, 12);

  $("transition-enabled").checked = settings.transitionEnabled === true;
  $("transition-fade-out").value = clampNumber(settings.transitionFadeOut, 0.1, 10, 2);
  $("transition-fade-in").value = clampNumber(settings.transitionFadeIn, 0.1, 10, 2);

  selectedDuckJingleId = settings.duckJingleId || null;
  selectedBetweenJingleId = settings.betweenJingleId || null;

  updateJingleModeControls();
}

function getDuckFactor() {
  const db = clampNumber($("duck-volume-db").value, 0, 40, 12);
  return Math.pow(10, -db / 20);
}
function fadeMusicVolume(targetVolume, durationSeconds) {
  volumeFadeToken++;
  const token = volumeFadeToken;

  if (volumeFadeFrame) {
    cancelAnimationFrame(volumeFadeFrame);
    volumeFadeFrame = 0;
  }

  const startVolume = audio.volume;
  const target = clampNumber(targetVolume, 0, 1, baseVolume);
  const duration = clampNumber(durationSeconds, 0.1, 10, 2) * 1000;

  return new Promise(resolve => {
    const startTime = performance.now();

    function step(now) {
      if (token !== volumeFadeToken) {
        resolve(false);
        return;
      }

      const progress = Math.min(1, (now - startTime) / duration);
      const eased = progress * progress * (3 - 2 * progress);

      audio.volume = startVolume + (target - startVolume) * eased;

      if (progress < 1) {
        volumeFadeFrame = requestAnimationFrame(step);
      } else {
        volumeFadeFrame = 0;
        audio.volume = target;
        resolve(true);
      }
    }

    volumeFadeFrame = requestAnimationFrame(step);
  });
}
let toastTimer;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2,"0")}`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function setConnection(ok, text) {
  $("connection-status").classList.toggle("error", !ok);
  $("connection-status").innerHTML = `<i></i> ${text}`;
}
function setAuthUI(user) {
  currentUser = user;
  $("login-open").classList.toggle("hidden", !!user);
  $("logout-button").classList.toggle("hidden", !user);
  $("admin-panel").classList.toggle("hidden", !user);
}
function trackUrl(track) {
  return client.storage.from(BUCKET).getPublicUrl(track.file_path).data.publicUrl;
}
function renderTracks() {
  const query = $("search-input").value.trim().toLowerCase();
  const filtered = tracks.filter(t => `${t.title} ${t.artist || ""}`.toLowerCase().includes(query));
  $("track-count").textContent = tracks.length;
  const list = $("library-list");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">${tracks.length ? "Ничего не найдено." : "Медиатека пока пуста. Войди в аккаунт администратора, чтобы загрузить первый трек."}</div>`;
    return;
  }
  list.innerHTML = filtered.map(t => {
    const index = tracks.findIndex(x => x.id === t.id);
    const active = index === currentIndex && !audio.paused;
    return `<div class="track-row">
      <span class="track-number">${String(index+1).padStart(2,"0")}</span>
      <button class="track-play" data-play="${t.id}">${active ? "Ⅱ" : "▶"}</button>
      <div class="track-info"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist || "Неизвестный исполнитель")}</small></div>
      <span class="track-duration">${t.duration ? formatTime(t.duration) : "--:--"}</span>
      ${currentUser ? `<button class="mini-action" data-add-playlist="${t.id}" title="Добавить в выбранный плейлист">＋</button><button class="delete-track" data-delete="${t.id}" title="Удалить">×</button>` : ""}
    </div>`;
  }).join("");
  list.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => { activeQueue = null; playTrackById(b.dataset.play); }));
  list.querySelectorAll("[data-add-playlist]").forEach(b => b.addEventListener("click", () => addTrackToPlaylist(b.dataset.addPlaylist)));
  list.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", () => deleteTrack(b.dataset.delete)));
}
async function loadTracks() {
  $("library-list").innerHTML = `<div class="empty-state">Загружаем медиатеку...</div>`;
  const {data,error} = await client.from("tracks").select("*").order("created_at",{ascending:true});
  if (error) {
    $("library-list").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    $("library-message").textContent = "Проверь доступ к таблице и настройки RLS.";
    return;
  }
  tracks = (data || []).filter(t => !t.is_jingle);
  jingles = (data || []).filter(t => t.is_jingle === true);
  renderJingles();
  $("library-message").textContent = "";
  renderTracks();
}
function playTrack(index) {
  if (index < 0 || index >= tracks.length) return;

  currentIndex = index;
  const t = tracks[index];
  const useTransitionFadeIn = transitionPending;

  transitionPending = false;
  transitionFadeStarted = false;

  if (useTransitionFadeIn) {
    audio.volume = 0;
  } else if (!musicDucked) {
    audio.volume = baseVolume;
  }

  audio.src = trackUrl(t);

  const artwork = document.querySelector(".player-art-logo");
  if (artwork) {
    artwork.src = t.cover_path
      ? client.storage.from(BUCKET).getPublicUrl(t.cover_path).data.publicUrl
      : "Freshen Logo.png";

    artwork.onerror = () => {
      artwork.onerror = null;
      artwork.src = "Freshen Logo.png";
    };
  }

  $("now-title").textContent = t.title;
  $("now-artist").textContent = t.artist || "Неизвестный исполнитель";

  audio.play().then(() => {
    if (useTransitionFadeIn) {
      fadeMusicVolume(baseVolume, getAutoDJSettings().transitionFadeIn);
    }
  }).catch(err => {
    console.error(err);
    toast("Не удалось воспроизвести файл. Проверь Public bucket.");
  });
}
function playTrackById(id) {
  const index = tracks.findIndex(t => t.id === id);
  if (index === currentIndex && !audio.paused) audio.pause();
  else playTrack(index);
}
function playNext() {
  if (activeQueue && activeQueue.length) {
    const currentId = tracks[currentIndex]?.id;
    const queueIndex = activeQueue.indexOf(currentId);
    const nextId = activeQueue[(queueIndex + 1 + activeQueue.length) % activeQueue.length];
    const nextIndex = tracks.findIndex(t => t.id === nextId);
    if (nextIndex >= 0) return playTrack(nextIndex);
    activeQueue = null;
  }
  if (tracks.length) playTrack((currentIndex + 1) % tracks.length);
}
function playPrevious() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) audio.currentTime = 0;
  else playTrack((currentIndex - 1 + tracks.length) % tracks.length);
}
async function deleteTrack(id) {
  if (!currentUser) return;
  const track = tracks.find(t => t.id === id);
  if (!track || !confirm(`Удалить «${track.title}» из медиатеки?`)) return;
  const pathsToRemove = [track.file_path, track.cover_path].filter(Boolean);
  const {error: storageError} = await client.storage.from(BUCKET).remove(pathsToRemove);
  if (storageError) return toast(`Ошибка удаления файла: ${storageError.message}`);
  const {error: dbError} = await client.from("tracks").delete().eq("id",id);
  if (dbError) {
    toast(`Файл удален, но запись осталась: ${dbError.message}`);
    await loadTracks();
    await loadPlaylists();
    return;
  }
  if (tracks[currentIndex]?.id === id) {
    audio.pause(); audio.removeAttribute("src"); currentIndex = -1;
    $("now-title").textContent = "Ничего не воспроизводится";
    $("now-artist").textContent = "Выбери трек из библиотеки";
  }
  toast("Трек удален");
  await loadTracks();
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

async function loadPlaylists() {
  const {data,error} = await client.from("playlists").select("*").order("created_at",{ascending:true});
  if (error) {
    $("playlist-list").innerHTML = `<div class="empty-state">Ошибка загрузки: ${escapeHtml(error.message)}</div>`;
    return;
  }
  playlists = data || [];
  if (!playlists.some(p => p.id === selectedPlaylistId)) selectedPlaylistId = playlists[0]?.id || null;
  renderPlaylists();
  if (selectedPlaylistId) await loadPlaylistTracks();
  else renderPlaylistTracks();
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
    activeQueue = null;
    renderPlaylists();
    await loadPlaylistTracks();
  }));
}

async function loadPlaylistTracks() {
  if (!selectedPlaylistId) return renderPlaylistTracks();
  const playlist = playlists.find(p => p.id === selectedPlaylistId);
  $("selected-playlist-name").textContent = playlist?.name || "Плейлист";
  const {data,error} = await client.from("playlist_tracks")
    .select("id,playlist_id,track_id,position,tracks(id,title,artist,duration,file_path)")
    .eq("playlist_id",selectedPlaylistId)
    .order("position",{ascending:true});
  if (error) {
    $("playlist-track-list").innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(error.message)}</div>`;
    return;
  }
  selectedPlaylistTracks = data || [];
  renderPlaylistTracks();
}

function renderPlaylistTracks() {
  const list = $("playlist-track-list");
  const isAdmin = !!currentUser;
  $("playlist-admin").classList.toggle("hidden",!isAdmin);
  $("playlist-delete").classList.toggle("hidden",!isAdmin || !selectedPlaylistId);
  $("playlist-play").disabled = !selectedPlaylistTracks.length;

  if (!selectedPlaylistId) {
    list.innerHTML = "";
    $("playlist-hint").textContent = "Создай плейлист или выбери существующий.";
    return;
  }

  $("playlist-hint").textContent = selectedPlaylistTracks.length + " трек(ов) в плейлисте";
  if (!selectedPlaylistTracks.length) {
    list.innerHTML = '<div class="empty-state">Здесь пока пусто. Добавь песни из медиатеки.</div>';
    return;
  }

  list.innerHTML = selectedPlaylistTracks.map((item,i) => {
    const t = item.tracks;
    if (!t) return "";
    return `<div class="playlist-track-row">
      <span class="track-number">${String(i+1).padStart(2,"0")}</span>
      <div class="track-info"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist || "Неизвестный исполнитель")}</small></div>
      <span class="track-duration">${t.duration ? formatTime(t.duration) : "--:--"}</span>
      ${isAdmin ? `<button class="mini-action" data-up="${item.id}" ${i===0?"disabled":""}>↑</button><button class="mini-action" data-down="${item.id}" ${i===selectedPlaylistTracks.length-1?"disabled":""}>↓</button><button class="delete-track" data-remove="${item.id}">×</button>` : ""}
    </div>`;
  }).join("");

  list.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click",() => movePlaylistTrack(b.dataset.up,-1)));
  list.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click",() => movePlaylistTrack(b.dataset.down,1)));
  list.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click",() => removePlaylistTrack(b.dataset.remove)));
}

async function createPlaylist(e) {
  e.preventDefault();
  if (!currentUser) return toast("Сначала войди в аккаунт");
  const name = $("playlist-name").value.trim();
  if (!name) return;
  const {data,error} = await client.from("playlists").insert({name,created_by:currentUser.id}).select().single();
  if (error) return toast("Ошибка создания: " + error.message);
  $("playlist-create-form").reset();
  selectedPlaylistId = data.id;
  await loadPlaylists();
  toast("Плейлист создан");
}

async function addTrackToPlaylist(id) {
  if (!currentUser) return toast("Сначала войди в аккаунт");
  if (!selectedPlaylistId) return toast("Сначала создай или выбери плейлист");
  const maxPosition = selectedPlaylistTracks.reduce((m,x) => Math.max(m,x.position || 0),-1);
  const {error} = await client.from("playlist_tracks").insert({
    playlist_id:selectedPlaylistId,track_id:id,position:maxPosition+1
  });
  if (error) return toast(error.code === "23505" ? "Этот трек уже есть в плейлисте" : error.message);
  await loadPlaylistTracks();
  toast("Трек добавлен в плейлист");
}

async function removePlaylistTrack(id) {
  if (!currentUser) return;
  const {error} = await client.from("playlist_tracks").delete().eq("id",id);
  if (error) return toast(error.message);
  await loadPlaylistTracks();
}

async function movePlaylistTrack(id,delta) {
  if (!currentUser) return;
  const index = selectedPlaylistTracks.findIndex(x => x.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= selectedPlaylistTracks.length) return;
  const rows = [...selectedPlaylistTracks];
  [rows[index],rows[target]] = [rows[target],rows[index]];
  for (let i=0;i<rows.length;i++) {
    const {error} = await client.from("playlist_tracks").update({position:i}).eq("id",rows[i].id);
    if (error) return toast("Ошибка изменения порядка: " + error.message);
  }
  await loadPlaylistTracks();
}

async function deletePlaylist() {
  if (!currentUser || !selectedPlaylistId) return;
  const p = playlists.find(x => x.id === selectedPlaylistId);
  if (!confirm(`Удалить плейлист «${p?.name || ""}»? Сами треки останутся в медиатеке.`)) return;
  const {error} = await client.from("playlists").delete().eq("id",selectedPlaylistId);
  if (error) return toast(error.message);
  selectedPlaylistId = null;
  activeQueue = null;
  await loadPlaylists();
  toast("Плейлист удален");
}

function playSelectedPlaylist() {
  if (!selectedPlaylistTracks.length) return;
  activeQueue = selectedPlaylistTracks.map(x => x.track_id).filter(id => tracks.some(t => t.id === id));
  const firstIndex = tracks.findIndex(t => t.id === activeQueue[0]);
  if (firstIndex >= 0) {
    playTrack(firstIndex);
    toast("Запущен плейлист");
  }
}
$("login-open").addEventListener("click", () => {
  $("login-modal").classList.remove("hidden");
  $("login-email").focus();
});
$("login-close").addEventListener("click", () => $("login-modal").classList.add("hidden"));
$("login-modal").addEventListener("click",e => { if(e.target === $("login-modal")) $("login-modal").classList.add("hidden"); });

$("login-form").addEventListener("submit",async e => {
  e.preventDefault();
  const button = $("login-button");
  button.disabled = true;
  $("login-message").textContent = "Проверяем данные...";
  const {data,error} = await client.auth.signInWithPassword({
    email:$("login-email").value.trim(),
    password:$("login-password").value
  });
  button.disabled = false;
  if(error) { $("login-message").textContent = error.message; return; }
  setAuthUI(data.user);
  $("login-modal").classList.add("hidden");
  toast("Вход выполнен");
  renderTracks();
});
$("logout-button").addEventListener("click",async () => {
  const {error} = await client.auth.signOut();
  if(error) return toast(error.message);
  setAuthUI(null);
  toast("Вы вышли из аккаунта");
  renderTracks();
});
$("refresh-button").addEventListener("click",async () => { await loadTracks(); await loadPlaylists(); });
$("playlist-create-form").addEventListener("submit",createPlaylist);
$("playlist-delete").addEventListener("click",deletePlaylist);
$("playlist-play").addEventListener("click",playSelectedPlaylist);
$("search-input").addEventListener("input",renderTracks);

$("audio-file").addEventListener("change",() => {
  const file = $("audio-file").files[0];
  $("file-label").textContent = file ? file.name : "Выбери аудиофайл";
  if(file && !$("track-title").value) $("track-title").value = file.name.replace(/\.[^.]+$/,"");
});

$("cover-file").addEventListener("change", () => {
  const file = $("cover-file").files[0];
  $("cover-file-label").textContent = file ? file.name : "Добавить обложку (необязательно)";
});

$("upload-form").addEventListener("submit",async e => {
  e.preventDefault();
  if(!currentUser) return toast("Сначала войди в аккаунт");

  const file = $("audio-file").files[0];
  const coverFile = $("cover-file").files[0];
  const title = $("track-title").value.trim();
  const artist = $("track-artist").value.trim();
  const message = $("upload-message");
  const button = $("upload-button");

  if(!file) { message.textContent = "Сначала выбери файл."; return; }
  if(file.size > MAX_FILE_SIZE) { message.textContent = "Файл больше 50 МБ."; return; }

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

  const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g,"");
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  let coverPath = null;

  button.disabled = true;
  message.textContent = "Определяем длительность и загружаем файл...";

  const duration = await getDuration(file);

  const {error: uploadError} = await client.storage.from(BUCKET).upload(path,file,{
    cacheControl:"3600",upsert:false,contentType:file.type || "audio/mpeg"
  });

  if(uploadError) {
    button.disabled = false;
    message.textContent = `Ошибка загрузки: ${uploadError.message}`;
    return;
  }

  if (coverFile) {
    const imageExt = coverFile.type === "image/png" ? "png" :
      coverFile.type === "image/webp" ? "webp" : "jpg";

    coverPath = `${Date.now()}-${crypto.randomUUID()}.${imageExt}`;

    const {error: coverError} = await client.storage.from(BUCKET).upload(coverPath,coverFile,{
      cacheControl:"3600",upsert:false,contentType:coverFile.type
    });

    if (coverError) {
      await client.storage.from(BUCKET).remove([path]);
      button.disabled = false;
      message.textContent = `Ошибка загрузки обложки: ${coverError.message}. Аудиофайл удален.`;
      return;
    }
  }

  const {error: insertError} = await client.from("tracks").insert({
    title,
    artist:artist || null,
    file_path:path,
    cover_path:coverPath,
    duration,
    is_jingle:false
  });

  if(insertError) {
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
  await loadTracks();
});
$("play-button").addEventListener("click",() => {
  if(!audio.src) return tracks.length ? playTrack(0) : toast("Сначала добавь треки");
  if(audio.paused) audio.play(); else audio.pause();
});
$("next-button").addEventListener("click",playNext);
$("prev-button").addEventListener("click",playPrevious);
$("volume").addEventListener("input", e => {
  baseVolume = clampNumber(e.target.value, 0, 1, 0.8);
  audio.volume = musicDucked ? baseVolume * getDuckFactor() : baseVolume;
});
$("seek").addEventListener("input",e => {
  if(Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(e.target.value) / 100;
});
audio.addEventListener("timeupdate",() => {
  $("current-time").textContent = formatTime(audio.currentTime);
  $("total-time").textContent = formatTime(audio.duration);

  if(Number.isFinite(audio.duration) && audio.duration > 0) {
    $("seek").value = audio.currentTime / audio.duration * 100;

    const settings = getAutoDJSettings();
    const remaining = audio.duration - audio.currentTime;

    const nextIsDuckJingle = autoDJEnabled &&
      settings.mode === "duck" &&
      jingles.length > 0 &&
      songsSinceJingle + 1 >= settings.frequency;

    if (
      settings.transitionEnabled &&
      !transitionFadeStarted &&
      !jingleBusy &&
      !nextIsDuckJingle &&
      remaining <= settings.transitionFadeOut
    ) {
      transitionFadeStarted = true;
      transitionPending = true;
      fadeMusicVolume(0, settings.transitionFadeOut);
    }
  }
});
audio.addEventListener("play",() => { $("play-button").textContent = "Ⅱ"; renderTracks(); });
audio.addEventListener("pause",() => { $("play-button").textContent = "▶"; renderTracks(); });
audio.addEventListener("ended",handleAutoDJEnded);


// FRESHEN MUSIC RADIO 1.1: AUTODJ AND JINGLES

// FRESHEN MUSIC RADIO 1.1: INDIVIDUAL JINGLE SELECTION

function updateJingleModeControls() {
  const mode = $("jingle-mode").value;

  $("between-jingle-setting").classList.toggle("hidden", mode !== "between");
  $("duck-jingle-setting").classList.toggle("hidden", mode !== "duck");
  $("duck-fade-settings").classList.toggle("hidden", mode !== "duck");
}
function renderJingleSelectors() {
  const betweenSelect = $("between-jingle-select");
  const duckSelect = $("duck-jingle-select");

  if (!betweenSelect || !duckSelect) return;

  const previousBetween = selectedBetweenJingleId || betweenSelect.value;
  const previousDuck = selectedDuckJingleId || duckSelect.value;

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

  selectedBetweenJingleId = fillSelect(betweenSelect, previousBetween);
  selectedDuckJingleId = fillSelect(duckSelect, previousDuck);

  saveAutoDJSettings();
  updateJingleModeControls();
}
const jingleAudio = new Audio();
jingleAudio.preload = "auto";

function renderJingles() {
  const list = $("jingle-list");
  if (!list) return;
  $("jingle-count").textContent = jingles.length + " JINGLES";
  renderJingleSelectors();

  if (!jingles.length) {
    list.innerHTML = '<div class="empty-state">Джинглов пока нет.</div>';
    return;
  }

  list.innerHTML = jingles.map(j => `
    <div class="track-row">
      <button class="track-play" data-play-jingle="${j.id}">▶</button>
      <div class="track-info"><strong>${escapeHtml(j.title)}</strong><small>RADIO JINGLE</small></div>
      ${currentUser ? `<button class="delete-track" data-delete-jingle="${j.id}">×</button>` : ""}
    </div>
  `).join("");

  list.querySelectorAll("[data-play-jingle]").forEach(b => {
    b.addEventListener("click", () => {
      const j = jingles.find(x => x.id === b.dataset.playJingle);
      if (!j) return;
      jingleAudio.src = trackUrl(j);
      jingleAudio.play().catch(() => toast("Не удалось воспроизвести джингл"));
    });
  });

  list.querySelectorAll("[data-delete-jingle]").forEach(b => {
    b.addEventListener("click", () => deleteJingle(b.dataset.deleteJingle));
  });
}

async function uploadJingle() {
  if (!currentUser) return toast("Сначала войди в аккаунт");

  const file = $("jingle-file").files[0];
  const title = $("jingle-title").value.trim() ||
    (file ? file.name.replace(/\.[^.]+$/, "") : "");

  if (!file) return $("jingle-message").textContent = "Выбери аудиофайл.";
  if (file.size > MAX_FILE_SIZE) return $("jingle-message").textContent = "Файл больше 50 МБ.";

  const button = $("jingle-upload");
  button.disabled = true;
  $("jingle-message").textContent = "Загружаю джингл...";

  const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const {error: uploadError} = await client.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "audio/mpeg"
  });

  if (uploadError) {
    button.disabled = false;
    $("jingle-message").textContent = uploadError.message;
    return;
  }

  const duration = await getDuration(file);
  const {error} = await client.from("tracks").insert({
    title,
    artist: "FRESHEN MUSIC RADIO",
    file_path: path,
    duration,
    is_jingle: true
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
  await loadTracks();
  toast("Джингл добавлен");
}

async function deleteJingle(id) {
  if (!currentUser) return;
  const j = jingles.find(x => x.id === id);
  if (!j || !confirm(`Удалить джингл «${j.title}»?`)) return;

  const {error: storageError} = await client.storage.from(BUCKET).remove([j.file_path]);
  if (storageError) return toast(storageError.message);

  const {error} = await client.from("tracks").delete().eq("id", id);
  if (error) return toast(error.message);

  await loadTracks();
  toast("Джингл удален");
}

function setAutoDJStatus(on) {
  $("autodj-status").textContent = on ? "● AUTODJ ON AIR" : "AUTODJ OFFLINE";
  $("autodj-status").classList.toggle("dj-active", on);
}

function stopAutoDJ() {
  autoDJEnabled = false;
  activeQueue = null;
  songsSinceJingle = 0;

  jingleAudio.pause();
  jingleAudio.onended = null;
  jingleBusy = false;
  musicDucked = false;

  fadeMusicVolume(baseVolume, getAutoDJSettings().fadeIn);
  setAutoDJStatus(false);
}

function startAutoDJ() {
  if (!selectedPlaylistTracks.length) {
    return toast("Сначала выбери плейлист с песнями");
  }

  activeQueue = selectedPlaylistTracks
    .map(item => item.track_id)
    .filter(id => tracks.some(t => t.id === id));

  if (!activeQueue.length) return toast("В плейлисте нет доступных треков");

  jingleAudio.pause();
  jingleAudio.onended = null;
  jingleBusy = false;
  musicDucked = false;

  baseVolume = clampNumber($("volume").value, 0, 1, 0.8);
  audio.volume = baseVolume;

  autoDJEnabled = true;
  songsSinceJingle = 0;

  const firstIndex = tracks.findIndex(t => t.id === activeQueue[0]);
  setAutoDJStatus(true);

  if (firstIndex >= 0) {
    playTrack(firstIndex);
    toast("AutoDJ запущен");
  }
}

function getNextQueueIndex() {
  if (!activeQueue || !activeQueue.length) return -1;
  const currentId = tracks[currentIndex]?.id;
  const position = activeQueue.indexOf(currentId);
  const nextId = activeQueue[(position + 1 + activeQueue.length) % activeQueue.length];
  return tracks.findIndex(t => t.id === nextId);
}

async function handleAutoDJEnded() {
  if (!autoDJEnabled) {
    playNext();
    return;
  }

  const nextIndex = getNextQueueIndex();

  if (nextIndex < 0) {
    stopAutoDJ();
    return;
  }

  songsSinceJingle++;

  const settings = getAutoDJSettings();

  const shouldPlayJingle =
    jingles.length > 0 &&
    songsSinceJingle >= settings.frequency;

  if (!shouldPlayJingle) {
    playTrack(nextIndex);
    return;
  }

  songsSinceJingle = 0;

  const selectedJingleId = settings.mode === "duck"
    ? selectedDuckJingleId
    : selectedBetweenJingleId;

  const jingle = jingles.find(item => item.id === selectedJingleId) || jingles[0];

  jingleBusy = true;
  jingleAudio.src = trackUrl(jingle);

  if (settings.mode === "between") {
    jingleAudio.onended = () => {
      jingleBusy = false;
      jingleAudio.onended = null;
      if (autoDJEnabled) playTrack(nextIndex);
    };

    try {
      await jingleAudio.play();
    } catch (error) {
      jingleBusy = false;
      jingleAudio.onended = null;
      if (autoDJEnabled) playTrack(nextIndex);
    }

    return;
  }

  transitionPending = false;
  transitionFadeStarted = false;

  playTrack(nextIndex);
  musicDucked = true;

  const fadeOutPromise = fadeMusicVolume(
    baseVolume * getDuckFactor(),
    settings.duckFadeOut
  );

  jingleAudio.onended = async () => {
    await fadeOutPromise;
    if (!jingleBusy) return;

    jingleBusy = false;
    jingleAudio.onended = null;
    musicDucked = false;

    if (autoDJEnabled) {
      await fadeMusicVolume(baseVolume, getAutoDJSettings().duckFadeIn);
    } else {
      audio.volume = baseVolume;
    }
  };

  try {
    await jingleAudio.play();
  } catch (error) {
    await fadeOutPromise;
    jingleBusy = false;
    jingleAudio.onended = null;
    musicDucked = false;
    await fadeMusicVolume(baseVolume, settings.duckFadeIn);
  }
}
$("autodj-start").addEventListener("click", startAutoDJ);
$("autodj-stop").addEventListener("click", stopAutoDJ);
$("jingle-upload").addEventListener("click", uploadJingle);

["jingle-mode", "jingle-frequency", "duck-fade-out", "duck-fade-in", "duck-volume-db", "transition-enabled", "transition-fade-out", "transition-fade-in"].forEach(id => {
  $(id).addEventListener("change", () => {
    if (id === "jingle-mode") updateJingleModeControls();
    saveAutoDJSettings();
  });
});

$("between-jingle-select").addEventListener("change", () => {
  selectedBetweenJingleId = $("between-jingle-select").value || null;
  saveAutoDJSettings();
});

$("duck-jingle-select").addEventListener("change", () => {
  selectedDuckJingleId = $("duck-jingle-select").value || null;
  saveAutoDJSettings();
});

$("jingle-file").addEventListener("change", () => {
  const file = $("jingle-file").files[0];
  $("jingle-file-label").textContent = file ? file.name : "Загрузить джингл";
  if (file && !$("jingle-title").value) {
    $("jingle-title").value = file.name.replace(/\.[^.]+$/, "");
  }
});

const originalSetAuthUI = setAuthUI;
setAuthUI = function(user) {
  originalSetAuthUI(user);
  $("jingle-admin").classList.toggle("hidden", !user);
};

async function init() {
  loadAutoDJSettings();
  baseVolume = clampNumber($("volume").value, 0, 1, 0.8);
  audio.volume = baseVolume;
  try {
    const {data:{session},error} = await client.auth.getSession();
    if(error) throw error;
    setAuthUI(session?.user || null);
    setConnection(true,"SUPABASE ONLINE");
    await loadTracks();
    await loadPlaylists();
    client.auth.onAuthStateChange((_event,sessionNow) => {
      setAuthUI(sessionNow?.user || null);
      renderTracks();
    });
  } catch(err) {
    console.error(err);
    setConnection(false,"ОШИБКА ПОДКЛЮЧЕНИЯ");
    $("library-list").innerHTML = `<div class="empty-state">Не удалось подключиться к Supabase. Проверь URL и Publishable key.</div>`;
  }
}
init();

