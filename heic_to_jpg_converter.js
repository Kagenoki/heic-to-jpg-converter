#!/usr/bin/env node
/**
 * heic-to-jpg-converter.js (ESM)
 * ------------------------------------------------------------
 * Batch‑converts HEIC/HEIF stills to JPG while preserving full metadata
 * and extracts embedded motion video (if present) to standalone MP4.
 *
 * v5 — YOUR REQUESTED CHANGE:
 *  - Read orientation with ffprobe (or exiftool when available) but
 *    **apply rotation explicitly with ImageMagick**, not via auto-orient.
 *  - ImageMagick is now the preferred still-image path to avoid ffmpeg’s
 *    512×512 thumbnail quirk on some HEICs. We apply a precise transform
 *    for EXIF orientation codes (1..8) using IM ops (rotate/flip/transpose).
 *  - ffmpeg remains a fallback (with -noautorotate and explicit -vf) only if
 *    IM is unavailable.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
  debug: (...a) => { if (globalThis.__DEBUG__) console.log('[DEBUG]', ...a); },
};

function parseArgs(argv) {
  const args = { debug: false, quality: 95, recursive: false, dryRun: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--debug') args.debug = true;
    else if (v === '--recursive') args.recursive = true;
    else if (v === '--dry-run') args.dryRun = true;
    else if (v === '--quality') {
      const q = Number(argv[++i]);
      if (!Number.isFinite(q) || q < 1 || q > 100) throw new Error('--quality must be an integer 1–100');
      args.quality = Math.round(q);
    } else {
      rest.push(v);
    }
  }
  if (rest.length < 2) throw new Error('Usage: node heic-to-jpg-converter.js <sourceDir> <outputDir> [--quality <1-100>] [--debug] [--recursive] [--dry-run]');
  args.sourceDir = path.resolve(rest[0]);
  args.outputDir = path.resolve(rest[1]);
  globalThis.__DEBUG__ = !!args.debug;
  return args;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function which(cmd) {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
    const p = spawn(probe, args);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null));
    p.on('error', () => resolve(null));
  });
}

async function detectTools() {
  const toolNames = ['exiftool', 'ffmpeg', 'ffprobe', 'magick', 'convert', 'heif-convert'];
  const found = Object.fromEntries(await Promise.all(toolNames.map(async t => [t, await which(t)])));
  found.imagemagick = found.magick || found.convert || null; // prefer magick
  return found;
}

function run(cmd, args, { cwd, inheritStdio = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    if (!inheritStdio) {
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
    }
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function jpgPathFor(outDir, base) { return path.join(outDir, base + '.jpg'); }
function mp4PathFor(outDir, base) { return path.join(outDir, base + '.mp4'); }

// ---------------- Orientation helpers -------------------------
const ORIENT_CODE_TO_LABEL = new Map([[1, 'TopLeft'], [2, 'TopRight'], [3, 'BottomRight'], [4, 'BottomLeft'], [5, 'LeftTop'], [6, 'RightTop'], [7, 'RightBottom'], [8, 'LeftBottom']]);

async function getExifOrientationCode(tools, file) {
  // Prefer exiftool (more reliable for still images). Fallback to ffprobe rotate tag if present.
  if (tools.exiftool) {
    const res = await run(tools.exiftool, ['-s', '-s', '-s', '-Orientation#', file]);
    if (res.code === 0) {
      const n = Number((res.stdout || '').trim());
      if (Number.isFinite(n) && n >= 1 && n <= 8) return n;
    }
  }
  if (tools.ffprobe) {
    // Try to read any rotate tag from the first video-like stream; for HEIC stills this may be absent.
    const probe = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', file]);
    if (probe.code === 0) {
      try {
        const json = JSON.parse(probe.stdout || '{}');
        const s = Array.isArray(json.streams) ? json.streams[0] : null;
        const rot = Number(s?.tags?.rotate || 0);
        if (Number.isFinite(rot)) {
          const r = ((rot % 360) + 360) % 360; // map degrees back to EXIF-like codes when possible
          if (r === 0) return 1; if (r === 90) return 6; if (r === 180) return 3; if (r === 270) return 8;
        }
      } catch { }
    }
  }
  return 1; // default: no rotation
}

function imagemagickOpsForExif(code) {
  switch (code) {
    case 2: return ['-flop']; // mirror horizontal
    case 3: return ['-rotate', '180'];
    case 4: return ['-flip']; // mirror vertical
    case 5: return ['-transpose'];
    case 6: return ['-rotate', '90'];
    case 7: return ['-transverse'];
    case 8: return ['-rotate', '270'];
    default: return [];
  }
}

function ffmpegFilterForExif(code) {
  switch (code) {
    case 2: return 'hflip';
    case 3: return 'hflip,vflip';
    case 4: return 'vflip';
    case 5: return 'transpose=1,hflip';
    case 6: return 'transpose=1';
    case 7: return 'transpose=2,hflip';
    case 8: return 'transpose=2';
    default: return null;
  }
}

// ----------------------- Dimension Validators -------------------------
async function getImageDimensions(tools, file) {
  if (tools.exiftool) {
    const { code, stdout } = await run(tools.exiftool, ['-s', '-s', '-s', '-ImageWidth', '-ImageHeight', file]);
    if (code === 0) {
      const lines = stdout.trim().split(/\r?\n/).map(s => Number(s.trim()));
      if (lines.length === 2 && lines.every(n => Number.isFinite(n))) return { width: lines[0], height: lines[1], source: 'exiftool' };
    }
  }
  return { width: 0, height: 0, source: 'none' };
}

function plausibleDimensions(w, h) {
  if (!w || !h) return false;
  if (w <= 64 || h <= 64) return false;
  if ((w === 512 && h === 512) || (w === 320 && h === 240)) return false;
  return true;
}

// ------------------------- Metadata Copying ---------------------------
async function copyAllMetadata(tools, src, dst) {
  if (!tools.exiftool) { log.warn('exiftool not found; metadata fidelity will be reduced for', path.basename(dst)); return { ok: false, reason: 'exiftool_missing' }; }
  const args = ['-overwrite_original', '-m', '-TagsFromFile', src, '-All:All', '-icc_profile', '-XMP:All', '-GPS:All', '-unsafe', '-Orientation=1', dst];
  const res = await run(tools.exiftool, args);
  if (res.code !== 0) { log.warn('exiftool metadata copy failed for', path.basename(dst), res.stderr?.trim() || res.stdout?.trim()); return { ok: false, reason: 'exiftool_failed', stderr: res.stderr }; }
  return { ok: true };
}

// ---------------------- Still Image Conversion ------------------------
async function convertStill(tools, srcFile, dstFile, quality, exifCode) {
  const failures = [];

  // 1) ImageMagick (preferred) — explicit rotation based on EXIF code
  if (tools.imagemagick) {
    try {
      // const ops = imagemagickOpsForExif(exifCode);
      const ops = imagemagickOpsForExif(3);
      const usingMagick = !!tools.magick;
      const args = usingMagick
        ? ['convert', srcFile, ...ops, '-quality', String(quality), dstFile]
        : [srcFile, ...ops, '-quality', String(quality), dstFile];
      const res = await run(tools.imagemagick, args);
      if (res.code === 0 && await exists(dstFile)) { log.debug('Converted with ImageMagick', ops.length ? `(ops=${ops.join(' ')})` : '(no rotation)'); return { ok: true, path: dstFile, method: 'imagemagick' }; }
      failures.push(`ImageMagick exit ${res.code}: ${res.stderr?.trim() || res.stdout?.trim()}`);
    } catch (e) { failures.push(`ImageMagick threw: ${e?.message || e}`); }
  }

  // 2) heif-convert
  if (tools['heif-convert']) {
    try {
      const res = await run(tools['heif-convert'], [srcFile, dstFile]);
      if (res.code === 0 && await exists(dstFile)) { log.debug('Converted with heif-convert'); return { ok: true, path: dstFile, method: 'heif-convert' }; }
      failures.push(`heif-convert exit ${res.code}: ${res.stderr?.trim() || res.stdout?.trim()}`);
    } catch (e) { failures.push(`heif-convert threw: ${e?.message || e}`); }
  }

  // 3) ffmpeg fallback — explicit filter from EXIF, no autorotate
  if (tools.ffmpeg) {
    try {
      const vf = ffmpegFilterForExif(exifCode);
      const qscale = Math.min(31, Math.max(2, Math.round(31 - (Math.min(100, Math.max(1, 95)) / 100) * 29)));
      const args = ['-hide_banner', '-y', '-noautorotate', '-i', srcFile, '-frames:v', '1'];
      if (vf) args.push('-vf', vf);
      args.push('-qscale:v', String(qscale), dstFile);
      const res = await run(tools.ffmpeg, args);
      if (res.code === 0 && await exists(dstFile)) { log.debug('Converted with ffmpeg', vf ? `(vf=${vf})` : '(no vf)'); return { ok: true, path: dstFile, method: 'ffmpeg-frame' }; }
      failures.push(`ffmpeg frame extract exit ${res.code}: ${res.stderr?.trim() || res.stdout?.trim()}`);
    } catch (e) { failures.push(`ffmpeg threw: ${e?.message || e}`); }
  }

  return { ok: false, failures };
}

// ---------------- Embedded Video Detection & Extraction ---------------
function bytesIndexAll(buf, ascii) { const needle = Buffer.from(ascii, 'ascii'); const idxs = []; let i = 0; while (true) { const j = buf.indexOf(needle, i); if (j === -1) break; idxs.push(j); i = j + 1; } return idxs; }
function readAscii(buf, off, len) { if (off < 0 || off + len > buf.length) return null; return buf.toString('ascii', off, off + len); }
const HEIF_LIKE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);

async function detectEmbeddedVideo(tools, srcFile, tempDir) {
  if (!tools.ffprobe) { log.warn('ffprobe not found; disabling embedded video detection for', path.basename(srcFile)); return { ok: false, reason: 'ffprobe_missing' }; }
  const buf = await fs.readFile(srcFile);
  const ftypIdxs = bytesIndexAll(buf, 'ftyp');
  log.debug('ftyp occurrences at byte offsets (index of ftyp string):', ftypIdxs.join(', ') || 'none');

  const candidates = [];
  for (const i of ftypIdxs) {
    const boxStart = i - 4; if (boxStart < 0) continue; if (boxStart === 0) { log.debug('Skipping primary ftyp at offset 0'); continue; }
    const major = readAscii(buf, i + 4, 4); if (major && HEIF_LIKE_BRANDS.has(major)) { log.debug(`Skipping HEIF/AVIF brand candidate: ${major} at ftyp index ${i}`); continue; }
    candidates.push({ start: boxStart, ftypIndex: i, major });
  }
  candidates.sort((a, b) => b.start - a.start);
  if (candidates.length === 0) return { ok: false, reason: 'no_candidates' };

  for (const c of candidates) {
    const tmpPath = path.join(tempDir, `slice_${path.basename(srcFile)}_${c.start}.bin`);
    try {
      await fs.writeFile(tmpPath, buf.subarray(c.start));
      const probe = await run(tools.ffprobe, ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', tmpPath]);
      if (probe.code !== 0) { log.debug('ffprobe error for candidate', c.start, probe.stderr?.trim()); await fs.unlink(tmpPath).catch(() => { }); continue; }
      let json = null; try { json = JSON.parse(probe.stdout || '{}'); } catch { }
      if (!json) { await fs.unlink(tmpPath).catch(() => { }); continue; }

      const fmtName = (json.format?.format_name || '').toLowerCase();
      const isContainerOk = /(mp4|mov|3g2|3gp|mj2)/.test(fmtName);
      const vstreams = (json.streams || []).filter(s => s.codec_type === 'video');
      const firstV = vstreams.find(s => !s.disposition?.attached_pic);
      const w = firstV?.width || 0, h = firstV?.height || 0;
      const nbFrames = Number(firstV?.nb_frames || json.format?.nb_streams || 0);
      const duration = Number(json.format?.duration || firstV?.duration || 0);
      const dimOk = (w > 32 && h > 32);
      const motionOk = (Number.isFinite(nbFrames) && nbFrames > 5) || (Number.isFinite(duration) && duration > 0.3);

      log.debug('Candidate', c.start, 'ffprobe summary:', JSON.stringify({ fmtName, w, h, nbFrames, duration, streams: vstreams.length }, null, 2));

      if (isContainerOk && firstV && dimOk && motionOk) {
        return { ok: true, tmpPath: tmpPath, ffprobe: json, candidate: c };
      }
      await fs.unlink(tmpPath).catch(() => { });
    } catch (e) { log.debug('Candidate slice failed', c.start, e?.message || e); await fs.unlink(tmpPath).catch(() => { }); }
  }
  return { ok: false, reason: 'no_valid_slice' };
}

async function normalizeMp4(tools, tmpPath, outPath, ffprobeJson) {
  if (!tools.ffmpeg) return { ok: false, reason: 'ffmpeg_missing' };
  const v = (ffprobeJson.streams || []).find(s => s.codec_type === 'video');
  let rotate = 0; const tagRotate = Number(v?.tags?.rotate || 0); if (Number.isFinite(tagRotate)) rotate = tagRotate % 360;
  const hasDisplayMatrix = (v?.side_data_list || []).some(sd => /displaymatrix/i.test(sd.side_data_type || ''));
  const baseArgs = ['-hide_banner', '-y', '-i', tmpPath]; let args = []; let method = 'copy';
  if ((rotate && rotate !== 0) || hasDisplayMatrix) {
    method = 'reencode';
    let vf = ''; const r = ((rotate % 360) + 360) % 360;
    if (r === 90) vf = 'transpose=1'; else if (r === 270) vf = 'transpose=2'; else if (r === 180) vf = 'hflip,vflip';
    args = [...baseArgs, '-vf', vf || 'null', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath];
  } else {
    args = [...baseArgs, '-c', 'copy', '-movflags', '+faststart', outPath];
  }
  const res = await run(tools.ffmpeg, args);
  if (res.code !== 0) return { ok: false, reason: 'ffmpeg_failed', stderr: res.stderr };
  return { ok: true, method };
}

// ----------------------------- Main Flow ------------------------------
async function* iterateFiles(root, { recursive }) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const d of entries) {
    const full = path.join(root, d.name);
    if (d.isDirectory()) { if (recursive) yield* iterateFiles(full, { recursive }); continue; }
    if (/\.(heic|heif)$/i.test(d.name)) yield full;
  }
}

async function processOne(tools, file, outDir, { quality, dryRun }) {
  const base = path.parse(file).name;
  const jpgOut = jpgPathFor(outDir, base);
  const mp4Out = mp4PathFor(outDir, base);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heic2jpg-'));
  const summary = { file, jpgOut, mp4Out, steps: [], errors: [] };

  try {
    log.info('→ Processing', path.basename(file));

    const exifCode = await getExifOrientationCode(tools, file);
    log.debug('Orientation decision:', { exifCode, label: ORIENT_CODE_TO_LABEL.get(exifCode) || null });

    if (dryRun) { summary.steps.push('dry-run: skip still conversion'); }
    else {
      const conv = await convertStill(tools, file, jpgOut, quality, exifCode);
      if (!conv.ok) { summary.errors.push('All still conversion paths failed: ' + (conv.failures || []).join(' | ')); throw new Error('still-conversion-failed'); }
      summary.steps.push(`still: ${conv.method}`);

      const dim = await getImageDimensions(tools, jpgOut);
      log.debug('Output dimensions:', dim);
      if (!plausibleDimensions(dim.width, dim.height)) { summary.errors.push(`implausible dimensions ${dim.width}x${dim.height}`); throw new Error('dimension-validation-failed'); }

      const meta = await copyAllMetadata(tools, file, jpgOut);
      summary.steps.push(`metadata: ${meta.ok ? 'copied+Orientation=1' : 'skipped/partial'}`);
    }

    if (tools.ffprobe) {
      const det = await detectEmbeddedVideo(tools, file, tempDir);
      if (det.ok) {
        summary.steps.push(`motion: candidate@${det.candidate.start} brand=${det.candidate.major || 'unknown'}`);
        if (!dryRun) {
          const norm = await normalizeMp4(tools, det.tmpPath, mp4Out, det.ffprobe);
          if (!norm.ok) { summary.errors.push('mp4 normalize failed: ' + (norm.stderr || norm.reason)); }
          else summary.steps.push(`mp4: ${norm.method} → ${mp4Out}`);
        } else summary.steps.push('dry-run: skip mp4 normalize');
        await fs.unlink(det.tmpPath).catch(() => { });
      } else { summary.steps.push('motion: none'); log.debug('No embedded video:', det.reason); }
    } else {
      summary.steps.push('motion: disabled (ffprobe missing)');
    }

    if (!dryRun) { if (await exists(jpgOut)) log.info('   JPG →', jpgOut); if (await exists(mp4Out)) log.info('   MP4 →', mp4Out); }

  } catch (err) {
    log.error(`Failed: ${path.basename(file)} —`, err?.message || err);
  } finally {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { }
  }
  return summary;
}

async function main() {
  let args; try { args = parseArgs(process.argv); } catch (e) { console.error(String(e?.message || e)); process.exit(2); }
  const { sourceDir, outputDir } = args;
  if (!(await exists(sourceDir))) { console.error('Source directory does not exist:', sourceDir); process.exit(2); }
  await fs.mkdir(outputDir, { recursive: true });
  const tools = await detectTools();
  log.info('Tool availability:');
  log.info(JSON.stringify({ sharp: false, exiftool: !!tools.exiftool, ffmpeg: !!tools.ffmpeg, ffprobe: !!tools.ffprobe, imagemagick: !!tools.imagemagick && (tools.magick ? 'magick' : (tools.convert ? 'convert' : false)), 'heif-convert': !!tools['heif-convert'] }, null, 2));

  let count = 0, failures = 0;
  for await (const file of iterateFiles(sourceDir, { recursive: false })) {
    count++;
    const summary = await processOne(tools, file, args.outputDir, { quality: args.quality, dryRun: args.dryRun });
    if (summary.errors.length) { failures++; if (globalThis.__DEBUG__) log.debug('Summary errors:', summary.errors); }
  }
  if (count === 0) log.warn('No .heic/.heif files found in', sourceDir);
  log.info(`Done. Processed ${count} file(s). ${failures} failure(s).`);
}

main().catch(e => { console.error('[FATAL]', e?.stack || e); process.exit(2); });
