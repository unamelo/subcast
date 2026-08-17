#!/usr/bin/env node
// subcast — cast a local video + .ass/.srt subtitle to Chromecast, with a file-picker UI.
// Usage:
//   node cast.js                                  # picker UI at http://localhost:8080/
//   node cast.js <video> <subtitle>               # preselect files (old CLI mode)
//   flags: [--port 8080] [--advertise <LAN-IP>] [--dump-vtt]
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') flags.port = Number(argv[++i]);
  else if (argv[i] === '--advertise') flags.advertise = argv[++i];
  else if (argv[i] === '--dump-vtt') flags.dumpVtt = true;
  else if (argv[i] === '--enhance') flags.enhance = true;
  else if (argv[i] === '--screen-off') flags.screenOff = true;
  else positional.push(argv[i]);
}
const PORT = flags.port || 8080;

const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov'];
const SUB_EXT = ['.ass', '.ssa', '.srt', '.vtt'];
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/mp4',
};

// ---------- subtitle conversion ----------
function assTimeToVtt(t) {
  // ASS: H:MM:SS.cc (centiseconds) -> VTT: HH:MM:SS.mmm
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}0`;
}

function cleanAssText(raw) {
  let text = raw;
  // vector drawings are not text
  if (/\{[^}]*\\p[1-9][^}]*\}/.test(text)) return '';
  // basic style mapping before stripping override blocks
  text = text
    .replace(/\{\\i1[^}]*\}/g, '<i>').replace(/\{\\i0[^}]*\}/g, '</i>')
    .replace(/\{\\b1[^}]*\}/g, '<b>').replace(/\{\\b0[^}]*\}/g, '</b>');
  text = text.replace(/\{[^}]*\}/g, ''); // strip remaining override tags
  text = text.replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' ');
  // balance unclosed tags
  for (const tag of ['i', 'b']) {
    const opens = (text.match(new RegExp(`<${tag}>`, 'g')) || []).length;
    const closes = (text.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    text += `</${tag}>`.repeat(Math.max(0, opens - closes));
  }
  return text.trim();
}

function assToCues(content) {
  const lines = content.split(/\r?\n/);
  let inEvents = false;
  let format = null;
  const cues = [];
  for (const line of lines) {
    const sec = line.match(/^\[(.+)\]\s*$/);
    if (sec) { inEvents = sec[1].toLowerCase() === 'events'; continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      format = line.replace(/^Format\s*:/i, '').split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    const dlg = line.match(/^Dialogue\s*:\s*(.*)$/i);
    if (!dlg || !format) continue;
    const parts = dlg[1].split(',');
    if (parts.length < format.length) continue;
    const fields = {};
    format.forEach((name, i) => {
      fields[name] = i === format.length - 1 ? parts.slice(i).join(',') : parts[i];
    });
    const start = assTimeToVtt(fields.start);
    const end = assTimeToVtt(fields.end);
    const text = cleanAssText(fields.text || '');
    if (!start || !end || !text) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start.localeCompare(b.start));
  const seen = new Set();
  const unique = cues.filter((c) => {
    const k = `${c.start}|${c.end}|${c.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // bilingual subs carry each line in two languages; kana marks the Japanese ones
  for (const c of unique) c.lang = /[぀-ヿ]/.test(c.text) ? 'ja' : 'zh';
  // merge same-text cues with overlapping time ranges (kanji-only bilingual pairs, layered events)
  const byText = new Map();
  for (const c of unique) {
    if (!byText.has(c.text)) byText.set(c.text, []);
    byText.get(c.text).push(c);
  }
  const merged = [];
  for (const group of byText.values()) {
    let cur = group[0];
    for (let i = 1; i < group.length; i++) {
      const c = group[i];
      if (c.start <= cur.end) {
        if (c.end > cur.end) cur.end = c.end;
      } else {
        merged.push(cur);
        cur = c;
      }
    }
    merged.push(cur);
  }
  merged.sort((a, b) => a.start.localeCompare(b.start));
  return merged;
}

function buildVtt(cues) {
  // merge near-simultaneous cues (±0.3s) into one multi-line cue — the receiver renders
  // each cue as a separate box with a large gap, so merging is what tightens line spacing
  const toSec = (t) => { const p = t.split(':'); return Number(p[0]) * 3600 + Number(p[1]) * 60 + parseFloat(p[2]); };
  const langRank = (l) => (l === 'zh' ? 0 : l === 'ja' ? 2 : 1); // 中文 on top, 日本語 below
  const groups = [];
  for (const c of cues) {
    const cs = toSec(c.start);
    const ce = toSec(c.end);
    const g = groups[groups.length - 1];
    if (g && Math.abs(cs - g.s) <= 0.3 && Math.abs(ce - g.e) <= 0.3) {
      g.lines.push(c);
      if (ce > g.e) { g.e = ce; g.end = c.end; }
    } else {
      groups.push({ start: c.start, end: c.end, s: cs, e: ce, lines: [c] });
    }
  }
  return 'WEBVTT\n\n' + groups.map((g) => {
    const text = g.lines.slice().sort((a, b) => langRank(a.lang) - langRank(b.lang)).map((l) => l.text).join('\n');
    return `${g.start} --> ${g.end}\n${text}`;
  }).join('\n\n') + '\n';
}

function srtToVtt(content) {
  return 'WEBVTT\n\n' + content
    .replace(/^﻿/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim() + '\n';
}

function decodeSubtitle(buf) {
  // BOMs first
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  // strict UTF-8, else best-scoring CJK legacy encoding (Big5 / GB18030 / Shift_JIS)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not utf-8 */ }
  let best = null;
  for (const enc of ['gb18030', 'big5', 'shift_jis']) {
    let text;
    try { text = new TextDecoder(enc).decode(buf); } catch { continue; }
    const bad = (text.match(/�/g) || []).length;
    const common = (text.match(/[的一是不了人我在有他這这中大來来上就你好嗎吗麼么說说是了的が了のにをはでとした]/g) || []).length;
    const score = common - bad * 10;
    if (!best || score > best.score) best = { text, score };
  }
  return best ? best.text : buf.toString('utf8');
}

function convertSubtitle(p) {
  const content = decodeSubtitle(fs.readFileSync(p));
  const ext = path.extname(p).toLowerCase();
  if (ext === '.vtt') return { vtt: content, cues: null };
  if (ext === '.srt') return { vtt: srtToVtt(content), cues: null };
  const cues = assToCues(content);
  return { vtt: buildVtt(cues), cues };
}

// ---------- codec check ----------
function checkCodecs(p) {
  const warnings = [];
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', p], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return warnings;
  try {
    const streams = JSON.parse(probe.stdout).streams || [];
    const v = streams.find(s => s.codec_type === 'video');
    const a = streams.find(s => s.codec_type === 'audio');
    if (v && !['h264', 'vp8', 'vp9', 'av1'].includes(v.codec_name)) {
      warnings.push(`video codec "${v.codec_name}" may not play on Chromecast (HEVC needs a newer device)`);
    }
    if (a && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(a.codec_name)) {
      warnings.push(`audio codec "${a.codec_name}" may play silent on Chromecast (AC3/DTS often unsupported)`);
    }
  } catch { /* ignore */ }
  return warnings;
}

// ---------- state ----------
const state = {
  videoPath: null,
  subPath: null,
  videoSize: 0,
  videoMime: 'video/mp4',
  vtt: null,
  cueCount: 0,
  warnings: [],
  version: 0,
};

function selectFiles(videoPath, subPath) {
  const vStat = fs.statSync(videoPath);
  if (!vStat.isFile()) throw new Error('video is not a file');
  const conv = subPath ? convertSubtitle(subPath) : null;
  state.videoPath = videoPath;
  state.subPath = subPath || null;
  state.videoSize = vStat.size;
  state.videoMime = MIME[path.extname(videoPath).toLowerCase()] || 'video/mp4';
  state.vtt = conv ? conv.vtt : null;
  state.cues = conv ? conv.cues : null;
  state.cueCount = state.cues ? state.cues.length : (state.vtt ? (state.vtt.match(/ --> /g) || []).length : 0);
  state.jaCues = state.cues ? state.cues.filter((c) => c.lang === 'ja').length : 0;
  state.zhCues = state.cues ? state.cues.length - state.jaCues : 0;
  state.bilingual = Boolean(state.cues && state.jaCues >= 5 && state.zhCues >= 5);
  state.warnings = checkCodecs(videoPath);
  state.enhanced = path.basename(path.dirname(videoPath)) === 'enhanced';
  state.version++;
  prefs.lastVideo = videoPath;
  prefs.lastSub = subPath || null;
  savePrefs();
  return publicState();
}

function publicState() {
  return {
    video: state.videoPath && path.basename(state.videoPath),
    videoSizeMB: state.videoPath && +(state.videoSize / 1e6).toFixed(1),
    sub: state.subPath ? path.basename(state.subPath) : null,
    cues: state.cueCount,
    warnings: state.warnings,
    version: state.version,
    mime: state.videoMime,
    bilingual: state.bilingual || false,
    zhCues: state.zhCues || 0,
    jaCues: state.jaCues || 0,
    enhanced: state.enhanced || false,
    position: state.videoPath ? (prefs.positions[path.basename(state.videoPath)] || 0) : 0,
    prefs: { videoDir: prefs.videoDir || null, subDir: prefs.subDir || null },
  };
}

// ---------- folder pairing ----------
function normName(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(1080p|720p|480p|2160p|4k|x264|x265|h\.?264|h\.?265|hevc|avc|aac|ac3|eac3|dts|flac|opus|web-?dl|webrip|bluray|blu-ray|bdrip|brrip|hdtv|10bit|hi10p|8bit)\b/g, ' ')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function epNum(name) {
  const n = normName(name);
  const nums = [...n.matchAll(/(?:^|[^\d])(\d{1,4})(?:[^\d]|$)/g)].map((m) => parseInt(m[1], 10));
  return nums.length ? nums[nums.length - 1] : null;
}

function pairFolder(videoDir, subDir) {
  const numeric = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const listBy = (dir, exts) => fs.readdirSync(dir)
    .filter((n) => !n.startsWith('.') && exts.includes(path.extname(n).toLowerCase()))
    .sort(numeric);
  const videos = listBy(videoDir, VIDEO_EXT);
  const subs = listBy(subDir, SUB_EXT);
  const used = new Set();
  const items = videos.map((v) => ({ video: v, sub: null }));
  // 1. exact match on normalized basename
  const subByNorm = new Map(subs.map((s) => [normName(s), s]));
  for (const it of items) {
    const s = subByNorm.get(normName(it.video));
    if (s && !used.has(s)) { it.sub = s; used.add(s); }
  }
  // 2. episode-number match; among duplicates prefer the plainest filename
  const subsByEp = new Map();
  for (const s of subs) {
    if (used.has(s)) continue;
    const e = epNum(s);
    if (e === null) continue;
    if (!subsByEp.has(e)) subsByEp.set(e, []);
    subsByEp.get(e).push(s);
  }
  for (const it of items) {
    if (it.sub) continue;
    const e = epNum(it.video);
    const cands = ((e !== null && subsByEp.get(e)) || []).filter((s) => !used.has(s));
    if (!cands.length) continue;
    cands.sort((a, b) => normName(a).length - normName(b).length || a.localeCompare(b));
    it.sub = cands[0];
    used.add(cands[0]);
  }
  // 3. leftovers: pair by sorted order when counts line up
  const leftV = items.filter((it) => !it.sub);
  const leftS = subs.filter((s) => !used.has(s));
  if (leftV.length && leftV.length === leftS.length) {
    leftV.forEach((it, i) => { it.sub = leftS[i]; });
  }
  return items.map((it) => ({
    name: it.video,
    subName: it.sub,
    video: path.join(videoDir, it.video),
    sub: it.sub ? path.join(subDir, it.sub) : null,
    enhanced: fs.existsSync(path.join(videoDir, 'enhanced', it.video)),
    position: prefs.positions[it.video] || 0,
    watched: Boolean(prefs.watched[it.video]),
  }));
}

// ---------- Anime4K enhancement queue ----------
// ffmpeg (Windows build) + libplacebo runs the Anime4K restore shader on the
// discrete GPU (vulkan:1 = RTX 4080 on this machine) and NVENC-encodes ~4.7x realtime.
const FFMPEG = '/mnt/d/mpv/ffmpeg71.exe';
const FFMPEG_CWD = '/mnt/d/mpv'; // shader referenced relative to here (colon in D: breaks filter syntax)
const enhance = { queue: [], current: null, done: [], failed: [] };

function toWinPath(p) {
  return spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim();
}

function probeDuration(p) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' });
  return parseFloat(r.stdout) || 0;
}

function enhancedPathFor(videoPath) {
  return path.join(path.dirname(videoPath), 'enhanced', path.basename(videoPath));
}

function enhanceNext() {
  if (enhance.current || !enhance.queue.length) return;
  const videoPath = enhance.queue.shift();
  const outPath = enhancedPathFor(videoPath);
  const partPath = outPath + '.part.mp4';
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch { /* exists */ }
  const duration = probeDuration(videoPath);
  const job = { name: path.basename(videoPath), pct: 0 };
  enhance.current = job;
  console.log(`✨ enhancing: ${job.name}`);
  const proc = spawn(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1',
    '-i', toWinPath(videoPath),
    '-init_hw_device', 'vulkan:1',
    '-vf', 'libplacebo=custom_shader_path=A_restore.glsl:format=yuv420p',
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '22',
    '-c:a', 'copy', '-f', 'mp4', toWinPath(path.dirname(outPath)) + '\\' + path.basename(partPath),
  ], { cwd: FFMPEG_CWD, stdio: ['ignore', 'pipe', 'inherit'] });
  proc.on('error', (e) => {
    console.log(`✨ spawn failed: ${e.message}`);
    enhance.failed.push(job.name);
    enhance.current = null;
  });
  proc.stdout.on('data', (chunk) => {
    const m = String(chunk).match(/out_time_us=(\d+)/g);
    if (m && duration) {
      const us = parseInt(m[m.length - 1].split('=')[1], 10);
      job.pct = Math.min(99, Math.round((us / 1e6 / duration) * 100));
    }
  });
  proc.on('exit', (code) => {
    if (code === 0 && fs.existsSync(partPath)) {
      fs.renameSync(partPath, outPath);
      enhance.done.push(job.name);
      console.log(`✨ done: ${job.name}`);
    } else {
      try { fs.unlinkSync(partPath); } catch { /* nothing to clean */ }
      enhance.failed.push(job.name);
      console.log(`✨ FAILED (exit ${code}): ${job.name}`);
    }
    enhance.current = null;
    enhanceNext();
  });
}

// ---------- queue support: stable per-episode URLs ----------
// The Chromecast advances a native queue by itself, so playback survives the
// browser tab being discarded. These routes resolve episodes from the
// remembered folders, independent of the single "current selection" state.
let pairCache = { t: 0, key: '', items: [] };
function currentPairing() {
  if (!prefs.videoDir) return [];
  const key = `${prefs.videoDir}|${prefs.subDir || ''}`;
  const now = Date.now();
  if (pairCache.key === key && now - pairCache.t < 10000) return pairCache.items;
  try {
    const sdir = prefs.subDir && fs.existsSync(prefs.subDir) ? prefs.subDir : prefs.videoDir;
    pairCache = { t: now, key, items: pairFolder(prefs.videoDir, sdir) };
  } catch {
    pairCache = { t: now, key, items: [] };
  }
  return pairCache.items;
}

const subCache = new Map(); // sub path -> { mt, vtt, cues }
function subsFor(p) {
  const mt = Number(fs.statSync(p).mtimeMs);
  const hit = subCache.get(p);
  if (hit && hit.mt === mt) return hit;
  const conv = convertSubtitle(p);
  const entry = { mt, vtt: conv.vtt, cues: conv.cues };
  subCache.set(p, entry);
  if (subCache.size > 12) subCache.delete(subCache.keys().next().value);
  return entry;
}

// ---------- keep Windows awake while streaming ----------
// A muted preview tab does not hold a wake lock, so an idle-sleep timer would
// kill the server mid-episode. While the Chromecast is actively pulling video
// (or the page reports progress), a short-lived PowerShell holder asserts an
// execution state for 150s at a time; if the server dies the hold expires alone.
// Default holds DISPLAY too (0x80000003): on Modern Standby laptops the system
// hold alone is ignored once the screen turns off. With --screen-off only the
// system hold (0x80000001) is used — pair it with a one-time
//   powercfg /change standby-timeout-ac 0
// so screen-off doesn't drift into standby.
// diagnostic trail (~/.subcast.log): correlate stream stops with Windows
// kernel-power events instead of guessing
const DLOG = path.join(os.homedir(), '.subcast.log');
function dlog(msg) {
  try { fs.appendFile(DLOG, `${new Date().toISOString()} ${msg}\n`, () => {}); } catch { /* best effort */ }
}

const AWAKE_FLAGS = () => (flags.screenOff ? '2147483649' : '2147483651');
// ONE long-lived holder per viewing session: ES_CONTINUOUS persists for the
// life of the process, which then just blocks on stdin — if this server dies
// for any reason, stdin closes and the hold releases itself. (The previous
// design respawned PowerShell every 150s, recompiling a C# shim each time —
// a CPU burst that caused visible playback hiccups.)
const AWAKE_PS = () => 'Add-Type -Name PW -Namespace W32 -MemberDefinition ' +
  '\'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);\'; ' +
  `[W32.PW]::SetThreadExecutionState(${AWAKE_FLAGS()}) | Out-Null; [void][Console]::In.ReadToEnd()`;
let awakeProc = null;
let lastPoke = 0;

function pokeAwake() {
  lastPoke = Date.now();
  if (awakeProc) return;
  try {
    awakeProc = spawn('powershell.exe', ['-NoProfile', '-Command', AWAKE_PS()], { stdio: ['pipe', 'ignore', 'ignore'] });
    dlog(`awake-hold spawned (${flags.screenOff ? 'system-only' : 'display+system'})`);
    console.log(flags.screenOff
      ? 'keep-awake: system hold only (--screen-off) — make sure plugged-in sleep is set to Never'
      : 'keep-awake: holding display + system while streaming');
    awakeProc.on('error', () => { awakeProc = null; dlog('awake-hold SPAWN ERROR'); });
    awakeProc.on('exit', (code) => { awakeProc = null; dlog(`awake-hold exit (${code})`); });
  } catch { awakeProc = null; }
}

function releaseAwake() {
  if (!awakeProc) return;
  dlog('awake-hold release (idle)');
  try { awakeProc.stdin.end(); } catch { /* already gone */ }
  try { awakeProc.kill(); } catch { /* already gone */ }
}

// ---------- network detection ----------
function isWsl() {
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}
function localIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}
const wsl = isWsl();
const advertise = flags.advertise || localIp();

function winDrives() {
  try {
    return fs.readdirSync('/mnt')
      .filter((n) => /^[a-z]$/.test(n))
      .filter((n) => { try { fs.readdirSync('/mnt/' + n); return true; } catch { return false; } })
      .map((n) => ({ label: n.toUpperCase() + ':', path: '/mnt/' + n }));
  } catch { return []; }
}

// Access key for the filesystem API. WSL2's localhost forwarding arrives from the
// virtual-network gateway (not loopback), so IP checks alone can't tell the local
// browser apart from LAN traffic — a key in the URL can. Persisted so bookmarks survive restarts.
const KEYFILE = path.join(os.homedir(), '.subcast.key');
let SECRET;
try {
  SECRET = fs.readFileSync(KEYFILE, 'utf8').trim();
  if (!/^[0-9a-f]{16}$/.test(SECRET)) throw new Error('bad key');
} catch {
  SECRET = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(KEYFILE, SECRET, { mode: 0o600 });
}

// Remembered folders and last-played files, so a restart picks up where you left off.
const PREFFILE = path.join(os.homedir(), '.subcast.json');
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(PREFFILE, 'utf8')); } catch { /* first run */ }
prefs.positions = prefs.positions || {}; // seconds watched, keyed by video filename
prefs.watched = prefs.watched || {};
function savePrefs() {
  try { fs.writeFileSync(PREFFILE, JSON.stringify(prefs, null, 2)); } catch { /* best effort */ }
}

// ---------- CLI preselect / dump ----------
if (positional.length >= 2) {
  if (flags.dumpVtt) { process.stdout.write(convertSubtitle(positional[1]).vtt); process.exit(0); }
  try {
    selectFiles(path.resolve(positional[0]), path.resolve(positional[1]));
  } catch (e) {
    console.error(`Failed to load files: ${e.message}`);
    process.exit(1);
  }
} else if (flags.dumpVtt) {
  console.error('--dump-vtt needs <video> <subtitle> arguments');
  process.exit(1);
}

// no CLI selection → restore last-played from prefs (files may have moved; ignore failures)
if (!state.videoPath && prefs.lastVideo) {
  try { selectFiles(prefs.lastVideo, prefs.lastSub); } catch { /* stale prefs */ }
}

// ---------- UI page ----------
const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>subcast</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-40 -40 80 80'%3E%3Cg%3E%3Cellipse rx='9' ry='17' cy='-15' fill='%23F0D2CA'/%3E%3Cellipse rx='9' ry='17' cy='-15' fill='%23F0D2CA' transform='rotate(72)'/%3E%3Cellipse rx='9' ry='17' cy='-15' fill='%23EBC7BE' transform='rotate(144)'/%3E%3Cellipse rx='9' ry='17' cy='-15' fill='%23EBC7BE' transform='rotate(216)'/%3E%3Cellipse rx='9' ry='17' cy='-15' fill='%23F0D2CA' transform='rotate(288)'/%3E%3Ccircle r='7.5' fill='%239B98C2'/%3E%3Ccircle r='2.6' fill='%237B78A8'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    /* Una's reference: BM Fondant cream · Sugarcane pink · Vale Mist sage · Central Mauve */
    --bg: #FAF3EA; --panel: #FFFCF6;
    --line: #E7DACB; --line2: #F3EADD;
    --text: #453F3B; --dim: #9C9084;
    --accent: #8F8CB8; --accent-deep: #64618F; --accent-hover: #56537F; --accent-soft: #EFECF5;
    --pink: #F3DCD6; --pink-soft: #F9EDE8; --pink-line: #EDD6CE;
    --mint: #7E8A6C; --blue: #8F8CB8; --rose: #C08E86;
    --good: #7E8A6C; --warn: #A98963; --bad: #C08E86;
    --ease: cubic-bezier(0.32, 0.72, 0, 1);
    --bezel: 0 1px 2px rgba(90,75,65,.04), 0 22px 44px -32px rgba(122,104,92,.4);
  }
  * { box-sizing: border-box; }
  html { scrollbar-color: #E8D5CE transparent; }
  body {
    margin: 0; background: var(--bg); color: var(--text); font-size: 15px;
    font-family: 'Jost', -apple-system, 'Segoe UI', system-ui, sans-serif;
    letter-spacing: .01em;
  }
  #app { display: flex; gap: 1.9rem; width: 100%; padding: 1.7rem 2rem; align-items: flex-start; position: relative; z-index: 1; }
  .flora { position: fixed; z-index: 0; pointer-events: none; }
  #flora-br { right: -28px; bottom: -30px; width: 330px; opacity: .65; }
  #flora-tl { left: -30px; top: -26px; width: 250px; opacity: .5; transform: rotate(180deg); }
  #flora-tr { right: -14px; top: -28px; width: 245px; opacity: .75; }
  #flora-bl { left: -18px; bottom: -22px; width: 255px; opacity: .62; }
  @media (max-width: 880px) { .flora { display: none; } }
  #side {
    width: 325px; flex-shrink: 0; background: #FCF2ED; border: 1px solid var(--pink-line);
    border-radius: 12px; padding: 1.25rem 1.2rem 1rem;
    position: sticky; top: 1.7rem; display: flex; flex-direction: column;
    max-height: calc(100vh - 3.4rem);
    box-shadow: var(--bezel);
  }
  #main { flex: 1; min-width: 0; }
  h1 {
    font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic;
    font-size: 1.7rem; font-weight: 600; margin: 0 0 .9rem; letter-spacing: .02em;
    padding-bottom: .7rem; border-bottom: 1px solid var(--pink-line);
  }
  .brand { color: var(--accent-deep); }
  .topbar { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.3rem; min-height: 42px; }
  #status {
    font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic;
    color: var(--dim); font-size: 1.05rem; flex: 1; min-height: 1.2em;
    padding: .3rem .2rem;
  }
  google-cast-launcher {
    width: 38px; height: 38px; flex-shrink: 0; cursor: pointer;
    --connected-color: #64618F; --disconnected-color: #9C9084;
    transition: transform .4s var(--ease);
  }
  google-cast-launcher:hover { transform: scale(1.06); }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 1.35rem 1.45rem; margin: 0 0 1.6rem;
    box-shadow: var(--bezel);
  }
  .pick { display: flex; align-items: center; gap: .5rem; margin: .3rem 0; font-size: .88rem; }
  .pick .label { width: 3.8rem; color: var(--dim); flex-shrink: 0; }
  .pick .file { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick .file.empty { color: #C4BBA4; font-style: italic; }
  button {
    background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px;
    padding: .42rem 1rem; font-size: .84rem; font-family: inherit; font-weight: 500; cursor: pointer;
    font-variant: all-small-caps; letter-spacing: .08em;
    transition: all .35s var(--ease);
  }
  button:hover {
    background: var(--pink-soft); border-color: var(--pink-line); transform: translateY(-1px);
    box-shadow: 0 8px 18px -14px rgba(160,110,100,.45);
  }
  button:active { transform: scale(.98); }
  button.primary {
    background: var(--accent-deep); border-color: var(--accent-deep); color: #fff; font-weight: 500;
    box-shadow: 0 8px 20px -10px rgba(100,97,143,.55);
  }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); box-shadow: 0 12px 26px -12px rgba(100,97,143,.6); }
  button:disabled { opacity: .4; cursor: default; transform: none; box-shadow: none; }
  .pick button { padding: .26rem .6rem; font-size: .78rem; flex-shrink: 0; }
  #browser { display: none; }
  #browser.open { display: block; animation: rise .45s var(--ease); }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  #pathbar { display: flex; gap: .4rem; align-items: center; margin-bottom: .55rem; flex-wrap: wrap; }
  #curpath { color: var(--dim); font-size: .8rem; word-break: break-all; }
  #pathinput {
    width: 100%; margin-bottom: .65rem; background: var(--bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: .55rem .85rem; font-size: .88rem;
    font-family: inherit; outline: none; transition: border-color .35s var(--ease), box-shadow .35s var(--ease);
  }
  #pathinput:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  #pathinput::placeholder { color: #C4BBA4; }
  #entries { max-height: 380px; overflow-y: auto; border: 1px solid var(--line2); border-radius: 8px; }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: #E8D5CE; border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  .entry {
    padding: .5rem .7rem; cursor: pointer; display: flex; gap: .45rem; align-items: center;
    font-size: .84rem; border-bottom: 1px solid var(--line2);
    transition: background .3s var(--ease), padding-left .3s var(--ease);
  }
  .entry:last-child { border-bottom: none; }
  .entry:hover { background: var(--pink-soft); padding-left: .85rem; }
  .entry.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
  .entry > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry .size { color: var(--dim); font-size: .74rem; flex-shrink: 0; }
  .entry .subname { color: var(--mint); font-size: .74rem; flex-shrink: 0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry .nosub { color: var(--bad); font-size: .74rem; opacity: .75; flex-shrink: 0; }
  .entry .pos { color: var(--blue); font-size: .74rem; flex-shrink: 0; }
  .entry .done { color: var(--good); font-size: .8rem; flex-shrink: 0; }
  .row { display: flex; align-items: center; gap: .7rem; margin: .8rem 0; flex-wrap: wrap; }
  label { display: inline-flex; align-items: center; gap: .35rem; color: var(--dim); font-size: .85rem; cursor: pointer; }
  input[type=range] {
    -webkit-appearance: none; appearance: none; flex: 1; min-width: 140px;
    height: 18px; background: transparent; cursor: pointer;
  }
  input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: #E7D8CE; }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent-deep); margin-top: -5px;
    border: 2px solid #fff; box-shadow: 0 1px 4px rgba(90,75,65,.4);
  }
  input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: #E7D8CE; }
  input[type=range]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--accent); }
  input[type=range]::-moz-range-thumb {
    width: 12px; height: 12px; border-radius: 50%; background: var(--accent-deep);
    border: 2px solid #fff; box-shadow: 0 1px 4px rgba(90,75,65,.4);
  }
  input[type=range]:focus { outline: none; }
  input[type=checkbox] { accent-color: var(--accent); width: 14px; height: 14px; }
  input[type=color] { border: 1px solid var(--line); background: none; width: 26px; height: 26px; padding: 1px; cursor: pointer; border-radius: 8px; }
  select {
    background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: .28rem .65rem; font-size: .84rem; font-family: inherit;
    outline: none; cursor: pointer; transition: border-color .35s var(--ease);
  }
  select:focus { border-color: var(--accent); }
  video {
    width: 100%; border-radius: 8px; background: #000; margin-top: .3rem; display: block;
    border: 1px solid var(--line);
    box-shadow: 0 24px 48px -28px rgba(90,75,65,.45);
  }
  #pvwrap { position: relative; }
  #pvsubs {
    position: absolute; left: 0; right: 0; bottom: 9%; text-align: center;
    pointer-events: none; padding: 0 4%; z-index: 2;
  }
  #pvsubs .line { display: table; margin: 0 auto; padding: .06em .5em; border-radius: .35em; line-height: 1.25; }
  #time { color: var(--dim); font-size: .84rem; font-variant-numeric: tabular-nums; }
  #pickinfo { color: var(--dim); font-size: .78rem; margin: .35rem 0 0; }
  .warn { color: var(--warn); font-size: .8rem; margin-top: .3rem; }
  #enhstatus { color: var(--warn); font-size: .78rem; min-height: 1em; margin-top: .4rem; }
  .hint { color: var(--dim); font-size: .78rem; margin: 0 0 .45rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #epdir { color: var(--text); }
  #epcard { flex: 1; min-height: 0; display: none; flex-direction: column; border-top: 1px solid var(--pink-line); margin-top: .8rem; padding-top: .75rem; }
  #episodes { flex: 1; min-height: 120px; overflow-y: auto; border: 1px solid var(--pink-line); border-radius: 8px; background: var(--panel); }
  #floatbar {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 6;
    display: none; align-items: center; gap: .4rem; padding: .45rem .75rem;
    background: rgba(255,252,246,.93); backdrop-filter: blur(6px);
    border: 1px solid var(--pink-line); border-radius: 999px;
    box-shadow: 0 14px 36px -14px rgba(90,75,65,.4);
  }
  #floatbar.on { display: flex; }
  #floatbar button { border-radius: 999px; padding: .34rem .8rem; }
  #floatbar input[type=range] { flex: none; min-width: 70px; width: 84px; }
  #fspeed { min-width: 3.4rem; }
  #castcard { display: none; position: relative; }
  #castcard.ready { display: block; animation: rise .5s var(--ease); }
  .cardleaf { position: absolute; left: -17px; top: 42%; width: 52px; transform: rotate(-96deg); pointer-events: none; }
  #nowplaying {
    position: absolute; top: 20px; right: 26px; max-width: 380px;
    font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic;
    font-size: 1.15rem; line-height: 1.4; color: var(--accent-deep);
    text-align: right; pointer-events: none;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  #nowplaying:not(:empty)::after { content: ' ✦'; color: var(--rose); font-style: normal; font-size: .75em; }
  @media (max-width: 1280px) { #nowplaying { display: none; } }
  .sidemoth { position: absolute; top: -15px; right: -8px; width: 76px; transform: rotate(14deg); pointer-events: none; }
  small { color: var(--dim); }
  @media (max-width: 880px) {
    #app { flex-direction: column; padding: 1rem; }
    #side { position: static; width: 100%; max-height: none; }
    #episodes { max-height: 300px; }
  }
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <g id="bloom5">
      <ellipse rx="9" ry="17" cy="-15" fill="#EBC2B4"/>
      <ellipse rx="9" ry="17" cy="-15" fill="#EBC2B4" transform="rotate(72)"/>
      <ellipse rx="9" ry="17" cy="-15" fill="#DFA99C" transform="rotate(144)"/>
      <ellipse rx="9" ry="17" cy="-15" fill="#DFA99C" transform="rotate(216)"/>
      <ellipse rx="9" ry="17" cy="-15" fill="#EBC2B4" transform="rotate(288)"/>
      <circle r="7.5" fill="#9B98C2"/>
      <circle r="2.6" fill="#7B78A8"/>
    </g>
    <g id="sprig">
      <path d="M14 236 C 66 196, 44 130, 96 88 C 132 58, 168 48, 206 40" stroke="#C9AE8F" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M70 150 C 44 140, 36 112, 52 96 C 72 108, 78 134, 70 150 Z" fill="#B9C3A6"/>
      <path d="M118 84 C 128 60, 152 52, 170 60 C 162 82, 138 92, 118 84 Z" fill="#9AA884"/>
      <path d="M40 196 C 22 188, 16 168, 26 156 C 42 164, 48 184, 40 196 Z" fill="#C9D2B4"/>
      <g fill="#ACA7D2">
        <circle cx="96" cy="88" r="6"/>
        <circle cx="108" cy="96" r="6"/>
        <circle cx="96" cy="104" r="6"/>
        <circle cx="84" cy="96" r="6"/>
        <circle cx="96" cy="96" r="6" fill="#9A94C6"/>
      </g>
      <use href="#bloom5" transform="translate(214,36)"/>
      <use href="#bloom5" transform="translate(46,214) scale(.55) rotate(20)"/>
    </g>
    <g id="bloom8">
      <ellipse rx="6" ry="16" cy="-13" fill="#EBC2B4"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#DFA99C" transform="rotate(45)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#EBC2B4" transform="rotate(90)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#DFA99C" transform="rotate(135)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#EBC2B4" transform="rotate(180)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#DFA99C" transform="rotate(225)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#EBC2B4" transform="rotate(270)"/>
      <ellipse rx="6" ry="16" cy="-13" fill="#DFA99C" transform="rotate(315)"/>
      <circle r="8" fill="#BFBBDE"/>
      <circle r="8.5" fill="none" stroke="#8F8CB8" stroke-width="1.2" stroke-dasharray="1.5 2.2"/>
      <circle r="3.6" fill="#7B78A8"/>
    </g>
    <g id="bell">
      <path d="M0 0 C -10 4, -12 18, -10 28 L 10 28 C 12 18, 10 4, 0 0 Z" fill="#EBC2B4"/>
      <path d="M-10 28 Q -5 33 0 28 Q 5 33 10 28 L 10 27 L -10 27 Z" fill="#DFA99C"/>
      <circle cy="34" r="2.2" fill="#9B98C2"/>
    </g>
    <g id="leaf3">
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="rotate(-48)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="rotate(48)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A"/>
    </g>
    <g id="mothwing">
      <path d="M2 0 C 26 -34, 66 -38, 74 -16 C 79 -2, 62 8, 40 10 C 24 11, 8 8, 2 0 Z" fill="#ACA7D2"/>
      <path d="M2 6 C 20 28, 52 34, 58 20 C 62 10, 44 4, 26 4 Z" fill="#BFBBDE"/>
      <circle cx="46" cy="-14" r="5" fill="#DFA99C"/>
      <circle cx="29" cy="-7" r="3" fill="#EBC2B4"/>
    </g>
    <g id="moth">
      <use href="#mothwing"/>
      <use href="#mothwing" transform="scale(-1,1)"/>
      <ellipse rx="4" ry="15" cy="4" fill="#8F8CB8"/>
      <circle r="4.2" cy="-12" fill="#8F8CB8"/>
      <path d="M-2 -14 C -8 -26, -16 -31, -23 -32" stroke="#8F8CB8" stroke-width="1.4" fill="none" stroke-linecap="round"/>
      <path d="M2 -14 C 8 -26, 16 -31, 23 -32" stroke="#8F8CB8" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    </g>
    <g id="sprig2">
      <path d="M226 14 C 180 40, 150 90, 138 150 C 132 184, 140 214, 158 236" stroke="#C9AE8F" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M168 96 C 150 108, 142 124, 144 140" stroke="#C9AE8F" stroke-width="2" fill="none" stroke-linecap="round"/>
      <use href="#leaf3" transform="translate(198,42) rotate(35) scale(.95)"/>
      <use href="#leaf3" transform="translate(150,128) rotate(-18) scale(.65)"/>
      <use href="#bell" transform="translate(144,142) rotate(6)"/>
      <use href="#bell" transform="translate(166,166) rotate(-8) scale(.8)"/>
      <g fill="#ACA7D2">
        <circle cx="186" cy="72" r="5.5"/>
        <circle cx="195" cy="80" r="5.5"/>
        <circle cx="184" cy="84" r="5.5"/>
        <circle cx="190" cy="76" r="5.5" fill="#9A94C6"/>
      </g>
      <use href="#bloom8" transform="translate(152,214) scale(.95)"/>
    </g>
    <g id="leafspray">
      <path d="M234 6 C 204 14, 172 34, 148 64" stroke="#C9AE8F" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(210,16) rotate(-95) scale(1.2)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="translate(194,26) rotate(-160) scale(1.1)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#A8B594" transform="translate(178,38) rotate(-110) scale(1.0)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#C9D2B4" transform="translate(164,50) rotate(-170) scale(.95)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(150,63) rotate(-120) scale(.85)"/>
      <g fill="#ACA7D2">
        <circle cx="200" cy="46" r="5"/>
        <circle cx="208" cy="53" r="5"/>
        <circle cx="197" cy="56" r="5"/>
        <circle cx="203" cy="50" r="5" fill="#9A94C6"/>
      </g>
    </g>
    <g id="ivy">
      <path d="M32 0 C 22 50, 42 95, 30 145 C 20 190, 42 235, 30 285 C 22 330, 38 375, 28 418" stroke="#A8B594" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(28,42) rotate(78) scale(.7)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="translate(34,88) rotate(-80) scale(.65)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#C9D2B4" transform="translate(29,134) rotate(72) scale(.72)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(27,180) rotate(-74) scale(.62)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#A8B594" transform="translate(33,226) rotate(80) scale(.7)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="translate(29,272) rotate(-78) scale(.66)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#C9D2B4" transform="translate(27,318) rotate(74) scale(.7)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(31,364) rotate(-76) scale(.64)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#A8B594" transform="translate(28,404) rotate(76) scale(.6)"/>
      <g fill="#ACA7D2">
        <circle cx="38" cy="110" r="4"/>
        <circle cx="43" cy="116" r="4"/>
        <circle cx="36" cy="118" r="4" fill="#9A94C6"/>
      </g>
      <g fill="#ACA7D2">
        <circle cx="36" cy="296" r="4"/>
        <circle cx="41" cy="302" r="4"/>
        <circle cx="34" cy="304" r="4" fill="#9A94C6"/>
      </g>
    </g>
    <g id="sprig3">
      <path d="M16 240 C 30 190, 70 160, 120 150 C 160 142, 190 120, 200 92" stroke="#C9AE8F" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M96 158 C 84 138, 84 118, 96 102" stroke="#C9AE8F" stroke-width="2" fill="none" stroke-linecap="round"/>
      <use href="#leaf3" transform="translate(52,196) rotate(-30) scale(.8)"/>
      <use href="#leaf3" transform="translate(150,146) rotate(24) scale(.6)"/>
      <use href="#bloom5" transform="translate(96,98) scale(.78)"/>
      <g fill="#ACA7D2">
        <circle cx="134" cy="152" r="5"/>
        <circle cx="142" cy="159" r="5"/>
        <circle cx="131" cy="162" r="5"/>
        <circle cx="137" cy="156" r="5" fill="#9A94C6"/>
      </g>
      <use href="#bloom8" transform="translate(202,88) scale(1.05)"/>
      <use href="#moth" transform="translate(168,34) scale(.4) rotate(-16)"/>
    </g>
    <g id="cornerbranch">
      <path d="M212 8 C 176 18, 140 44, 118 78 C 104 100, 96 118, 92 132" stroke="#C9AE8F" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M150 40 C 130 40, 112 48, 100 60" stroke="#C9AE8F" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(192,16) rotate(-100) scale(1.05)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="translate(174,26) rotate(-155) scale(.9)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#A8B594" transform="translate(156,38) rotate(-105) scale(.95)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#C9D2B4" transform="translate(138,54) rotate(-165) scale(.85)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#8FA07A" transform="translate(124,70) rotate(-115) scale(.9)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#B9C3A6" transform="translate(112,88) rotate(-170) scale(.8)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#A8B594" transform="translate(102,106) rotate(-120) scale(.85)"/>
      <path d="M0 0 C -12 -8, -14 -26, -2 -34 C 8 -24, 8 -8, 0 0 Z" fill="#C9D2B4" transform="translate(98,62) rotate(-60) scale(.6)"/>
      <g fill="#ACA7D2">
        <circle cx="166" cy="50" r="4.6"/>
        <circle cx="173" cy="57" r="4.6"/>
        <circle cx="163" cy="60" r="4.6"/>
        <circle cx="169" cy="54" r="4.6" fill="#9A94C6"/>
      </g>
      <g fill="#ACA7D2">
        <circle cx="94" cy="122" r="3.8"/>
        <circle cx="99" cy="127" r="3.8"/>
        <circle cx="92" cy="129" r="3.8" fill="#9A94C6"/>
      </g>
    </g>
    <g id="posy">
      <path d="M10 96 C 32 72, 36 42, 72 18" stroke="#C9AE8F" stroke-width="2" fill="none" stroke-linecap="round"/>
      <use href="#leaf3" transform="translate(34,64) rotate(-30) scale(.62)"/>
      <g fill="#ACA7D2">
        <circle cx="52" cy="36" r="4.5"/>
        <circle cx="61" cy="42" r="4.5"/>
        <circle cx="52" cy="48" r="4.5"/>
        <circle cx="43" cy="42" r="4.5"/>
        <circle cx="52" cy="42" r="4.5" fill="#9A94C6"/>
      </g>
      <use href="#bloom8" transform="translate(82,16) scale(.75)"/>
    </g>
  </defs>
</svg>
<svg class="flora" id="flora-br" viewBox="0 0 240 250" aria-hidden="true"><use href="#sprig"/></svg>
<svg class="flora" id="flora-tl" viewBox="0 0 240 250" aria-hidden="true"><use href="#sprig"/></svg>
<svg class="flora" id="flora-tr" viewBox="0 0 240 160" aria-hidden="true"><use href="#leafspray"/></svg>
<svg class="flora" id="flora-bl" viewBox="0 0 240 250" aria-hidden="true"><use href="#sprig3"/></svg>

<div id="app">
<aside id="side">
  <svg class="sidemoth" viewBox="-90 -50 180 105" aria-hidden="true"><use href="#moth"/></svg>
  <h1><svg viewBox="-26 -26 52 52" width="21" height="21" aria-hidden="true" style="vertical-align:-3px; margin-right:.15rem"><use href="#bloom5"/></svg><span class="brand">subcast</span></h1>
  <div class="pick">
    <span class="label">Video</span>
    <span class="file empty" id="videofile">none selected</span>
    <button data-target="video">Browse</button>
  </div>
  <div class="pick">
    <span class="label">Subtitle</span>
    <span class="file empty" id="subfile">none selected</span>
    <button data-target="sub">Browse</button>
  </div>
  <div class="row" style="margin:.5rem 0 0">
    <button class="primary" id="loadfiles" disabled>Load files</button>
  </div>
  <div id="pickinfo"></div>
  <div id="warnings"></div>
  <div id="epcard" style="display:none">
    <div class="hint" id="ephint">Episodes in <span id="epdir"></span></div>
    <div id="episodes"></div>
    <div id="enhstatus"></div>
  </div>
</aside>

<main id="main">
  <div class="topbar">
    <div id="status">Cast framework loading…</div>
    <google-cast-launcher></google-cast-launcher>
  </div>
  <div class="card" id="browser">
    <div id="pathbar">
      <button id="up">↑ Up</button>
      <button data-jump="home">Home</button>
      <span id="drivebtns"></span>
      <button id="usedir" class="primary">Use this folder</button>
      <span id="curpath"></span>
    </div>
    <input id="pathinput" placeholder="or paste a path: D:\\Downloads\\… or /mnt/d/…">
    <div id="entries"></div>
  </div>

  <div class="card" id="castcard">
  <div id="nowplaying"></div>
  <svg class="cardleaf" viewBox="-42 -42 84 50" aria-hidden="true"><use href="#leaf3"/></svg>
  <div class="row">
    <button class="primary" id="cast">Cast</button>
    <button id="mpv" title="open on this PC in mpv with Anime4K enhancement">mpv</button>
    <button id="playpause">Play / Pause</button>
    <button id="stop">Stop</button>
    <button id="back">−10s</button>
    <button id="fwd">+10s</button>
    <button id="subs">Subs: on</button>
  </div>
  <div class="row">
    <span class="hint" style="margin:0">Text:</span>
    <label>size <input type="range" id="fontscale" min="0.4" max="2" step="0.05" value="1" style="flex:none; width:90px"></label>
    <label>gap <input type="range" id="linegap" min="0" max="1.5" step="0.05" value="0.3" style="flex:none; width:70px" title="space between subtitle lines (browser player)"></label>
    <label>color <input type="color" id="fgcolor" value="#ffffff"></label>
    <label>edge <select id="edgestyle">
      <option value="outline">outline</option>
      <option value="shadow">shadow</option>
      <option value="both">outline + shadow</option>
      <option value="none">none</option>
    </select> <input type="color" id="edgecolor" value="#000000" title="edge color"></label>
    <label id="langwrap" style="display:none">lines
      <select id="sublang">
        <option value="zh">中文 only</option>
        <option value="ja">日本語 only</option>
        <option value="all">both</option>
      </select>
    </label>
  </div>
  <div class="row">
    <span class="hint" style="margin:0">Box:</span>
    <label><input type="checkbox" id="bgbox"> box</label>
    <label><input type="color" id="boxcolor" value="#000000" title="box color"></label>
    <label>opacity <input type="range" id="boxalpha" min="0.1" max="1" step="0.05" value="0.55" style="flex:none; width:70px"></label>
    <label title="browser player only"><input type="checkbox" id="boxborder"> border</label>
  </div>
  <div class="row"><input type="range" id="seek" min="0" max="100" value="0" step="0.1"><span id="time">0:00</span></div>
  <p class="row" style="margin-bottom:.2rem">
    <small>Local preview (the Chromecast streams independently):</small>
    <label><input type="checkbox" id="syncpv"> follow TV — muted; scrubbing here seeks the TV</label>
  </p>
  <div id="pvwrap">
    <video id="preview" controls preload="metadata" crossorigin="anonymous"></video>
    <div id="pvsubs"></div>
  </div>
  </div>
</main>
</div>

<div id="floatbar">
  <button id="fprev" title="previous episode">‹ prev</button>
  <button id="fplay" title="play / pause">play ∕ pause</button>
  <button id="fnext" title="next episode">next ›</button>
  <button id="fspeed" title="playback speed">1×</button>
  <label>vol <input type="range" id="fvol" min="0" max="1" step="0.05" value="1"></label>
  <label title="when an episode ends, cast the next one automatically"><input type="checkbox" id="fauto"> auto</label>
</div>

<script>
var ADVERTISE = %%ADVERTISE%%;
var PORT = %%PORT%%;
var DRIVES = %%DRIVES%%;
var ENHANCE_ENABLED = %%ENH%%;
var KEY = new URLSearchParams(location.search).get('key') || '';
var sel = { video: null, sub: null };
var folderSel = { video: null, sub: null };
var browseTarget = null;
var curDir = null;
var loaded = null;
var player = null, controller = null, subsOn = true;

function $(id) { return document.getElementById(id); }
function status(msg) { $('status').textContent = msg; }

// ---- file browser ----
function api(url) {
  return fetch(url, { headers: { 'X-Subcast-Key': KEY } }).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
  });
}

function clog(m) {
  try {
    fetch('/api/clientlog', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Subcast-Key': KEY }, body: m,
    }).catch(function () {});
  } catch (e) { /* logging must never break playback */ }
}

function castingLive() {
  // RemotePlayer, not getMediaSession(): the media session object can go stale
  // (still says PLAYING after the media unloaded)
  try {
    var s = cast.framework.CastContext.getInstance().getCurrentSession();
    if (!s || !player || !player.isMediaLoaded) return false;
    var st = player.playerState;
    return st === 'PLAYING' || st === 'BUFFERING' || st === 'PAUSED';
  } catch (e) { return false; }
}

function selectPair(video, sub, onDone, opts) {
  return fetch('/api/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Subcast-Key': KEY },
    body: JSON.stringify({ video: video, sub: sub }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error);
    applyState(j);
    if (onDone) onDone(j);
    // already casting: swap the TV — unless this select is only mirroring a
    // queue advance the receiver made by itself
    if (!(opts && opts.noCast) && castingLive()) castNow();
    return j;
  });
}

function renderEntries(data) {
  curDir = data.path;
  $('curpath').textContent = data.path;
  var box = $('entries');
  box.innerHTML = '';
  data.entries.forEach(function (e) {
    var div = document.createElement('div');
    div.className = 'entry';
    var icon = e.dir ? '▸' : '·';
    div.innerHTML = '<span>' + icon + '</span><span></span>' +
      (e.dir ? '' : '<span class="size">' + e.sizeMB + ' MB</span>');
    div.children[1].textContent = e.name;
    div.onclick = function () {
      if (e.dir) browse(data.path === '/' ? '/' + e.name : data.path + '/' + e.name);
      else pickFile(data.path === '/' ? '/' + e.name : data.path + '/' + e.name, e.name);
    };
    box.appendChild(div);
  });
  if (!data.entries.length) box.innerHTML = '<div class="entry"><span>—</span><span>nothing matching here</span></div>';
}

function browse(dir) {
  api('/api/ls?type=' + browseTarget + '&path=' + encodeURIComponent(dir)).then(renderEntries)
    .catch(function (e) { $('curpath').textContent = 'error: ' + e.message; });
}

function pickFile(fullPath, name) {
  sel[browseTarget] = fullPath;
  var span = $(browseTarget + 'file');
  span.textContent = name;
  span.classList.remove('empty');
  $('browser').classList.remove('open');
  browseTarget = null;
  $('loadfiles').disabled = !(sel.video && sel.sub);
}

document.querySelectorAll('button[data-target]').forEach(function (b) {
  b.onclick = function () {
    browseTarget = b.dataset.target;
    $('usedir').textContent = 'Use as ' + (browseTarget === 'video' ? 'video' : 'subtitle') + ' folder';
    $('browser').classList.add('open');
    browse(curDir || 'home');
  };
});
document.querySelectorAll('button[data-jump]').forEach(function (b) {
  b.onclick = function () { browse(b.dataset.jump); };
});
DRIVES.forEach(function (d) {
  var b = document.createElement('button');
  b.textContent = d.label;
  b.onclick = function () { browse(d.path); };
  $('drivebtns').appendChild(b);
});

function toWslPath(p) {
  p = p.trim().replace(/^["']|["']$/g, '');
  var m = p.match(/^([A-Za-z]):[\\\\/](.*)$/);
  if (m) return '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\\\/g, '/');
  return p;
}
$('pathinput').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var p = toWslPath(e.target.value);
  if (!p) return;
  api('/api/ls?type=' + browseTarget + '&path=' + encodeURIComponent(p))
    .then(renderEntries)
    .catch(function () {
      // maybe they pasted a file path — try its parent folder
      var parent = p.replace(/\\/[^/]+$/, '') || '/';
      browse(parent);
    });
});
$('up').onclick = function () {
  if (!curDir || curDir === '/') return;
  var parent = curDir.replace(/\\/[^/]+$/, '') || '/';
  browse(parent);
};

$('usedir').onclick = function () {
  if (!curDir || !browseTarget) return;
  folderSel[browseTarget] = curDir;
  var vdir = folderSel.video || curDir;
  var sdir = folderSel.sub || curDir;
  api('/api/pair?vpath=' + encodeURIComponent(vdir) + '&spath=' + encodeURIComponent(sdir)).then(function (data) {
    renderEpisodes(data);
    $('browser').classList.remove('open');
    browseTarget = null;
  }).catch(function (e) { $('curpath').textContent = 'error: ' + e.message; });
};

var epItems = [];
var epRowEls = [];

// scroll a row to the top of the episode list, so upcoming episodes read downward
// and scrolling up reveals what was already watched
function scrollRowTop(row) {
  var box = $('episodes');
  if (!row || !box) return;
  box.scrollTo({
    top: box.scrollTop + row.getBoundingClientRect().top - box.getBoundingClientRect().top,
    behavior: 'smooth',
  });
}

function playEpisodeAt(idx, thenCast) {
  var it = epItems[idx];
  if (!it) { status('no more episodes in the list'); return; }
  status('loading episode…');
  selectPair(it.video, it.sub, function () {
    epRowEls.forEach(function (e) { e.classList.remove('active'); });
    if (epRowEls[idx]) {
      epRowEls[idx].classList.add('active');
      scrollRowTop(epRowEls[idx]);
    }
    if (thenCast && !castingLive()) {
      // hidden tabs get intensive timer throttling, so a fixed retry chain is
      // unreliable — arm the watchdog, which keeps attempting until the TV plays
      autoNextTries = 5;
      clog('auto-next: loaded "' + it.name + '", arming cast watchdog');
      setTimeout(function () {
        try { castNow(); } catch (e) { clog('auto-next castNow threw: ' + e.message); }
      }, 700);
    } else if (!castingLive()) {
      status('Loaded — press Cast.');
    }
  }).catch(function (e) { status('error: ' + e.message); });
}

function currentEpIndex() {
  if (!loaded) return -1;
  for (var i = 0; i < epItems.length; i++) {
    if (epItems[i].name === loaded.video) return i;
  }
  return -1;
}

function renderEpisodes(data) {
  epItems = data.items;
  epRowEls = [];
  $('epcard').style.display = data.items.length ? 'flex' : 'none';
  function lastSeg(p) { return p.split('/').pop() || p; }
  $('epdir').textContent = data.videoPath === data.subPath
    ? lastSeg(data.videoPath)
    : lastSeg(data.videoPath) + ' + ' + lastSeg(data.subPath);
  $('ephint').title = 'video: ' + data.videoPath + '\\nsubs: ' + data.subPath;
  if (!data.items.length) { $('pickinfo').textContent = 'no videos found in that folder'; return; }
  var box = $('episodes');
  box.innerHTML = '';
  data.items.forEach(function (it, idx) {
    var div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = '<span>·</span><span></span>' +
      (it.subName ? '<span class="subname"></span>' : '<span class="nosub">no sub matched</span>');
    div.children[1].textContent = it.name;
    div.title = it.name + (it.subName ? '\\n+ ' + it.subName : '');
    if (it.subName) div.children[2].textContent = it.subName;
    if (it.watched) {
      var w = document.createElement('span');
      w.className = 'done';
      w.textContent = '✓';
      w.title = 'watched';
      div.appendChild(w);
    } else if (it.position > 15) {
      var p = document.createElement('span');
      p.className = 'pos';
      p.textContent = '▸ ' + fmt(it.position);
      p.title = 'resumes here';
      div.appendChild(p);
    }
    if (it.enhanced) {
      var badge = document.createElement('span');
      badge.textContent = '✦';
      badge.className = 'pos';
      badge.title = 'enhanced version exists — will be used automatically';
      div.appendChild(badge);
    } else if (ENHANCE_ENABLED) {
      var eb = document.createElement('button');
      eb.textContent = '✦';
      eb.title = 'enhance with Anime4K';
      eb.style.cssText = 'padding:.1rem .4rem; font-size:.8rem; margin-left:.4rem';
      eb.onclick = function (ev) {
        ev.stopPropagation();
        fetch('/api/enhance', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Subcast-Key': KEY },
          body: JSON.stringify({ video: it.video }),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.error) { $('enhstatus').textContent = 'enhance: ' + j.error; return; }
          eb.disabled = true;
          pollEnhance();
        });
      };
      div.appendChild(eb);
    }
    if (loaded && loaded.video === it.name) div.classList.add('active');
    div.onclick = function () { playEpisodeAt(idx); };
    epRowEls.push(div);
    box.appendChild(div);
  });
  var ci = currentEpIndex();
  if (ci >= 0 && epRowEls[ci]) {
    requestAnimationFrame(function () { scrollRowTop(epRowEls[ci]); });
  }
}

var enhTimer = null;
function pollEnhance() {
  api('/api/enhance-status').then(function (s) {
    var txt = '';
    if (s.current) txt = 'enhancing ' + s.current.name + ' — ' + s.current.pct + '%';
    if (s.queue.length) txt += '  (+' + s.queue.length + ' queued)';
    if (s.failed.length) txt += '  failed: ' + s.failed.join(', ');
    $('enhstatus').textContent = txt;
    if (s.current || s.queue.length) {
      if (!enhTimer) enhTimer = setInterval(pollEnhance, 3000);
    } else if (enhTimer) {
      clearInterval(enhTimer);
      enhTimer = null;
      reloadEpisodeList(); // refresh enhanced badges
    }
  }).catch(function () {});
}

function reloadEpisodeList() {
  if (!folderSel.video) return;
  api('/api/pair?vpath=' + encodeURIComponent(folderSel.video) + '&spath=' + encodeURIComponent(folderSel.sub || folderSel.video))
    .then(renderEpisodes).catch(function () {});
}

$('loadfiles').onclick = function () {
  $('pickinfo').textContent = 'loading…';
  selectPair(sel.video, sel.sub)
    .catch(function (e) { $('pickinfo').textContent = 'error: ' + e.message; });
};

function applyState(j) {
  if (!j.video) return;
  loaded = j;
  $('videofile').textContent = j.video; $('videofile').classList.remove('empty');
  if (j.sub) {
    $('subfile').textContent = j.sub; $('subfile').classList.remove('empty');
  } else {
    $('subfile').textContent = 'none'; $('subfile').classList.add('empty');
  }
  var cueinfo = j.bilingual
    ? j.cues + ' cues (bilingual: ' + j.zhCues + ' 中文 + ' + j.jaCues + ' 日文)'
    : j.cues + ' subtitle cues';
  $('pickinfo').textContent = (j.enhanced ? '✦ enhanced · ' : '') + j.videoSizeMB + ' MB' + (j.sub ? ', ' + cueinfo : ', no subtitle');
  $('warnings').innerHTML = '';
  (j.warnings || []).forEach(function (w) {
    var d = document.createElement('div'); d.className = 'warn'; d.textContent = '⚠ ' + w;
    $('warnings').appendChild(d);
  });
  $('langwrap').style.display = j.bilingual ? '' : 'none';
  $('nowplaying').textContent = j.video ? j.video.replace(/\\.[^.]+$/, '') : '';
  $('castcard').classList.add('ready');
  $('floatbar').classList.add('on');
  updatePreview();
}

function currentLang() {
  return (loaded && loaded.bilingual) ? $('sublang').value : 'all';
}

function updatePreview() {
  if (!loaded) return;
  var pv = $('preview');
  pv.innerHTML = '';
  var src = document.createElement('source');
  src.src = '/video?v=' + loaded.version;
  pv.appendChild(src);
  if (loaded.sub) {
    var track = document.createElement('track');
    track.src = '/subs.vtt?v=' + loaded.version + '&lang=' + currentLang();
    track.kind = 'subtitles'; track.label = 'Subtitles'; track.default = true;
    pv.appendChild(track);
  }
  pv.load();
  $('pvsubs').innerHTML = '';
  pv.addEventListener('loadedmetadata', function h() {
    pv.removeEventListener('loadedmetadata', h);
    if (loaded.position > 15) pv.currentTime = loaded.position;
    hookPreviewTrack();
    updateCueCss();
    if (autoPlayPreview) {
      autoPlayPreview = false;
      pv.play().catch(function () { status('next episode ready — press play (browser blocked autoplay)'); });
    }
  });
}

// render subtitles in our own overlay — the browser's native cue renderer ignores
// line-height and gives no real styling control
function hookPreviewTrack() {
  var pv = $('preview');
  var tt = pv.textTracks && pv.textTracks[0];
  if (!tt) return;
  tt.mode = 'hidden';
  tt.oncuechange = renderPvSubs;
  renderPvSubs();
}

function renderPvSubs() {
  var box = $('pvsubs');
  box.innerHTML = '';
  var tt = $('preview').textTracks && $('preview').textTracks[0];
  if (!tt || tt.mode === 'disabled' || !tt.activeCues) return;
  for (var i = 0; i < tt.activeCues.length; i++) {
    // one .line element per subtitle line, so the gap between lines is a real,
    // adjustable margin (cue.text newlines separate e.g. the 中文 and 日本語 lines)
    tt.activeCues[i].text.split('\\n').forEach(function (lineText) {
      if (!lineText.trim()) return;
      var l = document.createElement('div');
      l.className = 'line';
      l.innerHTML = lineText.replace(/<(?!\\/?[ib]>)/g, '&lt;'); // allow only <i>/<b>
      box.appendChild(l);
    });
  }
}

// native fullscreen of the <video> hides our overlay — fall back to built-in cues there
document.addEventListener('fullscreenchange', function () {
  var pv = $('preview');
  var tt = pv.textTracks && pv.textTracks[0];
  if (!tt) return;
  tt.mode = (document.fullscreenElement === pv) ? 'showing' : 'hidden';
  if (tt.mode === 'hidden') renderPvSubs();
});

window.addEventListener('resize', function () { updateCueCss(); });

// ---- cast ----
window['__onGCastApiAvailable'] = function (ok) { if (ok) initCast(); };

function initCast() {
  var ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  // the Default Media Receiver closes itself after ~5 min of idle — say so
  // instead of letting the buttons silently stop working
  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function (e) {
    var S = cast.framework.SessionState;
    clog('session state: ' + e.sessionState);
    if (e.sessionState === S.SESSION_ENDED) {
      currentTracks = null;
      currentTrackId = null;
      queueActive = false;
      status('TV session ended (the receiver idles out after ~5 min of nothing playing) — click the cast icon to reconnect');
    } else if (e.sessionState === S.SESSION_STARTED || e.sessionState === S.SESSION_RESUMED) {
      status('Connected — press Cast to play' + (loaded && loaded.video ? ' “' + loaded.video + '”' : '') + '.');
    }
  });
  player = new cast.framework.RemotePlayer();
  controller = new cast.framework.RemotePlayerController(player);
  controller.addEventListener(cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED, updateSeek);
  controller.addEventListener(cast.framework.RemotePlayerEventType.DURATION_CHANGED, updateSeek);
  controller.addEventListener(cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED, function () {
    clog('tv: isPaused=' + player.isPaused + ' state=' + player.playerState);
    syncPreview();
    reportProgress(true); // save the exact spot on pause
  });
  controller.addEventListener(cast.framework.RemotePlayerEventType.VOLUME_LEVEL_CHANGED, function () {
    if (castingLive()) $('fvol').value = player.volumeLevel;
  });
  controller.addEventListener(cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, maybeAutoNext);
  controller.addEventListener(cast.framework.RemotePlayerEventType.IS_MEDIA_LOADED_CHANGED, maybeAutoNext);
  controller.addEventListener(cast.framework.RemotePlayerEventType.MEDIA_INFO_CHANGED, function () {
    onMediaInfoChanged();
    maybeAutoNext();
  });
  status('Ready — pick a device with the cast icon, then press Cast.');
}

function fmt(s) {
  s = Math.floor(s || 0);
  var m = Math.floor(s / 60), h = Math.floor(m / 60);
  return (h ? h + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
}
var lastProgressSent = 0;
var lastKnownT = 0;
var lastKnownD = 0;
var autoNextTries = 0;

// survives tab throttling: keeps trying to start the cast until the TV
// actually reports playback (or attempts run out)
setInterval(function () {
  if (autoNextTries <= 0) return;
  if (castingLive()) {
    autoNextTries = 0;
    clog('auto-next: confirmed playing on TV');
    return;
  }
  autoNextTries--;
  clog('auto-next: watchdog retry (' + autoNextTries + ' left)');
  status('auto-next: retrying cast…');
  try { castNow(); } catch (e) { clog('auto-next castNow threw: ' + e.message); }
}, 8000);

// shared, debounced advance — reachable from both the cast path and the preview path
var lastAutoAdvance = 0;
function autoAdvanceOnce(viaCast) {
  var now = Date.now();
  if (now - lastAutoAdvance < 5000) return; // both paths may detect the same ending
  var i = currentEpIndex();
  if (i < 0 || !epItems[i + 1]) { status('episode finished — end of list'); return; }
  lastAutoAdvance = now;
  clog('auto-next(' + (viaCast ? 'cast' : 'preview') + '): episode finished (idx ' + i + '), advancing');
  status('episode finished — playing the next one…');
  if (!viaCast) autoPlayPreview = true;
  playEpisodeAt(i + 1, viaCast);
}

// natural end of an episode → cast the next one (auto toggle on the floating bar).
// NOTE: on real receivers playerState often goes to null (media unloaded), not
// 'IDLE' — three days of logs showed the old strict-IDLE check never fired once.
function maybeAutoNext() {
  if (!player) return;
  if (queueActive) return; // the receiver advances its own queue — hands off
  var st = player.playerState;
  if (st && st !== 'IDLE') return; // anything actively loaded → not ended
  if (!$('fauto').checked) return;
  var finished = false;
  try {
    var s = cast.framework.CastContext.getInstance().getCurrentSession();
    var m = s && s.getMediaSession();
    if (m && m.idleReason === 'FINISHED') finished = true;
    if (!s) return; // session gone entirely — nothing to cast to
  } catch (e) { return; }
  // fallback signal: we last saw the playhead at the very end
  if (!finished && lastKnownD > 0 && lastKnownT / lastKnownD > 0.95) finished = true;
  if (!finished) return;
  autoAdvanceOnce(true);
}

function castActive() {
  try {
    var s = cast.framework.CastContext.getInstance().getCurrentSession();
    return Boolean(s && s.getMediaSession() && player && player.duration);
  } catch (e) { return false; }
}

// position of whichever player is actually in use: the Chromecast, else the browser preview
function currentPlayback() {
  if (castActive()) return { t: player.currentTime, d: player.duration };
  var pv = $('preview');
  if (pv && pv.duration && pv.currentTime > 0) return { t: pv.currentTime, d: pv.duration };
  return null;
}

function reportProgress(force) {
  var pb = currentPlayback();
  if (!pb) return;
  var now = Date.now();
  if (!force && now - lastProgressSent < 5000) return;
  lastProgressSent = now;
  fetch('/api/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Subcast-Key': KEY },
    body: JSON.stringify(pb),
  }).catch(function () {});
}

function updateSeek() {
  if (!player || !player.duration) return;
  lastKnownT = player.currentTime;
  lastKnownD = player.duration;
  $('seek').value = (player.currentTime / player.duration) * 100;
  $('time').textContent = fmt(player.currentTime) + ' / ' + fmt(player.duration);
  syncPreview();
  reportProgress(false);
}

window.addEventListener('pagehide', function () {
  var pb = currentPlayback();
  if (pb && navigator.sendBeacon) {
    navigator.sendBeacon('/api/progress?key=' + KEY,
      new Blob([JSON.stringify(pb)], { type: 'application/json' }));
  }
});

// ---- preview <-> TV sync ----
var syncOn = false, progSeek = false, progPlayPause = false;

var lastUserSeek = 0;
var pendingSeekTo = null;
var pendingSeekAt = 0;

// every seek we send goes through here, so the sync loop knows a seek is in
// flight until the TV actually reports a position near the target
function pushSeek(t) {
  if (!player || !controller) return;
  player.currentTime = t;
  controller.seek();
  pendingSeekTo = t;
  pendingSeekAt = Date.now();
  lastUserSeek = Date.now();
  reportProgress(true);
}

function syncPreview() {
  if (!syncOn || !player || !player.duration) return;
  if (document.hidden) return; // background tab: Chrome throttles/pauses the muted preview — leave it alone
  var pv = $('preview');
  if (pendingSeekTo !== null) {
    if (Math.abs(player.currentTime - pendingSeekTo) < 3 || Date.now() - pendingSeekAt > 15000) {
      pendingSeekTo = null; // TV arrived (or gave up) — resume normal syncing
    }
  }
  // don't yank the preview back while the user is scrubbing or a seek is still in flight
  if (pendingSeekTo === null && Date.now() - lastUserSeek > 2500 &&
      Math.abs(pv.currentTime - player.currentTime) > 1.5) {
    progSeek = true;
    pv.currentTime = player.currentTime;
  }
  var st = player.playerState;
  var tvPlaying = !player.isPaused && (st === 'PLAYING' || st === 'BUFFERING');
  if (tvPlaying && pv.paused) {
    clog('sync: starting preview (tv=' + st + ')');
    pv.muted = true; // sync mode always mutes the preview — the TV carries the audio
    progPlayPause = true;
    pv.play().catch(function () { progPlayPause = false; });
  } else if (!tvPlaying && !pv.paused) {
    clog('sync: pausing preview (tv=' + st + ' isPaused=' + player.isPaused + ')');
    progPlayPause = true;
    pv.pause();
  }
}

$('syncpv').checked = localStorage.subcastSync === '1';
syncOn = $('syncpv').checked;
if (syncOn) $('preview').muted = true; // restored sync must re-apply the mute, or reload double-plays audio
$('syncpv').onchange = function () {
  syncOn = this.checked;
  localStorage.subcastSync = syncOn ? '1' : '0';
  if (syncOn) { $('preview').muted = true; syncPreview(); }
};

$('preview').addEventListener('seeking', function () {
  if (!progSeek) lastUserSeek = Date.now();
});
var seekPushTimer = null;
$('preview').addEventListener('seeked', function () {
  if (progSeek) { progSeek = false; return; }
  lastUserSeek = Date.now();
  if (syncOn && player && player.duration && controller) {
    // scrubbing fires many seeks — only push the final position to the TV
    clearTimeout(seekPushTimer);
    seekPushTimer = setTimeout(function () {
      pushSeek($('preview').currentTime);
    }, 300);
  } else {
    reportProgress(true);
  }
});
$('preview').addEventListener('timeupdate', function () { reportProgress(false); });

// auto-next for browser-player watching — the cast path has its own handler
var autoPlayPreview = false;
$('preview').addEventListener('ended', function () {
  var pv = this;
  if (loaded && pv.duration) {
    // mark this episode watched by name, so it can't race the upcoming select
    fetch('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Subcast-Key': KEY },
      body: JSON.stringify({ t: pv.duration, d: pv.duration, name: loaded.video }),
    }).catch(function () {});
  }
  if (!$('fauto').checked || castingLive()) return;
  // if a cast session is connected, the next episode belongs on the TV even
  // though the preview's clock finished first
  var sAlive = false;
  try { sAlive = Boolean(cast.framework.CastContext.getInstance().getCurrentSession()); } catch (e) { /* no cast */ }
  autoAdvanceOnce(sAlive);
});
var userTouchedPreviewAt = 0;
$('pvwrap').addEventListener('pointerdown', function () { userTouchedPreviewAt = Date.now(); });
$('pvwrap').addEventListener('keydown', function () { userTouchedPreviewAt = Date.now(); });

function fwdPlayState() {
  if ($('preview').paused) reportProgress(true); // save the exact spot when preview pauses
  if (progPlayPause) { progPlayPause = false; return; }
  // browsers pause <video> for many internal reasons (tab throttling, source
  // swaps, buffer states) — only a real recent click/keypress on the player
  // is allowed to control the TV
  if (document.hidden) return;
  if (Date.now() - userTouchedPreviewAt > 2000) return;
  if (syncOn && controller && player && player.duration && player.isPaused !== $('preview').paused) {
    clog('fwd: mirroring user ' + ($('preview').paused ? 'pause' : 'play') + ' to TV');
    controller.playOrPause();
  }
}
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) syncPreview(); // tab back in focus: re-sync the preview to the TV
});
$('preview').addEventListener('play', fwdPlayState);
$('preview').addEventListener('pause', fwdPlayState);

$('cast').onclick = function () {
  try {
    castNow();
  } catch (e) {
    status('error: ' + e.message);
  }
};

var castSeq = 0;
var currentTrackId = null;
var currentTracks = null; // {zh: id, ja: id, all: id} for the live load
var lastCastVersion = null;
var queueActive = false; // the receiver is driving a native queue — it advances itself

function queueLang() {
  var v = $('sublang').value || 'all';
  return v;
}

function buildQueueItem(idx, base, first, resume) {
  var it = epItems[idx];
  var mi = new chrome.cast.media.MediaInfo(base + '/video/' + idx, 'video/mp4');
  mi.metadata = new chrome.cast.media.GenericMediaMetadata();
  mi.metadata.title = it.name;
  var qi;
  if (it.sub) {
    mi.tracks = ['zh', 'ja', 'all'].map(function (lg, k) {
      var tr = new chrome.cast.media.Track(k + 1, chrome.cast.media.TrackType.TEXT);
      tr.trackContentId = base + '/subs/' + idx + '.vtt?lang=' + lg;
      tr.trackContentType = 'text/vtt';
      tr.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
      tr.name = lg === 'zh' ? '中文' : lg === 'ja' ? '日本語' : 'Subtitles';
      tr.language = lg === 'ja' ? 'ja' : 'zh';
      return tr;
    });
    mi.textTrackStyle = buildStyle();
  }
  qi = new chrome.cast.media.QueueItem(mi);
  if (it.sub) qi.activeTrackIds = [{ zh: 1, ja: 2, all: 3 }[queueLang()]];
  qi.autoplay = first ? true : $('fauto').checked;
  qi.preloadTime = 20;
  if (first && resume > 0) qi.startTime = resume;
  return qi;
}

function doQueueLoad(i0, resume, base, session) {
  var end = Math.min(epItems.length, i0 + 50);
  var items = [];
  for (var idx = i0; idx < end; idx++) items.push(buildQueueItem(idx, base, idx === i0, resume));
  var req = new chrome.cast.media.QueueLoadRequest(items);
  req.startIndex = 0;
  clog('queueLoad: ' + items.length + ' items from idx ' + i0 + (resume > 0 ? ' resume=' + Math.round(resume) : '') +
    (end < epItems.length ? ' (list capped at 50)' : ''));
  session.getSessionObj().queueLoad(req,
    function () {
      queueActive = true;
      currentTracks = { zh: 1, ja: 2, all: 3 };
      currentTrackId = currentTracks[queueLang()] || 3;
      subsOn = true;
      $('subs').textContent = 'Subs: on';
      clog('queueLoad OK');
      status('Casting ✓ — the TV will auto-play ' + (items.length - 1) + ' more episode' + (items.length === 2 ? '' : 's') +
        (resume > 0 ? ' (resumed at ' + fmt(resume) + ')' : ''));
    },
    function (e) {
      queueActive = false;
      clog('queueLoad FAILED: ' + JSON.stringify(e));
      status('Queue load failed: ' + JSON.stringify(e));
    });
}

function castNow() {
  if (!loaded) return;
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) {
    clog('castNow: NO SESSION (state=' + cast.framework.CastContext.getInstance().getSessionState() + ')');
    status('No device connected — click the Cast icon (top right) first.');
    return;
  }
  var m0 = session.getMediaSession();
  clog('castNow: session ok, media=' + (m0 ? m0.playerState + '/' + (m0.idleReason || '-') : 'none'));
  // re-casting the same episode (seek recovery, language switch) resumes near where it was
  var resume = 0;
  if (lastCastVersion === loaded.version && player && player.currentTime > 5) {
    resume = Math.max(0, player.currentTime - 2);
  } else if (loaded.position > 15) {
    resume = Math.max(0, loaded.position - 2); // saved progress from a previous session
  }
  // the receiver keeps rendering old side-loaded cues across loads in the same
  // session — deactivate tracks first, then stop, then load fresh
  var media = session.getMediaSession();
  var live = media && media.playerState !== chrome.cast.media.PlayerState.IDLE;
  if (live) {
    status('restarting stream…');
    try {
      media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest([]), thenStop, thenStop);
    } catch (e) { thenStop(); }
  } else {
    doLoad();
  }
  function thenStop() {
    media.stop(new chrome.cast.media.StopRequest(), doLoad, doLoad);
  }

  function doLoad() {
    castSeq++;
    var base = 'http://' + ADVERTISE + ':' + PORT;
    var i0 = currentEpIndex();
    if (i0 >= 0 && epItems.length) {
      // folder mode → native queue: the RECEIVER advances episodes itself,
      // so auto-next survives the browser tab being discarded entirely
      doQueueLoad(i0, resume, base, session);
      lastCastVersion = loaded.version;
      pendingSeekTo = null;
      return;
    }
    queueActive = false;
    var mediaInfo = new chrome.cast.media.MediaInfo(base + '/video?v=' + loaded.version, loaded.mime || 'video/mp4');
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = loaded.video;
    var req = new chrome.cast.media.LoadRequest(mediaInfo);
    req.currentTime = resume;
    lastCastVersion = loaded.version;
    pendingSeekTo = null; // fresh load — no seek in flight
    if (loaded.sub) {
      // declare every language variant upfront so switching later is a track
      // activation (instant, safe) instead of a media reload (stacks cues)
      currentTracks = {};
      var langs = loaded.bilingual ? ['zh', 'ja', 'all'] : ['all'];
      mediaInfo.tracks = langs.map(function (lg, i) {
        var tid = castSeq * 10 + i + 1; // unique across loads
        var tr = new chrome.cast.media.Track(tid, chrome.cast.media.TrackType.TEXT);
        tr.trackContentId = base + '/subs.vtt?v=' + loaded.version + '&lang=' + lg + '&c=' + castSeq;
        tr.trackContentType = 'text/vtt';
        tr.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
        tr.name = lg === 'zh' ? '中文' : lg === 'ja' ? '日本語' : 'Subtitles';
        tr.language = lg === 'ja' ? 'ja' : 'zh';
        currentTracks[lg] = tid;
        return tr;
      });
      mediaInfo.textTrackStyle = buildStyle();
      currentTrackId = currentTracks[currentLang()] || currentTracks.all;
      req.activeTrackIds = [currentTrackId];
      subsOn = true;
      $('subs').textContent = 'Subs: on';
    } else {
      currentTracks = null;
      currentTrackId = null;
    }
    session.loadMedia(req).then(
      function () {
        clog('loadMedia OK: ' + loaded.video + ' resume=' + Math.round(resume));
        status((loaded.sub ? 'Casting with subtitles ✓' : 'Casting, no subtitle ✓') +
          (resume > 0 ? ' — resumed at ' + fmt(resume) : ''));
      },
      function (e) {
        clog('loadMedia FAILED: ' + JSON.stringify(e));
        status('Load failed: ' + JSON.stringify(e));
      }
    );
  }
};

$('mpv').onclick = function () {
  fetch('/api/mpv', { method: 'POST', headers: { 'X-Subcast-Key': KEY } })
    .then(function (r) { return r.json(); })
    .then(function (j) { status(j.error ? 'mpv: ' + j.error : 'opened in mpv on this PC'); })
    .catch(function (e) { status('mpv: ' + e.message); });
};
$('playpause').onclick = function () { if (controller) controller.playOrPause(); };
$('stop').onclick = function () {
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  var media = session && session.getMediaSession();
  if (!media) { status('nothing playing'); return; }
  media.stop(new chrome.cast.media.StopRequest(),
    function () { status('stopped'); },
    function (e) { status('stop failed: ' + JSON.stringify(e)); });
};
$('back').onclick = function () { if (player) pushSeek(Math.max(0, player.currentTime - 10)); };
$('fwd').onclick = function () { if (player) pushSeek(player.currentTime + 10); };
$('seek').oninput = function (e) {
  if (player && player.duration) pushSeek((e.target.value / 100) * player.duration);
};
// the receiver advanced its native queue — mirror that in the UI and server state
function onMediaInfoChanged() {
  try {
    var ci = (player.mediaInfo && player.mediaInfo.contentId) || '';
    var m = ci.match(/\\/video\\/(\\d+)$/);
    if (!m) return;
    queueActive = true; // a queue URL is playing (covers page reloads mid-queue)
    var idx = Number(m[1]);
    recoverTracks();
    if (idx !== currentEpIndex() && epItems[idx]) {
      clog('queue: receiver advanced to idx ' + idx);
      selectPair(epItems[idx].video, epItems[idx].sub, function () {
        epRowEls.forEach(function (e) { e.classList.remove('active'); });
        if (epRowEls[idx]) { epRowEls[idx].classList.add('active'); scrollRowTop(epRowEls[idx]); }
      }, { noCast: true }).catch(function () {});
    }
  } catch (e) { /* no media info yet */ }
}

// after a page reload mid-cast the track ids are lost — recover them from the live media session
function recoverTracks() {
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  var media = session && session.getMediaSession();
  if (!media || !media.media || !media.media.tracks) return null;
  currentTracks = {};
  media.media.tracks.forEach(function (t) {
    if (t.type !== chrome.cast.media.TrackType.TEXT) return;
    var m = (t.trackContentId || '').match(/[?&]lang=(\\w+)/);
    currentTracks[m ? m[1] : 'all'] = t.trackId;
  });
  var act = media.activeTrackIds || [];
  currentTrackId = null;
  subsOn = false;
  for (var k in currentTracks) {
    if (act.indexOf(currentTracks[k]) >= 0) { currentTrackId = currentTracks[k]; subsOn = true; }
  }
  if (currentTrackId === null) currentTrackId = currentTracks[currentLang()] || currentTracks.all || null;
  $('subs').textContent = 'Subs: ' + (subsOn ? 'on' : 'off');
  return media;
}

$('subs').onclick = function (e) {
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) { status('not connected to a Chromecast'); return; }
  var media = session.getMediaSession();
  if (!media) { status('nothing playing'); return; }
  if (currentTrackId === null || !currentTracks) recoverTracks();
  if (currentTrackId === null) { status('this stream has no subtitle track'); return; }
  subsOn = !subsOn;
  media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest(subsOn ? [currentTrackId] : []),
    function () { status(subsOn ? 'subtitles shown' : 'subtitles hidden'); },
    function (err) { subsOn = !subsOn; status('subs toggle failed: ' + JSON.stringify(err)); });
  e.target.textContent = 'Subs: ' + (subsOn ? 'on' : 'off');
};

// ---- subtitle style ----
function buildStyle() {
  var st = new chrome.cast.media.TextTrackStyle();
  st.fontScale = parseFloat($('fontscale').value);
  st.foregroundColor = $('fgcolor').value.toUpperCase() + 'FF';
  var edge = $('edgestyle').value;
  st.edgeType = edge === 'none' ? chrome.cast.media.TextTrackEdgeType.NONE
    : edge === 'shadow' ? chrome.cast.media.TextTrackEdgeType.DROP_SHADOW
    : chrome.cast.media.TextTrackEdgeType.OUTLINE; // 'both' → outline on TV
  st.edgeColor = $('edgecolor').value.toUpperCase() + 'FF';
  var a = Math.round(parseFloat($('boxalpha').value) * 255).toString(16).toUpperCase();
  if (a.length < 2) a = '0' + a;
  st.backgroundColor = $('bgbox').checked ? ($('boxcolor').value.toUpperCase() + a) : '#00000000';
  return st;
}

function hexToRgba(hex, alpha) {
  return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' +
    parseInt(hex.slice(5, 7), 16) + ',' + alpha + ')';
}

var cueCss = document.createElement('style');
document.head.appendChild(cueCss);
function updateCueCss() {
  var scale = parseFloat($('fontscale').value);
  var gap = parseFloat($('linegap').value);
  var pv = $('preview');
  var px = Math.max(11, Math.round((pv.clientWidth || 720) * 0.03 * scale));
  var edge = $('edgestyle').value;
  var ec = $('edgecolor').value;
  var shadows = [];
  if (edge === 'outline' || edge === 'both') {
    shadows.push('0 0 4px ' + ec, '0 0 4px ' + ec,
      '1px 1px 0 ' + ec, '-1px 1px 0 ' + ec, '1px -1px 0 ' + ec, '-1px -1px 0 ' + ec);
  }
  if (edge === 'shadow' || edge === 'both') shadows.push('2px 3px 6px ' + ec);
  var outline = shadows.length ? 'text-shadow: ' + shadows.join(', ') + ';' : 'text-shadow: none;';
  var boxOn = $('bgbox').checked;
  var bg = boxOn ? hexToRgba($('boxcolor').value, parseFloat($('boxalpha').value)) : 'transparent';
  var border = (boxOn && $('boxborder').checked) ? '1.5px solid ' + ec : 'none';
  cueCss.textContent =
    '#pvsubs { color: ' + $('fgcolor').value + '; font-size: ' + px + 'px; ' + outline + ' }' +
    '#pvsubs .line { background-color: ' + bg + '; border: ' + border + '; }' +
    '#pvsubs .line + .line { margin-top: ' + gap + 'em; }' +
    // fullscreen fallback uses native cues (limited styling, no gap/border control)
    'video::cue { color: ' + $('fgcolor').value +
    '; font-size: ' + Math.round(scale * 100) + '%' +
    '; background-color: ' + (boxOn ? hexToRgba($('boxcolor').value, parseFloat($('boxalpha').value)) : 'transparent') + '; }';
}

function applyStyleLive() {
  localStorage.subcastStyle = JSON.stringify({
    scale: $('fontscale').value, color: $('fgcolor').value, gap: $('linegap').value,
    edge: $('edgestyle').value, edgeColor: $('edgecolor').value,
    bg: $('bgbox').checked, boxColor: $('boxcolor').value,
    boxAlpha: $('boxalpha').value, border: $('boxborder').checked,
  });
  updateCueCss();
  if (!(window.chrome && window.chrome.cast && chrome.cast.media)) return;
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) return;
  var media = session.getMediaSession();
  if (!media) return;
  media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest(null, buildStyle()), function () {}, function () {});
}

try {
  var ss = JSON.parse(localStorage.subcastStyle || '{}');
  if (ss.scale) $('fontscale').value = ss.scale;
  if (ss.color) $('fgcolor').value = ss.color;
  if (ss.gap) $('linegap').value = ss.gap;
  if (ss.edge) $('edgestyle').value = ss.edge;
  else if (ss.outline !== undefined) $('edgestyle').value = ss.outline ? 'outline' : 'none'; // legacy
  if (ss.edgeColor) $('edgecolor').value = ss.edgeColor;
  if (ss.bg !== undefined) $('bgbox').checked = ss.bg;
  if (ss.boxColor) $('boxcolor').value = ss.boxColor;
  if (ss.boxAlpha) $('boxalpha').value = ss.boxAlpha;
  if (ss.border !== undefined) $('boxborder').checked = ss.border;
} catch (e) { /* fresh browser */ }
updateCueCss();
['fontscale', 'linegap', 'fgcolor', 'edgestyle', 'edgecolor', 'bgbox', 'boxcolor', 'boxalpha', 'boxborder'].forEach(function (id) {
  $(id).addEventListener('change', applyStyleLive);
});

if (localStorage.subcastLang) $('sublang').value = localStorage.subcastLang;
$('sublang').onchange = function () {
  localStorage.subcastLang = $('sublang').value;
  updatePreview();
  // live switch = activate a different pre-declared track; never reloads the stream
  var session = window.cast && cast.framework.CastContext.getInstance().getCurrentSession();
  var media = session && session.getMediaSession();
  if (media && media.playerState !== chrome.cast.media.PlayerState.IDLE && !currentTracks) recoverTracks();
  if (media && media.playerState !== chrome.cast.media.PlayerState.IDLE && currentTracks) {
    currentTrackId = currentTracks[currentLang()] || currentTracks.all;
    subsOn = true;
    $('subs').textContent = 'Subs: on';
    media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest([currentTrackId]),
      function () { status('subtitle track switched ✓'); },
      function (e) { status('switch failed: ' + JSON.stringify(e)); });
  }
};

// ---- floating controller ----
$('fprev').onclick = function () {
  var i = currentEpIndex();
  if (i < 0) { status('no episode list loaded'); return; }
  playEpisodeAt(i - 1);
};
$('fnext').onclick = function () {
  var i = currentEpIndex();
  if (i < 0) { status('no episode list loaded'); return; }
  playEpisodeAt(i + 1);
};
$('fplay').onclick = function () {
  if (castingLive() && controller) { controller.playOrPause(); return; }
  var pv = $('preview');
  if (pv.paused) pv.play().catch(function () {}); else pv.pause();
};

var SPEEDS = [1, 1.25, 1.5, 2, 0.75];
var speedIdx = 0;
var rateReqId = 9000;
$('fspeed').onclick = function () {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  var r = SPEEDS[speedIdx];
  this.textContent = r + '×';
  $('preview').playbackRate = r;
  if (!castingLive()) { status('preview speed ' + r + '×'); return; }
  var session = cast.framework.CastContext.getInstance().getCurrentSession();
  var media = session.getMediaSession();
  try {
    if (typeof media.setPlaybackRate === 'function') {
      media.setPlaybackRate(r,
        function () { status('speed ' + r + '×'); },
        function () { status('TV rejected speed change — preview only'); });
    } else {
      // older sender lib: talk to the receiver's media channel directly
      session.sendMessage('urn:x-cast:com.google.cast.media', {
        type: 'SET_PLAYBACK_RATE',
        mediaSessionId: media.mediaSessionId,
        requestId: rateReqId++,
        playbackRate: r,
      });
      status('speed ' + r + '×');
    }
  } catch (e) {
    status('speed not supported by this TV — preview only');
  }
};

$('fauto').checked = localStorage.subcastAuto === '1';
$('fauto').onchange = function () { localStorage.subcastAuto = this.checked ? '1' : '0'; };

$('fvol').oninput = function () {
  var v = parseFloat(this.value);
  if (castingLive() && controller) {
    player.volumeLevel = v;
    controller.setVolumeLevel();
  } else {
    var pv = $('preview');
    pv.volume = v;
    if (v > 0 && !syncOn) pv.muted = false;
  }
};

// restore state on page load: last-played file, plus the episode list from remembered folders
api('/api/state').then(function (j) {
  applyState(j);
  if (j.prefs && j.prefs.videoDir) {
    folderSel.video = j.prefs.videoDir;
    folderSel.sub = j.prefs.subDir || j.prefs.videoDir;
    api('/api/pair?vpath=' + encodeURIComponent(folderSel.video) + '&spath=' + encodeURIComponent(folderSel.sub))
      .then(renderEpisodes).catch(function () {});
  }
  pollEnhance(); // pick up any enhancement jobs already running
}).catch(function () {});
</script>
<script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
</body></html>`;

// ---------- HTTP server ----------
function streamVideo(filePath, fileSize, mime, req, res, cors) {
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
    end = Math.min(end, fileSize - 1);
    if (start > end || start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, ...cors });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...cors,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const rs = fs.createReadStream(filePath, { start, end });
    rs.on('data', pokeAwake); // long-lived streams keep poking while bytes flow
    rs.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      ...cors,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const rs2 = fs.createReadStream(filePath);
    rs2.on('data', pokeAwake);
    rs2.pipe(res);
  }
}

function authorized(req, u) {
  const a = req.socket.remoteAddress;
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') return true;
  return u.searchParams.get('key') === SECRET || req.headers['x-subcast-key'] === SECRET;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE
      .replace('%%ADVERTISE%%', JSON.stringify(advertise))
      .replace('%%PORT%%', JSON.stringify(PORT))
      .replace('%%DRIVES%%', JSON.stringify(winDrives()))
      .replace('%%ENH%%', JSON.stringify(Boolean(flags.enhance))));

  } else if (url.startsWith('/api/')) {
    // filesystem access needs the key (or true loopback); the Chromecast never needs these
    if (!authorized(req, u)) {
      json(res, 403, { error: 'unauthorized — open the exact URL printed in the terminal (it includes ?key=…)' });
      return;
    }

    if (url === '/api/state') {
      json(res, 200, publicState());

    } else if (url === '/api/pair') {
      try {
        const vdir = fs.realpathSync(u.searchParams.get('vpath') || u.searchParams.get('path') || os.homedir());
        const sdir = fs.realpathSync(u.searchParams.get('spath') || vdir);
        const items = pairFolder(vdir, sdir);
        prefs.videoDir = vdir;
        prefs.subDir = sdir;
        savePrefs();
        json(res, 200, { videoPath: vdir, subPath: sdir, items });
      } catch (e) {
        json(res, 400, { error: e.message });
      }

    } else if (url === '/api/ls') {
      let dir = u.searchParams.get('path') || 'home';
      if (dir === 'home') dir = os.homedir();
      const type = u.searchParams.get('type') === 'sub' ? SUB_EXT : VIDEO_EXT;
      try {
        dir = fs.realpathSync(dir);
        const entries = [];
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.isDirectory()) entries.push({ name, dir: true });
          else if (type.includes(path.extname(name).toLowerCase())) {
            entries.push({ name, dir: false, sizeMB: +(st.size / 1e6).toFixed(1) });
          }
        }
        entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        json(res, 200, { path: dir, entries });
      } catch (e) {
        json(res, 400, { error: e.message });
      }

    } else if (url === '/api/progress' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const { t, d, name } = JSON.parse(body);
          if (!state.videoPath || !(t >= 0)) { json(res, 200, { ok: false }); return; }
          pokeAwake();
          // explicit name wins: end-of-episode reports can race the next /api/select
          const key = (typeof name === 'string' && name) ? name : path.basename(state.videoPath);
          if (d > 0 && t / d > 0.95) {
            delete prefs.positions[key];
            prefs.watched[key] = true;
          } else if (t > 15) {
            prefs.positions[key] = Math.floor(t);
          }
          savePrefs();
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { error: e.message });
        }
      });

    } else if (url === '/api/enhance' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          if (!flags.enhance) { json(res, 400, { error: 'enhancement is disabled — start the server with --enhance to allow GPU encoding' }); return; }
          if (!fs.existsSync(FFMPEG)) { json(res, 400, { error: 'ffmpeg not found at D:\\mpv\\ffmpeg71.exe' }); return; }
          const videoPath = fs.realpathSync(JSON.parse(body).video);
          if (fs.existsSync(enhancedPathFor(videoPath))) { json(res, 200, { already: true }); return; }
          const busy = enhance.queue.includes(videoPath) ||
            (enhance.current && enhance.current.name === path.basename(videoPath));
          if (!busy) { enhance.queue.push(videoPath); enhanceNext(); }
          json(res, 200, { queued: true });
        } catch (e) {
          json(res, 400, { error: e.message });
        }
      });

    } else if (url === '/api/enhance-status') {
      json(res, 200, {
        current: enhance.current,
        queue: enhance.queue.map((p) => path.basename(p)),
        done: enhance.done,
        failed: enhance.failed,
      });

    } else if (url === '/api/clientlog' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { dlog(`client: ${body.slice(0, 500)}`); json(res, 200, { ok: true }); });

    } else if (url === '/api/mpv' && req.method === 'POST') {
      if (!state.videoPath) { json(res, 400, { error: 'no video loaded' }); return; }
      const mpvExe = '/mnt/d/mpv/mpv.exe';
      if (!fs.existsSync(mpvExe)) { json(res, 400, { error: 'mpv not found at D:\\mpv\\mpv.exe' }); return; }
      const toWin = (p) => spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim();
      const args = [toWin(state.videoPath)];
      if (state.subPath) args.push('--sub-file=' + toWin(state.subPath));
      if (u.searchParams.get('dry')) { json(res, 200, { cmd: [mpvExe, ...args] }); return; }
      spawn(mpvExe, args, { detached: true, stdio: 'ignore' }).unref();
      console.log(`mpv: ${path.basename(state.videoPath)}`);
      json(res, 200, { ok: true });

    } else if (url === '/api/select' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const { video, sub } = JSON.parse(body);
          let vPath = fs.realpathSync(video);
          const enh = enhancedPathFor(vPath);
          if (path.basename(path.dirname(vPath)) !== 'enhanced' && fs.existsSync(enh)) vPath = enh;
          const info = selectFiles(vPath, sub ? fs.realpathSync(sub) : null);
          console.log(`selected: ${video}`);
          console.log(`          ${sub || '(no subtitle)'} → ${state.cueCount} cues`);
          state.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
          json(res, 200, info);
        } catch (e) {
          json(res, 400, { error: e.message });
        }
      });

    } else {
      json(res, 404, { error: 'not found' });
    }

  } else if (url === '/subs.vtt') {
    if (!state.vtt) { res.writeHead(404, cors); res.end('no subtitle loaded'); return; }
    const lang = u.searchParams.get('lang');
    const body = (state.cues && (lang === 'zh' || lang === 'ja'))
      ? buildVtt(state.cues.filter((c) => c.lang === lang))
      : state.vtt;
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', ...cors });
    res.end(body);

  } else if (url === '/video') {
    if (!state.videoPath) { res.writeHead(404, cors); res.end('no video loaded'); return; }
    pokeAwake();
    dlog(`video request ${req.headers.range || '(full)'} from ${req.socket.remoteAddress}`);
    streamVideo(state.videoPath, state.videoSize, state.videoMime, req, res, cors);

  } else if (/^\/video\/\d+$/.test(url)) {
    const items = currentPairing();
    const it = items[Number(url.slice(7))];
    if (!it) { res.writeHead(404, cors); res.end('no such episode'); return; }
    let vp = it.video;
    const enh = enhancedPathFor(vp);
    if (fs.existsSync(enh)) vp = enh;
    let size;
    try { size = fs.statSync(vp).size; } catch { res.writeHead(404, cors); res.end('file missing'); return; }
    pokeAwake();
    dlog(`queue video ${url.slice(7)} (${path.basename(vp)}) ${req.headers.range || '(full)'}`);
    streamVideo(vp, size, MIME[path.extname(vp).toLowerCase()] || 'video/mp4', req, res, cors);

  } else if (/^\/subs\/\d+\.vtt$/.test(url)) {
    const items = currentPairing();
    const it = items[Number(url.slice(6, -4))];
    if (!it || !it.sub) { res.writeHead(404, cors); res.end('no subtitle'); return; }
    let entry;
    try { entry = subsFor(it.sub); } catch { res.writeHead(404, cors); res.end('subtitle unreadable'); return; }
    const lang = u.searchParams.get('lang');
    const body = (entry.cues && (lang === 'zh' || lang === 'ja'))
      ? buildVtt(entry.cues.filter((c) => c.lang === lang))
      : entry.vtt;
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', ...cors });
    res.end(body);

  } else {
    res.writeHead(404, cors);
    res.end('not found');
  }
});

// heartbeat while actively streaming — a gap in these lines marks exactly when
// the server (or the machine under it) stopped. Also releases the wake hold
// after ~3 minutes without streaming activity.
setInterval(() => {
  const idleMs = Date.now() - lastPoke;
  if (idleMs < 70000) dlog('streaming heartbeat');
  if (awakeProc && idleMs > 180000) releaseAwake();
}, 60000);
process.on('uncaughtException', (e) => { dlog(`UNCAUGHT: ${e.stack || e}`); console.error(e); });

server.listen(PORT, '0.0.0.0', () => {
  dlog(`server start pid=${process.pid} port=${PORT} advertise=${advertise} screenOff=${Boolean(flags.screenOff)}`);
  console.log('subcast running:');
  if (state.videoPath) {
    console.log(`  video:    ${state.videoPath} (${(state.videoSize / 1e6).toFixed(1)} MB)`);
    console.log(`  subtitle: ${state.cueCount} cues loaded`);
    state.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }
  console.log('');
  console.log(`  Open in Chrome:        http://localhost:${PORT}/?key=${SECRET}`);
  console.log(`  Chromecast fetches:    http://${advertise}:${PORT}/video`);
  console.log('  (the ?key=… part is required for the file browser — bookmark the full URL)');
  console.log('');
  if (wsl && !flags.advertise) {
    console.log('  ⚠ WSL2 detected with no --advertise flag. The Chromecast cannot reach the');
    console.log(`    WSL IP (${localIp()}). Re-run with your Windows LAN IP, e.g.:`);
    console.log('      node cast.js --advertise <windows-lan-ip>');
    console.log('    and set up port forwarding once (admin PowerShell on Windows):');
    console.log(`      netsh interface portproxy add v4tov4 listenport=${PORT} listenaddress=0.0.0.0 connectport=${PORT} connectaddress=${localIp()}`);
    console.log(`      netsh advfirewall firewall add rule name="subcast" dir=in action=allow protocol=TCP localport=${PORT}`);
  }
});
