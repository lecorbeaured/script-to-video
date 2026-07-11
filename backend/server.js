require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const sharp = require('sharp');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB cap, for user-uploaded video

const app = express();
app.use(express.json({ limit: '2mb' }));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_VIDEO_MODEL || 'google/veo-3.1-lite';
const DEFAULT_TEXT_MODEL = process.env.DEFAULT_TEXT_MODEL || 'deepseek/deepseek-chat';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // default: Rachel
const API_KEY = process.env.API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY is not set. Set it in your environment / Railway variables.');
}
if (!ELEVENLABS_API_KEY) {
  console.warn('WARNING: ELEVENLABS_API_KEY is not set. Story Mode voiceover will fail without it.');
}
if (!API_KEY) {
  console.warn('WARNING: API_KEY is not set. Every request will be rejected with 401 until you set API_KEY in your environment / Railway variables.');
}

// Story jobs, uploaded music, and overlay results live here instead of os.tmpdir() so they can
// survive a restart — but that only actually happens if DATA_DIR points at a mounted Railway
// Volume (Railway's default filesystem is wiped on every redeploy, same as os.tmpdir()).
const DATA_DIR = process.env.DATA_DIR || os.tmpdir();
if (!process.env.DATA_DIR) {
  console.warn('WARNING: DATA_DIR is not set — using the ephemeral default temp dir. Story jobs and uploaded files will NOT survive a restart/redeploy. Attach a Railway Volume and set DATA_DIR to its mount path for durability.');
}
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const WORK_DIR = path.join(DATA_DIR, 'work');
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// Every route except /api/health spends OpenRouter/ElevenLabs credit, so require a shared
// secret. Accepted via the x-api-key header (used by JS fetch calls) or a ?key= query param
// (needed for the <video> tag, which can't attach custom headers).
function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const provided = req.get('x-api-key') || req.query.key || '';
  if (!API_KEY || !provided || !timingSafeEqualStrings(String(provided), API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// jobId always comes from the client and gets used both in an outbound OpenRouter URL and in
// local temp file paths — validate its shape before touching either.
const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;

const OR_BASE = 'https://openrouter.ai/api/v1';

function orHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Call an LLM via OpenRouter (used for prompt expansion + story beat-splitting)
async function chatCompletion(systemPrompt, userPrompt, model = DEFAULT_TEXT_MODEL) {
  const r = await fetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error?.message || JSON.stringify(data.error) || 'LLM call failed');
  }
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Generate narration audio via ElevenLabs, returns a Buffer of mp3 bytes
async function elevenLabsTTS(text, voiceId) {
  const resolvedVoiceId = voiceId || ELEVENLABS_VOICE_ID; // falsy (incl. '') falls back to default
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs TTS failed: ${errText}`);
  }
  return r.buffer();
}

// Submit a video job to OpenRouter and poll until it's done, downloading the result to a local temp file.
// Returns the local file path.
async function generateVideoAndWait(prompt, opts, tempPath, maxAttempts = 60) {
  const body = {
    model: opts.model || DEFAULT_MODEL,
    prompt,
    aspect_ratio: opts.aspectRatio || '9:16',
    resolution: opts.resolution || '720p',
    generate_audio: false, // story mode supplies its own narration audio
  };

  const submitRes = await fetch(`${OR_BASE}/videos`, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify(body),
  });
  const submitData = await submitRes.json();
  if (!submitRes.ok) {
    throw new Error(submitData.error?.message || JSON.stringify(submitData.error) || 'Video submit failed');
  }
  const jobId = submitData.id;
  if (!jobId) throw new Error('No job ID returned for video generation');

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(`${OR_BASE}/videos/${jobId}`, { headers: orHeaders() });
    const statusData = await statusRes.json();
    if (!statusRes.ok) throw new Error(statusData.error?.message || 'Status check failed');

    if (statusData.status === 'completed' || statusData.status === 'succeeded') {
      const contentRes = await fetch(`${OR_BASE}/videos/${jobId}/content?index=0`, {
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      });
      if (!contentRes.ok) throw new Error('Failed to download completed video');
      const buffer = await contentRes.buffer();
      fs.writeFileSync(tempPath, buffer);
      return tempPath;
    }
    if (statusData.status === 'failed' || statusData.status === 'error') {
      console.error('OpenRouter video generation failed, full response:', JSON.stringify(statusData));
      throw new Error(statusData.error?.message || statusData.error?.reason || JSON.stringify(statusData.error) || 'Video generation failed');
    }
  }
  throw new Error('Timed out waiting for video generation');
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Upload a background music track (mp3) for use in Story Mode
const musicFiles = {}; // musicId -> { path, uploadedAt }
app.post('/api/music/upload', upload.single('music'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No music file uploaded' });
  }
  const musicId = crypto.randomBytes(8).toString('hex');
  const destPath = path.join(WORK_DIR, `music-${musicId}.mp3`);
  fs.renameSync(req.file.path, destPath);
  musicFiles[musicId] = { path: destPath, uploadedAt: Date.now() };
  res.json({ musicId });
});

// List available video models (resolutions, pricing, aspect ratios)
app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OR_BASE}/videos/models`, { headers: orHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    console.error('models error:', err);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// List available ElevenLabs voices for the voice picker
app.get('/api/voices', async (req, res) => {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('ElevenLabs voices error:', data);
      return res.status(r.status).json({ error: data.detail?.message || 'Failed to fetch voices' });
    }
    // Trim to just what the picker needs
    const voices = (data.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name }));
    res.json({ voices });
  } catch (err) {
    console.error('voices error:', err);
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
});

// Submit a text-to-video generation job
app.post('/api/generate', async (req, res) => {
  try {
    const {
      script,
      model = DEFAULT_MODEL,
      aspectRatio = '9:16',
      resolution = '720p',
      duration,
      generateAudio = true,
    } = req.body;

    if (!script || !script.trim()) {
      return res.status(400).json({ error: 'script text is required' });
    }

    const body = {
      model,
      prompt: script.trim(),
      aspect_ratio: aspectRatio,
      resolution,
      generate_audio: generateAudio,
    };
    if (duration) body.duration = duration;

    const r = await fetch(`${OR_BASE}/videos`, {
      method: 'POST',
      headers: orHeaders(),
      body: JSON.stringify(body),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('OpenRouter generate error:', data);
      return res.status(r.status).json({ error: data.error || data });
    }

    // data should include an id / job status per OpenRouter's async job schema
    res.json(data);
  } catch (err) {
    console.error('generate error:', err);
    res.status(500).json({ error: 'Failed to submit video generation job' });
  }
});

// Proxy video content — the browser can't attach the OpenRouter auth header itself,
// so we fetch it here (with auth) and stream it straight through.
app.get('/api/video/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!JOB_ID_RE.test(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const index = req.query.index || '0';
    if (!/^\d+$/.test(index)) return res.status(400).json({ error: 'Invalid index' });

    const upstream = await fetch(
      `${OR_BASE}/videos/${jobId}/content?index=${index}`,
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('video proxy error:', upstream.status, errText);
      return res.status(upstream.status).send(errText);
    }

    res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('video proxy error:', err);
    res.status(500).json({ error: 'Failed to proxy video content' });
  }
});

// Escape special characters for ffmpeg's drawtext filter
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

// CSS-style family names for the image caption tool (rendered via sharp/librsvg, which resolves
// families through the system's font stack — safe without needing exact file paths).
const FONT_FAMILIES = { sans: 'DejaVu Sans', serif: 'DejaVu Serif', display: 'Oswald' };
const FONT_CSS_FALLBACK = { sans: 'sans-serif', serif: 'serif', display: 'sans-serif' };

// Exact file paths for the video overlay tool. ffmpeg's drawtext filter only resolves family
// names (font=) when built with libfontconfig, which isn't guaranteed — fontfile= (needs only
// libfreetype) is what's proven to work here, so we point straight at a file. These are best
// guesses at where each apt package (fonts-dejavu-core, fonts-oswald) installs its .ttf — if a
// guess is wrong, getFontFile() below falls back to asking fontconfig directly.
const FONT_FILES = {
  sans: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  serif: '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
  display: '/usr/share/fonts/truetype/oswald/Oswald-Bold.ttf',
};

const fontFileCache = {};

// Fallback for when our hardcoded guess in FONT_FILES doesn't match the file a given apt
// package version actually installed — asks fontconfig (fc-match) to resolve the family
// by name instead, which is authoritative regardless of exact filename/version.
function resolveFontFileViaFontconfig(family) {
  if (family in fontFileCache) return fontFileCache[family];
  let resolved = null;
  try {
    const out = execFileSync('fc-match', ['-f', '%{file}', `${family}:bold`], { encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) resolved = out;
  } catch (err) {
    console.error(`fc-match lookup failed for "${family}":`, err.message);
  }
  fontFileCache[family] = resolved;
  return resolved;
}

function getFontFile(fontKey) {
  const guess = FONT_FILES[fontKey];
  if (!guess) return null;
  if (fs.existsSync(guess)) return guess;
  return resolveFontFileViaFontconfig(FONT_FAMILIES[fontKey]);
}

const overlayResults = {}; // overlayId -> { path, createdAt }

// Add a burned-in text overlay to a completed video
app.post('/api/overlay/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { text, position = 'bottom', fontSize = 48, font = 'sans' } = req.body;

  if (!JOB_ID_RE.test(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const parsedFontSize = Number(fontSize);
  if (!Number.isFinite(parsedFontSize) || parsedFontSize < 10 || parsedFontSize > 300) {
    return res.status(400).json({ error: 'fontSize must be a number between 10 and 300' });
  }
  if (!FONT_FILES[font]) {
    return res.status(400).json({ error: `font must be one of: ${Object.keys(FONT_FILES).join(', ')}` });
  }
  const fontFile = getFontFile(font);
  if (!fontFile) {
    console.error(`Could not resolve a font file for "${font}" — checked ${FONT_FILES[font]} and fc-match for "${FONT_FAMILIES[font]}"`);
    return res.status(500).json({ error: `Font "${font}" is not installed on the server` });
  }

  const uid = crypto.randomBytes(6).toString('hex');
  // Source pull is ephemeral (deleted right after use) so it can stay in tmpdir; the rendered
  // result is what /api/overlay/result/:overlayId serves later, so it needs to survive a restart.
  const srcPath = path.join(os.tmpdir(), `${jobId}-${uid}-src.mp4`);
  const outPath = path.join(WORK_DIR, `${jobId}-${uid}-out.mp4`);

  try {
    // 1. Pull the source video from OpenRouter (auth attached server-side)
    const upstream = await fetch(`${OR_BASE}/videos/${jobId}/content?index=0`, {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: errText });
    }
    const buffer = await upstream.buffer();
    fs.writeFileSync(srcPath, buffer);

    // 2. Work out text position
    let yExpr = 'h-150'; // bottom
    if (position === 'top') yExpr = '50';
    if (position === 'center') yExpr = '(h-text_h)/2';

    const drawtext = 'drawtext=' + [
      `fontfile='${escapeDrawtext(fontFile)}'`,
      `text='${escapeDrawtext(text.trim())}'`,
      `fontsize=${parsedFontSize}`,
      `fontcolor=white`,
      `x=(w-text_w)/2`,
      `y=${yExpr}`,
      `box=1`,
      `boxcolor=black@0.5`,
      `boxborderw=12`,
    ].join(':');

    // 3. Run ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(srcPath)
        .videoFilters(drawtext)
        .outputOptions(['-c:a copy'])
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });

    // 4. Keep the result around (like story videos) so the client can reference it by a stable
    // URL that still works after a page refresh, instead of a one-shot stream.
    const overlayId = crypto.randomBytes(8).toString('hex');
    overlayResults[overlayId] = { path: outPath, createdAt: Date.now() };
    fs.unlink(srcPath, () => {});
    res.json({ overlayId });
  } catch (err) {
    console.error('overlay error:', err);
    fs.unlink(srcPath, () => {});
    fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message || 'Failed to add text overlay' });
  }
});

app.get('/api/overlay/result/:overlayId', (req, res) => {
  const { overlayId } = req.params;
  if (!JOB_ID_RE.test(overlayId)) return res.status(400).json({ error: 'Invalid overlay ID' });
  const entry = overlayResults[overlayId];
  if (!entry || !fs.existsSync(entry.path)) {
    return res.status(404).json({ error: 'Overlay result not found (it may have expired)' });
  }
  res.set('Content-Type', 'video/mp4');
  fs.createReadStream(entry.path).pipe(res);
});

// ── Voiceover: apply ElevenLabs narration to a user-uploaded video ──
// Same result-by-id pattern as overlayResults: render once, persist to WORK_DIR, hand back an
// id so the client gets a stable URL (works with <video src>, survives a page refresh) instead
// of a one-shot stream.
const voiceoverResults = {}; // voiceoverId -> { path, createdAt }

app.post('/api/voiceover/apply', videoUpload.single('video'), async (req, res) => {
  const { narration, voiceId, musicId } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'video file is required' });
  }
  if (!narration || !narration.trim()) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'narration is required' });
  }

  const uid = crypto.randomBytes(6).toString('hex');
  const audioPath = path.join(os.tmpdir(), `voiceover-${uid}.mp3`);
  const outPath = path.join(WORK_DIR, `voiceover-${uid}-out.mp4`);

  let musicWarning = null;
  const musicPath = musicId ? musicFiles[musicId]?.path : null;
  if (musicId && !musicPath) {
    console.warn(`Music requested (musicId=${musicId}) but file not found — likely lost to a server restart/redeploy since upload. Skipping music.`);
    musicWarning = 'Background music was uploaded but could not be found (the server may have restarted between upload and generation) — video was created without music.';
  }

  try {
    const audioBuffer = await elevenLabsTTS(narration.trim(), voiceId);
    fs.writeFileSync(audioPath, audioBuffer);

    // Original audio is dropped entirely — the voiceover replaces it, trimmed/padded to
    // whichever of video or narration is shorter (same -shortest pattern Story Mode uses).
    // If background music was supplied, mix it in under the voiceover (looped, reduced volume)
    // rather than mapping the voiceover track directly.
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(req.file.path).input(audioPath);
      if (musicPath && fs.existsSync(musicPath)) {
        cmd
          .input(musicPath)
          .complexFilter([
            '[2:a]aloop=loop=-1:size=2e9,volume=0.15[bg]',
            '[1:a][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]',
          ])
          .outputOptions(['-map 0:v:0', '-map [aout]', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest']);
      } else {
        cmd.outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest']);
      }
      cmd.on('error', reject).on('end', resolve).save(outPath);
    });

    if (musicPath) {
      fs.unlink(musicPath, () => {});
      delete musicFiles[musicId];
    }

    const voiceoverId = crypto.randomBytes(8).toString('hex');
    voiceoverResults[voiceoverId] = { path: outPath, createdAt: Date.now() };
    res.json({ voiceoverId, musicWarning });
  } catch (err) {
    console.error('voiceover apply error:', err);
    fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message || 'Failed to apply voiceover' });
  } finally {
    fs.unlink(req.file.path, () => {});
    fs.unlink(audioPath, () => {});
  }
});

app.get('/api/voiceover/result/:voiceoverId', (req, res) => {
  const { voiceoverId } = req.params;
  if (!JOB_ID_RE.test(voiceoverId)) return res.status(400).json({ error: 'Invalid voiceover ID' });
  const entry = voiceoverResults[voiceoverId];
  if (!entry || !fs.existsSync(entry.path)) {
    return res.status(404).json({ error: 'Voiceover result not found (it may have expired)' });
  }
  res.set('Content-Type', 'video/mp4');
  fs.createReadStream(entry.path).pipe(res);
});

// Poll job status
app.get('/api/status/:jobId', async (req, res) => {

  try {
    const { jobId } = req.params;
    if (!JOB_ID_RE.test(jobId)) return res.status(400).json({ error: 'Invalid job ID' });
    const r = await fetch(`${OR_BASE}/videos/${jobId}`, { headers: orHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    console.error('status error:', err);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});

// ── Image Generator ──
app.post('/api/image/generate', async (req, res) => {
  try {
    const { prompt, model = 'bytedance-seed/seedream-4.5', aspectRatio = '1:1', resolution } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const body = { model, prompt: prompt.trim(), aspect_ratio: aspectRatio };
    if (resolution) body.resolution = resolution;

    const r = await fetch(`${OR_BASE}/images`, {
      method: 'POST',
      headers: orHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();

    if (!r.ok) {
      console.error('OpenRouter image generate error:', JSON.stringify(data));
      return res.status(r.status).json({ error: data.error?.message || JSON.stringify(data.error) || 'Image generation failed' });
    }

    // Response shape: images returned as base64. Normalize whichever field the model used.
    const imageBase64 = data.data?.[0]?.b64_json || data.images?.[0]?.b64_json || data.images?.[0];
    if (!imageBase64) {
      console.error('Unexpected image response shape:', JSON.stringify(data));
      return res.status(500).json({ error: 'No image data in response' });
    }

    res.json({ imageBase64, mimeType: 'image/png' });
  } catch (err) {
    console.error('image generate error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate image' });
  }
});

// Burn a text caption onto a base64 image using sharp (SVG text overlay composited on top)
app.post('/api/image/caption', async (req, res) => {
  try {
    const { imageBase64, caption, position = 'bottom', fontSize = 42, font = 'sans' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
    if (!caption || !caption.trim()) return res.status(400).json({ error: 'caption is required' });
    const parsedFontSize = Number(fontSize);
    if (!Number.isFinite(parsedFontSize) || parsedFontSize < 10 || parsedFontSize > 300) {
      return res.status(400).json({ error: 'fontSize must be a number between 10 and 300' });
    }
    const fontFamily = FONT_FAMILIES[font];
    if (!fontFamily) {
      return res.status(400).json({ error: `font must be one of: ${Object.keys(FONT_FAMILIES).join(', ')}` });
    }

    const inputBuffer = Buffer.from(imageBase64, 'base64');
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    const width = metadata.width || 1024;
    const height = metadata.height || 1024;

    // Simple word-wrap: break caption into lines that roughly fit the image width
    const maxCharsPerLine = Math.max(10, Math.floor(width / (parsedFontSize * 0.55)));
    const words = caption.trim().split(/\s+/);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (candidate.length > maxCharsPerLine && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineHeight = parsedFontSize * 1.3;
    const bandHeight = lines.length * lineHeight + parsedFontSize * 0.8;
    const bandY = position === 'top' ? 0 : height - bandHeight;

    const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const svgFontFamily = `${fontFamily}, ${FONT_CSS_FALLBACK[font]}`;

    const textElements = lines
      .map((line, i) => {
        const y = bandY + parsedFontSize * 0.9 + i * lineHeight;
        return `<text x="50%" y="${y}" font-family="${escapeXml(svgFontFamily)}" font-size="${parsedFontSize}" font-weight="bold" fill="white" text-anchor="middle" stroke="black" stroke-width="${parsedFontSize * 0.06}" paint-order="stroke">${escapeXml(line)}</text>`;
      })
      .join('\n');

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="${bandY}" width="${width}" height="${bandHeight}" fill="black" fill-opacity="0.35" />
        ${textElements}
      </svg>
    `;

    const outputBuffer = await image
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();

    res.json({ imageBase64: outputBuffer.toString('base64'), mimeType: 'image/png' });
  } catch (err) {
    console.error('image caption error:', err);
    res.status(500).json({ error: err.message || 'Failed to add caption' });
  }
});

// ── Prompt Expander ──
// Turn a raw topic into a single well-formed 8-second cinematic prompt
app.post('/api/prompt/expand', async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: 'topic is required' });
    }

    const systemPrompt = `You are a cinematic prompt writer for AI video generation models limited to 8 seconds of footage. Given a topic, write ONE single vivid cinematic prompt following this formula: [Subject] + [single action] + [setting] + [lighting/mood] + [camera behavior] + [style]. It must describe ONE beat only, not a sequence of events.

IMPORTANT: Never name or identify a real, real-world public figure (celebrities, athletes, politicians, historical figures, etc.) in the prompt — video generation models reject and fail on these. Instead describe the person generically by role or archetype (e.g. "a champion boxer" instead of "Mike Tyson", "a tech founder" instead of a named CEO, "a rock star" instead of a named musician). This applies even if the topic names a real person — translate them into a generic descriptor in the visual prompt.

Also, to avoid content-filter false positives on realistic human depictions (a known issue with Veo and similar models): prefer medium/wide shots over tight close-ups on a human face, and don't stack an age word (e.g. "young", "teenage") directly against a gendered noun/pronoun ("she", "her", "a young woman") — describe the person by role or action instead (e.g. "an astronaut" rather than "a young astronaut... she..."). This is a precaution against filter rejections, not a restriction on the story itself.

Output ONLY the prompt text, nothing else — no quotes, no preamble, no labels.`;

    const prompt = await chatCompletion(systemPrompt, topic.trim());
    res.json({ prompt });
  } catch (err) {
    console.error('prompt expand error:', err);
    res.status(500).json({ error: err.message || 'Failed to expand prompt' });
  }
});

// ── Story Mode: Step 1 — split a narration into 8-second beats + matching visual prompts ──
app.post('/api/story/beats', async (req, res) => {
  try {
    const { narration } = req.body;
    if (!narration || !narration.trim()) {
      return res.status(400).json({ error: 'narration is required' });
    }

    const systemPrompt = `You split a narration script into beats for an 8-second-per-clip AI video generator. Each beat's narration should be roughly 15-20 words (about 8 seconds of spoken audio at a natural pace). For each beat, also write ONE single vivid cinematic visual prompt (formula: [Subject] + [single action] + [setting] + [lighting/mood] + [camera behavior] + [style]) that matches what's being narrated at that moment — one beat only, not a sequence.

IMPORTANT: The "narration" field can name real people freely (that's spoken audio, not sent to the video model). But the "visualPrompt" field must NEVER name or identify a real, real-world public figure (celebrities, athletes, politicians, historical figures, etc.) — video generation models reject and fail on these. Instead describe the person generically by role or archetype in the visual prompt (e.g. "a champion boxer" instead of "Mike Tyson", "a tech founder" instead of a named CEO). Translate any named real person from the narration into a generic descriptor for the visual prompt only.

Also, in the "visualPrompt" field only, avoid patterns that trigger content-filter false positives on realistic human depictions (a known issue with Veo and similar models): prefer medium/wide shots over tight close-ups on a human face, and don't stack an age word (e.g. "young", "teenage") directly against a gendered noun/pronoun ("she", "her", "a young woman") — describe the person by role or action instead. This is a precaution against filter rejections, not a restriction on the narration or story itself.

Output STRICTLY a JSON array, nothing else, no markdown code fences, no preamble. Format:
[{"narration": "...", "visualPrompt": "..."}, ...]`;

    const raw = await chatCompletion(systemPrompt, narration.trim());
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    let beats;
    try {
      beats = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse beats JSON:', cleaned);
      throw new Error('Could not parse story beats from the model response');
    }
    res.json({ beats });
  } catch (err) {
    console.error('story beats error:', err);
    res.status(500).json({ error: err.message || 'Failed to split narration into beats' });
  }
});

// ── Story Mode: Step 2 — generate all beats (video + voiceover), mux, and stitch ──
// storyJobs is in-memory for fast access, but every meaningful change is also written to
// JOBS_DIR so resumeInterruptedStoryJobs() (see bottom of file) can pick a job back up if the
// process restarts mid-generation instead of leaving it to 404 forever.
const storyJobs = {}; // storyId -> { status, beats: [{narration, visualPrompt, status}], finalPath, error, createdAt, model, aspectRatio, resolution, voiceId, musicId, musicWarning }

function storyJobPath(storyId) {
  return path.join(JOBS_DIR, `story-${storyId}.json`);
}

function saveStoryJobState(storyId) {
  const job = storyJobs[storyId];
  if (!job) return;
  try {
    fs.writeFileSync(storyJobPath(storyId), JSON.stringify(job));
  } catch (err) {
    console.error(`Failed to persist story job ${storyId}:`, err.message);
  }
}

function deleteStoryJobState(storyId) {
  fs.unlink(storyJobPath(storyId), () => {});
}

app.post('/api/story/generate', async (req, res) => {
  const { beats, model, aspectRatio, resolution, voiceId, musicId } = req.body;

  if (!Array.isArray(beats) || !beats.length) {
    return res.status(400).json({ error: 'beats array is required' });
  }

  const storyId = crypto.randomBytes(8).toString('hex');
  storyJobs[storyId] = {
    status: 'processing',
    beats: beats.map((b) => ({ narration: b.narration, visualPrompt: b.visualPrompt, status: 'pending' })),
    finalPath: null,
    error: null,
    createdAt: Date.now(),
    model,
    aspectRatio,
    resolution,
    voiceId,
    musicId,
    musicWarning: null,
  };
  saveStoryJobState(storyId);

  res.json({ storyId });

  // Process in the background — the response above already returned the storyId
  runStoryGeneration(storyId).catch((err) => {
    console.error(`Unhandled error running story ${storyId}:`, err);
  });
});

// Runs (or resumes) a story job entirely from what's stored in storyJobs[storyId] / on disk, so
// it can be called both for a fresh request and for a job recovered after a restart. Beats that
// already have a finished file on disk (from before an interruption) are skipped instead of
// being regenerated.
async function runStoryGeneration(storyId) {
  const job = storyJobs[storyId];
  const { beats, model, aspectRatio, resolution, voiceId, musicId } = job;
  const beatFinalPaths = [];

  try {
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const finalBeatPath = path.join(WORK_DIR, `${storyId}-beat${i}-final.mp4`);

      if (job.beats[i].status === 'done' && fs.existsSync(finalBeatPath)) {
        // Already completed before an interruption — reuse it instead of regenerating.
        beatFinalPaths.push(finalBeatPath);
        continue;
      }

      try {
        job.beats[i].status = 'generating video';
        saveStoryJobState(storyId);

        const videoPath = path.join(WORK_DIR, `${storyId}-beat${i}-video.mp4`);
        await generateVideoAndWait(beat.visualPrompt, { model, aspectRatio, resolution }, videoPath);

        job.beats[i].status = 'generating voiceover';
        saveStoryJobState(storyId);
        const audioBuffer = await elevenLabsTTS(beat.narration, voiceId);
        const audioPath = path.join(WORK_DIR, `${storyId}-beat${i}-audio.mp3`);
        fs.writeFileSync(audioPath, audioBuffer);

        job.beats[i].status = 'muxing';
        saveStoryJobState(storyId);
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest'])
            .on('error', reject)
            .on('end', resolve)
            .save(finalBeatPath);
        });

        beatFinalPaths.push(finalBeatPath);
        job.beats[i].status = 'done';
        saveStoryJobState(storyId);

        fs.unlink(videoPath, () => {});
        fs.unlink(audioPath, () => {});
      } catch (beatErr) {
        // Tag the beat number onto the error so it survives into the top-level catch below —
        // otherwise a failure just says e.g. "content may have been filtered" with no way to
        // tell which of several beats/prompts actually caused it.
        job.beats[i].status = 'error';
        saveStoryJobState(storyId);
        throw new Error(`Beat ${i + 1}: ${beatErr.message}`);
      }
    }

    // Concatenate all beats into one final video
    const listPath = path.join(WORK_DIR, `${storyId}-concat-list.txt`);
    const listContent = beatFinalPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const concatPath = path.join(WORK_DIR, `${storyId}-concat.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .on('error', reject)
        .on('end', resolve)
        .save(concatPath);
    });

    let finalPath = concatPath;

    // Mix in background music if one was uploaded for this story
    const musicPath = musicId ? musicFiles[musicId]?.path : null;
    if (musicId && !musicPath) {
      console.warn(`Music requested (musicId=${musicId}) but file not found — likely lost to a server restart/redeploy since upload. Skipping music.`);
      job.musicWarning = 'Background music was uploaded but could not be found when generating (the server may have restarted between upload and generation) — video was created without music.';
    }
    if (musicPath && fs.existsSync(musicPath)) {
      const withMusicPath = path.join(WORK_DIR, `${storyId}-final.mp4`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatPath)
          .input(musicPath)
          .complexFilter([
            '[1:a]aloop=loop=-1:size=2e9,volume=0.15[bg]',
            '[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]',
          ])
          .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-b:a 192k'])
          .on('error', reject)
          .on('end', resolve)
          .save(withMusicPath);
      });
      finalPath = withMusicPath;
      fs.unlink(concatPath, () => {});
      fs.unlink(musicPath, () => {});
      delete musicFiles[musicId];
    }

    job.status = 'done';
    job.finalPath = finalPath;
    saveStoryJobState(storyId);

    beatFinalPaths.forEach((p) => fs.unlink(p, () => {}));
    fs.unlink(listPath, () => {});
  } catch (err) {
    console.error('story generate error:', err);
    job.status = 'error';
    job.error = err.message || 'Story generation failed';
    saveStoryJobState(storyId);
  }
}

app.get('/api/story/status/:storyId', (req, res) => {
  const job = storyJobs[req.params.storyId];
  if (!job) return res.status(404).json({ error: 'Story job not found' });
  res.json({ status: job.status, beats: job.beats, error: job.error, musicWarning: job.musicWarning || null });
});

app.get('/api/story/video/:storyId', (req, res) => {
  const job = storyJobs[req.params.storyId];
  if (!job || job.status !== 'done' || !job.finalPath) {
    return res.status(404).json({ error: 'Story video not ready' });
  }
  res.set('Content-Type', 'video/mp4');
  fs.createReadStream(job.finalPath).pipe(res);
});

// storyJobs, musicFiles, overlayResults, and voiceoverResults are in-memory and never otherwise
// pruned — sweep out anything stale so long-running deployments don't leak temp files or grow forever.
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function cleanupStaleJobs() {
  const now = Date.now();

  for (const [storyId, job] of Object.entries(storyJobs)) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.finalPath) fs.unlink(job.finalPath, () => {});
      delete storyJobs[storyId];
      deleteStoryJobState(storyId);
    }
  }

  for (const [musicId, entry] of Object.entries(musicFiles)) {
    if (now - entry.uploadedAt > JOB_TTL_MS) {
      fs.unlink(entry.path, () => {});
      delete musicFiles[musicId];
    }
  }

  for (const [overlayId, entry] of Object.entries(overlayResults)) {
    if (now - entry.createdAt > JOB_TTL_MS) {
      fs.unlink(entry.path, () => {});
      delete overlayResults[overlayId];
    }
  }

  for (const [voiceoverId, entry] of Object.entries(voiceoverResults)) {
    if (now - entry.createdAt > JOB_TTL_MS) {
      fs.unlink(entry.path, () => {});
      delete voiceoverResults[voiceoverId];
    }
  }
}

setInterval(cleanupStaleJobs, 30 * 60 * 1000); // sweep every 30 min

// On boot, pick back up any story job that was still 'processing' when the process died (a
// redeploy, crash, etc.) — a job only ever sits in 'processing' while actively running, so
// finding one in that state here means the run was interrupted, not that it's still going
// somewhere else. Jobs already 'done' or 'error' are left alone.
function resumeInterruptedStoryJobs() {
  let files;
  try {
    files = fs.readdirSync(JOBS_DIR);
  } catch (err) {
    console.error('Failed to scan JOBS_DIR for interrupted story jobs:', err.message);
    return;
  }

  for (const file of files) {
    if (!file.startsWith('story-') || !file.endsWith('.json')) continue;
    const storyId = file.slice('story-'.length, -'.json'.length);

    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, file), 'utf8'));
    } catch (err) {
      console.error(`Failed to read persisted story job ${file}:`, err.message);
      continue;
    }

    if (job.status !== 'processing') continue;

    console.log(`Resuming story job ${storyId} interrupted by a restart (last beat state preserved)`);
    storyJobs[storyId] = job;
    runStoryGeneration(storyId).catch((err) => {
      console.error(`Resume failed for story ${storyId}:`, err);
    });
  }
}

resumeInterruptedStoryJobs();

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Script-to-video backend listening on port ${PORT}`);
});
