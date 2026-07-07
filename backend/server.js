require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

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
