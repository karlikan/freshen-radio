// FRESHEN MUSIC RADIO 0.2
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
  tracks = data || [];
  $("library-message").textContent = "";
  renderTracks();
}
function playTrack(index) {
  if (index < 0 || index >= tracks.length) return;
  currentIndex = index;
  const t = tracks[index];
  audio.src = trackUrl(t);
  $("now-title").textContent = t.title;
  $("now-artist").textContent = t.artist || "Неизвестный исполнитель";
  audio.play().catch(err => { console.error(err); toast("Не удалось воспроизвести файл. Проверь Public bucket."); });
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
  const {error: storageError} = await client.storage.from(BUCKET).remove([track.file_path]);
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

$("upload-form").addEventListener("submit",async e => {
  e.preventDefault();
  if(!currentUser) return toast("Сначала войди в аккаунт");
  const file = $("audio-file").files[0];
  const title = $("track-title").value.trim();
  const artist = $("track-artist").value.trim();
  const message = $("upload-message");
  const button = $("upload-button");
  if(!file) { message.textContent = "Сначала выбери файл."; return; }
  if(file.size > MAX_FILE_SIZE) { message.textContent = "Файл больше 50 МБ."; return; }
  const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g,"");
  const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
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
  const {error: insertError} = await client.from("tracks").insert({
    title,artist:artist || null,file_path:path,duration
  });
  if(insertError) {
    await client.storage.from(BUCKET).remove([path]);
    button.disabled = false;
    message.textContent = `Ошибка записи в базу: ${insertError.message}. Файл удален.`;
    return;
  }
  $("upload-form").reset();
  $("file-label").textContent = "Выбери аудиофайл";
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
$("volume").addEventListener("input",e => audio.volume = Number(e.target.value));
$("seek").addEventListener("input",e => {
  if(Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(e.target.value) / 100;
});
audio.addEventListener("timeupdate",() => {
  $("current-time").textContent = formatTime(audio.currentTime);
  $("total-time").textContent = formatTime(audio.duration);
  if(Number.isFinite(audio.duration) && audio.duration > 0) $("seek").value = audio.currentTime / audio.duration * 100;
});
audio.addEventListener("play",() => { $("play-button").textContent = "Ⅱ"; renderTracks(); });
audio.addEventListener("pause",() => { $("play-button").textContent = "▶"; renderTracks(); });
audio.addEventListener("ended",playNext);

async function init() {
  audio.volume = 0.8;
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
