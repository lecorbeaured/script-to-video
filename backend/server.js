require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json({ limit: '2mb' }));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_VIDEO_MODEL || 'google/veo-3.1-lite';

if (!OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY is not set. Set it in your environment / Railway variables.');
}

const OR_BASE = 'https://openrouter.ai/api/v1';

function orHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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
    const index = req.query.index || '0';

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

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// Add a burned-in text overlay to a completed video
app.post('/api/overlay/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { text, position = 'bottom', fontSize = 48 } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const workDir = os.tmpdir();
  const uid = crypto.randomBytes(6).toString('hex');
  const srcPath = path.join(workDir, `${jobId}-${uid}-src.mp4`);
  const outPath = path.join(workDir, `${jobId}-${uid}-out.mp4`);

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

    const drawtext = [
      `fontfile=${FONT_PATH}`,
      `text='${escapeDrawtext(text.trim())}'`,
      `fontsize=${fontSize}`,
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

    // 4. Stream result back, then clean up
    res.set('Content-Type', 'video/mp4');
    const readStream = fs.createReadStream(outPath);
    readStream.pipe(res);
    readStream.on('close', () => {
      fs.unlink(srcPath, () => {});
      fs.unlink(outPath, () => {});
    });
  } catch (err) {
    console.error('overlay error:', err);
    fs.unlink(srcPath, () => {});
    fs.unlink(outPath, () => {});
    res.status(500).json({ error: err.message || 'Failed to add text overlay' });
  }
});

// Poll job status
app.get('/api/status/:jobId', async (req, res) => {

  try {
    const { jobId } = req.params;
    const r = await fetch(`${OR_BASE}/videos/${jobId}`, { headers: orHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    console.error('status error:', err);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Script-to-video backend listening on port ${PORT}`);
});
