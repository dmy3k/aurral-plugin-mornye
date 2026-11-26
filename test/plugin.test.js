import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../mornye-python/index.js";

const source = plugin.downloadSource;

const CATALOGUE = [
  { id: "t1", title: "Alpha", artists: "The Band", album: "First Album", duration_ms: 200000, release_date: "2020-01-01", external_url: "https://open.spotify.com/track/t1" },
  { id: "t2", title: "Beta", artists: "The Band", album: "First Album", duration_ms: 180000, release_date: "2020-01-01", external_url: "https://open.spotify.com/track/t2" },
  { id: "t3", title: "Alpha (Live)", artists: "Other Act", album: "Live Stuff", duration_ms: 300000, release_date: "2019-01-01", external_url: "https://open.spotify.com/track/t3" },
];

async function startMornye(t, { token = "", jobBehaviour = () => "done", multiuser = false, direct = false, failFirstPolls = 0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mornye-shared-"));
  const jobs = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (token && !(req.headers.cookie || "").includes(`mornye_web_token=${token}`)) {
      return send(401, { error: "Missing or invalid ?token=" });
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/api/v1/info") return send(200, { version: "9.9", multiuser });
    if (url.pathname === "/api/v1/extensions") return send(200, { providers: [{ provider: "ext:demo", installed: true }, { provider: "ghost", installed: false }], totals: {} });
    if (url.pathname === "/api/v1/search") {
      const q = url.searchParams.get("q").toLowerCase();
      const words = q.split(" ");
      return send(200, { query: q, tracks: CATALOGUE.filter((c) => words.some((w) => c.title.toLowerCase().includes(w) || c.album.toLowerCase().includes(w))) });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/downloads") {
      const payload = JSON.parse(body);
      const id = `job${jobs.size}`;
      const host = payload.output_dir.replace("/app/downloads", root);
      const behaviour = jobBehaviour(payload, jobs.size);
      jobs.set(id, { status: behaviour === "failed" ? "failed" : "running", behaviour, host, payload });
      if (behaviour === "done") {
        await mkdir(path.join(host, "Artist", "Album"), { recursive: true });
        await writeFile(path.join(host, "Artist", "Album", "01 - Song.flac"), "audio-" + payload.url);
        await writeFile(path.join(host, "Artist", "Album", "song.lrc"), "lyrics");
        jobs.get(id).status = "done";
      }
      return send(202, direct ? {} : { id, status: "queued" });
    }
    const match = /^\/api\/v1\/downloads\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return send(404, { error: "No such job." });
      if (!match[2] && failFirstPolls > 0) {
        failFirstPolls--;
        return send(503, { error: "busy" });
      }
      if (match[2]) {
        job.status = "cancelled";
        return send(200, { id: match[1], status: "cancelled" });
      }
      return send(200, { id: match[1], status: job.status, error: job.status === "failed" ? "provider exploded" : null });
    }
    send(404, { error: "nope" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  const settings = {
    url: `http://127.0.0.1:${server.address().port}/`,
    token,
    sharedPathMornye: "/app/downloads",
    sharedPathAurral: root,
    quality: "lossless",
  };
  return { settings, root, jobs, calls };
}

async function dirs(t) {
  const data = await mkdtemp(path.join(os.tmpdir(), "mornye-data-"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "mornye-dest-"));
  t.after(() => Promise.all([rm(data, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })]));
  return { dataFolder: data, directory };
}

test("test() connects, and rejects multi-user mode", async (t) => {
  const ok = await startMornye(t, { token: "secret" });
  assert.match((await plugin.test({ settings: ok.settings })).message, /Connected to Mornye 9\.9.*Providers: ext:demo\./);
  const { sharedPathAurral, ...sameMount } = ok.settings;
  const aFile = path.join(ok.root, "file");
  await writeFile(aFile, "x");
  await assert.rejects(plugin.test({ settings: { ...sameMount, sharedPathMornye: path.join(aFile, "sub") } }), /can't write/);
  assert.match((await plugin.test({ settings: { ...sameMount, sharedPathMornye: ok.root } })).message, /Connected/);
  const bad = await startMornye(t, { multiuser: true });
  await assert.rejects(plugin.test({ settings: bad.settings }), /single-user/);
  const noToken = await startMornye(t, { token: "secret" });
  await assert.rejects(plugin.test({ settings: { ...noToken.settings, token: "wrong" } }), /401/);
});

test("search ranks the matching track first and drops others", async (t) => {
  const m = await startMornye(t);
  const { dataFolder } = await dirs(t);
  const results = await source.search({
    settings: m.settings,
    dataFolder,
    track: { artist: "The Band", title: "Alpha", album: "First Album", durationMs: 201000 },
  });
  assert.equal(results[0].id, "t1");
  assert.equal(results[0].data.url, "https://open.spotify.com/track/t1");
  assert.ok(!results.some((r) => r.id === "t3"));
  assert.deepEqual(await source.search({ settings: m.settings, dataFolder, track: { title: null } }), []);
});

test("track download: pending then done, file placed in directory", async (t) => {
  const m = await startMornye(t);
  const { dataFolder, directory } = await dirs(t);
  const [result] = await source.search({ settings: m.settings, dataFolder, track: { artist: "The Band", title: "Alpha" } });
  const { pending } = await source.download({ settings: m.settings, dataFolder, result });
  const [job] = m.jobs.values();
  assert.equal(job.payload.quality, "LOSSLESS");
  assert.match(job.payload.output_dir, /^\/app\/downloads\/\.aurral-mornye\/[0-9a-f-]{36}$/);
  const answer = await source.status({ settings: m.settings, dataFolder, id: pending, directory });
  assert.equal(answer.done, true);
  assert.equal((await readFile(path.join(directory, answer.path), "utf8")), "audio-https://open.spotify.com/track/t1");
  assert.deepEqual(await readdir(directory), ["01 - Song.flac"]);
  assert.deepEqual(await readdir(path.join(m.root, ".aurral-mornye")), []);
  assert.deepEqual(await readdir(path.join(dataFolder, "jobs")), []);
});

test("failed job surfaces Mornye's error and cleans up", async (t) => {
  const m = await startMornye(t, { jobBehaviour: () => "failed" });
  const { dataFolder, directory } = await dirs(t);
  const { pending } = await source.download({ settings: m.settings, dataFolder, result: { title: "x", data: { url: "https://x/1" } } });
  await assert.rejects(source.status({ settings: m.settings, dataFolder, id: pending, directory }), /provider exploded/);
  assert.deepEqual(await readdir(path.join(m.root, ".aurral-mornye")), []);
});

test("running job stays pending, and discard cancels it", async (t) => {
  const m = await startMornye(t, { jobBehaviour: () => "running" });
  const { dataFolder, directory } = await dirs(t);
  const { pending } = await source.download({ settings: m.settings, dataFolder, result: { title: "x", data: { url: "https://x/1" } } });
  assert.deepEqual(await source.status({ settings: m.settings, dataFolder, id: pending, directory }), { done: false });
  await source.discard({ settings: m.settings, dataFolder, id: pending });
  assert.equal([...m.jobs.values()][0].status, "cancelled");
  await assert.rejects(stat(path.join(m.root, ".aurral-mornye", pending)));
  await source.discard({ settings: m.settings, dataFolder, id: pending });
});

test("job that finishes without audio fails after a few polls", async (t) => {
  const m = await startMornye(t, { jobBehaviour: () => "empty" });
  const { dataFolder, directory } = await dirs(t);
  const { pending } = await source.download({ settings: m.settings, dataFolder, result: { title: "x", data: { url: "https://x/1" } } });
  [...m.jobs.values()][0].status = "done";
  assert.deepEqual(await source.status({ settings: m.settings, dataFolder, id: pending, directory }), { done: false });
  assert.deepEqual(await source.status({ settings: m.settings, dataFolder, id: pending, directory }), { done: false });
  await assert.rejects(source.status({ settings: m.settings, dataFolder, id: pending, directory }), /wrote no audio/);
});

test("'direct' downloads are detected by files settling", async (t) => {
  const m = await startMornye(t, { direct: true });
  const { dataFolder, directory } = await dirs(t);
  const { pending } = await source.download({ settings: m.settings, dataFolder, result: { title: "x", data: { url: "https://x/1" } } });
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await source.status({ settings: m.settings, dataFolder, id: pending, directory }));
  assert.deepEqual(answers.slice(0, 2), [{ done: false }, { done: false }]);
  assert.equal(answers[2].done, true);
});

test("a transient Mornye error while polling is retried", async (t) => {
  const m = await startMornye(t, { failFirstPolls: 1 });
  const { dataFolder, directory } = await dirs(t);
  const { pending } = await source.download({ settings: m.settings, dataFolder, result: { title: "x", data: { url: "https://x/1" } } });
  assert.deepEqual(await source.status({ settings: m.settings, dataFolder, id: pending, directory }), { done: false });
  assert.equal((await source.status({ settings: m.settings, dataFolder, id: pending, directory })).done, true);
});

test("invalid ids are rejected", async (t) => {
  const m = await startMornye(t);
  const { dataFolder, directory } = await dirs(t);
  await assert.rejects(source.status({ settings: m.settings, dataFolder, id: "../../etc", directory }), /Invalid download id/);
});

test("manifest matches exported functions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../mornye-python/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.test, true);
  assert.equal(typeof plugin.test, "function");
  for (const name of ["search", "download", "status", "discard"]) {
    assert.equal(typeof source[name], "function", name);
  }
  // Album-capable sources get pulled into Aurral's release-first step, which queued whole albums.
  assert.deepEqual(manifest.downloadSource, {});
  assert.equal(source.searchAlbum, undefined);
  assert.equal(source.downloadAlbum, undefined);
});
