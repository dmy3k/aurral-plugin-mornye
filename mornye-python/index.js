import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WORK_DIR = ".aurral-mornye";
const AUDIO_EXTENSIONS = new Set([
  ".flac", ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav", ".aiff", ".aif", ".alac", ".wv", ".tta",
]);
const QUALITIES = new Set(["LOSSLESS", "HI_RES_LOSSLESS", "HI_RES", "HIGH", "LOW"]);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RESULTS = 50;
const STABLE_POLLS = 2;
const EMPTY_POLLS = 3;
const MAX_NETWORK_ERRORS = 8;
const STALE_MS = 24 * 60 * 60 * 1000;


function config(settings) {
  const url = String(settings.url || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("Set the Mornye URL in the plugin settings");
  const mornyeRoot = String(settings.sharedPathMornye || "").trim();
  if (!mornyeRoot) throw new Error("Set the shared folder in the plugin settings");
  // Aurral's remote path mappings don't apply to plugins; the same path in both containers is the default.
  const root = String(settings.sharedPathAurral || "").trim() || mornyeRoot;
  const quality = String(settings.quality || "").trim().toUpperCase();
  const services = String(settings.services || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const timeoutMinutes = Number(settings.timeoutMinutes) > 0 ? Number(settings.timeoutMinutes) : 60;
  return {
    url,
    token: String(settings.token || "").trim(),
    root: path.resolve(root),
    mornyeRoot: mornyeRoot.replace(/\/+$/, "") || "/",
    quality: QUALITIES.has(quality) ? quality : "LOSSLESS",
    services,
    timeoutMs: timeoutMinutes * 60 * 1000,
  };
}


async function api(cfg, method, route, body) {
  const headers = { Accept: "application/json" };
  if (cfg.token) headers.Cookie = `mornye_web_token=${encodeURIComponent(cfg.token)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${cfg.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const err = new Error(`Cannot reach Mornye at ${cfg.url}: ${error.message}`);
    err.network = true;
    throw err;
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data?.error || data?.detail || text.slice(0, 200) || response.statusText;
    const err = new Error(`Mornye answered ${response.status}: ${detail}`);
    err.status = response.status;
    err.network = response.status >= 500;
    throw err;
  }
  return data;
}

async function searchTracks(cfg, query, limit) {
  const data = await api(
    cfg,
    "GET",
    `/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return (data?.tracks || []).filter((t) => t && t.id);
}


function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[([].*?[)\]]/g, " ")
    .replace(/\s-\s.*(remaster|version|mono|stereo|edit|mix).*$/, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      shared++;
      grams.set(g, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

function artistScore(wanted, got) {
  const w = normalize(wanted);
  const g = normalize(got);
  if (!w || !g) return 0;
  if (g.includes(w) || w.includes(g)) return 1;
  return Math.max(
    ...String(got)
      .split(/,|;|&|\band\b/i)
      .map((part) => dice(w, normalize(part))),
  );
}

function scoreTrack(request, track) {
  const title = dice(normalize(request.title), normalize(track.title));
  const artist = Math.max(
    artistScore(request.artist, track.artists),
    artistScore(request.artist, track.album_artist),
  );
  const album = request.album ? dice(normalize(request.album), normalize(track.album)) : title;
  let duration = 0.5;
  if (request.durationMs && track.duration_ms) {
    const diff = Math.abs(request.durationMs - track.duration_ms);
    duration = diff <= 3000 ? 1 : diff <= 10000 ? 0.5 : 0;
  }
  return { title, artist, album, duration, score: 0.5 * title + 0.3 * artist + 0.1 * album + 0.1 * duration };
}

function rank(request, tracks) {
  return tracks
    .map((track) => ({ track, ...scoreTrack(request, track) }))
    .filter((m) => m.title >= 0.6 && m.artist >= 0.5)
    .sort((a, b) => b.score - a.score);
}

function trackUrl(track) {
  return track.external_url || `https://open.spotify.com/track/${track.id}`;
}


function jobFolder(cfg, id) {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid download id");
  return path.join(cfg.root, WORK_DIR, id);
}

function statePath(dataFolder, id) {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid download id");
  return path.join(dataFolder, "jobs", `${id}.json`);
}

function toMornyePath(cfg, hostPath) {
  const relative = path.relative(cfg.root, hostPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Download folder is outside the shared folder");
  }
  return path.posix.join(cfg.mornyeRoot, ...relative.split(path.sep));
}

async function makeOpenDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o777 });
  // Mornye usually runs as another user, so it must be allowed to write here.
  for (let d = dir; d.includes(WORK_DIR); d = path.dirname(d)) {
    await fs.chmod(d, 0o777).catch(() => {});
    if (path.basename(d) === WORK_DIR) break;
  }
}

async function listAudio(dir) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const { size } = await fs.stat(full);
        found.push({ full, size });
      }
    }
  }
  await walk(dir);
  return found;
}

// Aurral reads "A - B" filenames as "Artist - Title", and Mornye names files "Title - Artist",
// which Aurral then denies as a title contradiction. The title alone agrees with the file's tags.
function fileNameFor(title, source) {
  const base = String(title || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150)
    .replace(/^\.+/, "");
  return (base || "track") + path.extname(source).toLowerCase();
}

async function place(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.link(source, destination);
    return "hardlinked";
  } catch {
    // Linux refuses hardlinks to another user's file (protected_hardlinks), and across filesystems.
  }
  try {
    await fs.copyFile(source, destination);
    return "copied";
  } catch (error) {
    throw new Error(`Aurral can't read ${source} written by Mornye (${error.code || error.message})`);
  }
}


async function saveState(dataFolder, state) {
  const file = statePath(dataFolder, state.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state));
}

async function loadState(dataFolder, id) {
  try {
    return JSON.parse(await fs.readFile(statePath(dataFolder, id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Best effort: a failed cleanup must not fail a download Aurral already has.
async function removeState(cfg, dataFolder, id) {
  for (const target of [jobFolder(cfg, id), statePath(dataFolder, id)]) {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      console.warn(`could not remove ${target}: ${error.code || error.message}`);
    }
  }
}

async function sweep(cfg, dataFolder) {
  try {
    const dir = path.join(dataFolder, "jobs");
    for (const name of await fs.readdir(dir).catch(() => [])) {
      const id = name.replace(/\.json$/, "");
      if (!ID_PATTERN.test(id)) continue;
      const state = await loadState(dataFolder, id).catch(() => null);
      if (!state || Date.now() - state.startedAt > STALE_MS) await removeState(cfg, dataFolder, id);
    }
    const work = path.join(cfg.root, WORK_DIR);
    for (const name of await fs.readdir(work).catch(() => [])) {
      if (!ID_PATTERN.test(name)) continue;
      const { mtimeMs } = await fs.stat(path.join(work, name));
      if (Date.now() - mtimeMs > 2 * STALE_MS) await fs.rm(path.join(work, name), { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`cleanup skipped: ${error.message}`);
  }
}


// Poll Mornye once; returns "active", "done", or throws with Mornye's reason.
async function poll(cfg, state) {
  const folder = jobFolder(cfg, state.id);
  if (state.jobId === "direct") {
    // Mornye started the download without a job we can follow, so wait for the files to settle.
    const files = await listAudio(folder);
    const size = files.reduce((sum, f) => sum + f.size, 0);
    state.stable = files.length && size === state.lastSize ? (state.stable || 0) + 1 : 0;
    state.lastSize = size;
    return state.stable >= STABLE_POLLS ? "done" : "active";
  }
  let job;
  try {
    job = await api(cfg, "GET", `/api/v1/downloads/${encodeURIComponent(state.jobId)}`);
  } catch (error) {
    if (error.status === 404) throw new Error("Mornye no longer knows this job");
    throw error;
  }
  if (job.status === "failed" || job.status === "cancelled") {
    throw new Error(job.error || `Mornye job ${job.status}`);
  }
  if (job.status !== "done") return "active";
  if ((await listAudio(folder)).length) return "done";
  if ((state.empty = (state.empty || 0) + 1) >= EMPTY_POLLS) {
    throw new Error(
      "Mornye finished but wrote no audio to the shared folder. Check the folder setting, and that Mornye isn't skipping the track as already in one of its library folders.",
    );
  }
  return "active";
}

async function cancelJob(cfg, state) {
  if (!state.jobId || state.jobId === "direct") return;
  await api(cfg, "POST", `/api/v1/downloads/${encodeURIComponent(state.jobId)}/cancel`).catch(() => {});
}


export default {
  async test({ settings }) {
    const cfg = config(settings);
    const info = await api(cfg, "GET", "/api/v1/info");
    if (info?.multiuser) {
      throw new Error("Mornye is in multi-user mode. This plugin needs single-user mode (output_dir is ignored otherwise)");
    }
    const probe = path.join(cfg.root, WORK_DIR);
    await makeOpenDir(probe).catch((error) => {
      throw new Error(`Aurral can't write to the shared folder ${cfg.root}: ${error.message}`);
    });
    const health = await api(cfg, "GET", "/api/v1/extensions").catch(() => null);
    const installed = (health?.providers || []).filter((p) => p.installed).map((p) => p.provider);
    const providers = installed.length
      ? `Providers: ${installed.join(", ")}.`
      : "Warning: Mornye lists no installed providers, so nothing can be downloaded until you add an extension registry.";
    return { message: `Connected to Mornye ${info?.version || ""}. Shared folder is writable. ${providers}`.replace("  ", " ") };
  },

  downloadSource: {
    async search({ settings, dataFolder, track }) {
      const cfg = config(settings);
      if (!track?.title) return [];
      await sweep(cfg, dataFolder);
      const request = {
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
      };
      const tracks = await searchTracks(cfg, [track.artist, track.title].filter(Boolean).join(" "), 20);
      return rank(request, tracks)
        .slice(0, MAX_RESULTS)
        .map(({ track: t }) => ({
          id: String(t.id),
          title: t.title,
          artist: t.artists,
          album: t.album || null,
          durationMs: t.duration_ms || null,
          data: { url: trackUrl(t) },
        }));
    },

    async download({ settings, dataFolder, result }) {
      const cfg = config(settings);
      if (!result?.data?.url) throw new Error("Result has no Mornye link");
      await sweep(cfg, dataFolder);
      const state = { id: randomUUID(), title: result.title, startedAt: Date.now(), networkErrors: 0 };
      const folder = jobFolder(cfg, state.id);
      await makeOpenDir(folder);
      const body = { url: result.data.url, quality: cfg.quality, output_dir: toMornyePath(cfg, folder) };
      if (cfg.services.length) body.services = cfg.services;
      try {
        const job = await api(cfg, "POST", "/api/v1/downloads", body);
        state.jobId = job?.id || "direct";
        await saveState(dataFolder, state);
      } catch (error) {
        await removeState(cfg, dataFolder, state.id);
        throw error;
      }
      return { pending: state.id };
    },

    async status({ settings, dataFolder, id, directory }) {
      const cfg = config(settings);
      const state = await loadState(dataFolder, id);
      if (!state) throw new Error("This download is no longer known to the plugin");

      const fail = async (error) => {
        await cancelJob(cfg, state);
        await removeState(cfg, dataFolder, id);
        throw error;
      };
      if (Date.now() - state.startedAt > cfg.timeoutMs) return fail(new Error("Download timed out"));

      let outcome;
      try {
        outcome = await poll(cfg, state);
        state.networkErrors = 0;
      } catch (error) {
        if (!error.network || ++state.networkErrors >= MAX_NETWORK_ERRORS) return fail(error);
        outcome = "active";
      }
      if (outcome !== "done") {
        await saveState(dataFolder, state);
        return { done: false };
      }

      const files = await listAudio(jobFolder(cfg, id));
      const file = files.sort((a, b) => b.size - a.size)[0];
      const name = fileNameFor(state.title, file.full);
      let how;
      try {
        how = await place(file.full, path.join(directory, name));
      } catch (error) {
        return fail(error);
      }
      console.log(`"${state.title}": ${how} ${file.full} into ${directory} as "${name}"`);
      await removeState(cfg, dataFolder, id);
      return { done: true, path: name };
    },

    async discard({ settings, dataFolder, id }) {
      const cfg = config(settings);
      const state = await loadState(dataFolder, id);
      if (state) await cancelJob(cfg, state);
      await removeState(cfg, dataFolder, id);
    },
  },
};
