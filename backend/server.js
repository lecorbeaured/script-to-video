require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

const app = express();
app.use(express.json({ limit: '2mb' }));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_VIDEO_MODEL || 'google/veo-3.1-lite';
const DEFAULT_TEXT_MODEL = process.env.DEFAULT_TEXT_MODEL || 'deepseek/deepseek-chat';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // default: Rachel

if (!OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY is not set. Set it in your environment / Railway variables.');
}
if (!ELEVENLABS_API_KEY) {
  console.warn('WARNING: ELEVENLABS_API_KEY is not set. Story Mode voiceover will fail without it.');
}

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
async function elevenLabsTTS(text, voiceId = ELEVENLABS_VOICE_ID) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
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
const musicFiles = {}; // musicId -> file path
app.post('/api/music/upload', upload.single('music'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No music file uploaded' });
  }
  const musicId = crypto.randomBytes(8).toString('hex');
  const destPath = path.join(os.tmpdir(), `music-${musicId}.mp3`);
  fs.renameSync(req.file.path, destPath);
  musicFiles[musicId] = destPath;
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

    const drawtext = 'drawtext=' + [
      `fontfile='${FONT_PATH}'`,
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
const storyJobs = {}; // in-memory job store: storyId -> { status, beats: [{status}], finalPath, error }

app.post('/api/story/generate', async (req, res) => {
  const { beats, model, aspectRatio, resolution, voiceId, musicId } = req.body;

  if (!Array.isArray(beats) || !beats.length) {
    return res.status(400).json({ error: 'beats array is required' });
  }

  const storyId = crypto.randomBytes(8).toString('hex');
  storyJobs[storyId] = {
    status: 'processing',
    beats: beats.map(() => ({ status: 'pending' })),
    finalPath: null,
    error: null,
  };

  res.json({ storyId });

  // Process in the background — the response above already returned the storyId
  (async () => {
    const workDir = os.tmpdir();
    const beatFinalPaths = [];

    try {
      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i];
        storyJobs[storyId].beats[i].status = 'generating video';

        const videoPath = path.join(workDir, `${storyId}-beat${i}-video.mp4`);
        await generateVideoAndWait(beat.visualPrompt, { model, aspectRatio, resolution }, videoPath);

        storyJobs[storyId].beats[i].status = 'generating voiceover';
        const audioBuffer = await elevenLabsTTS(beat.narration, voiceId);
        const audioPath = path.join(workDir, `${storyId}-beat${i}-audio.mp3`);
        fs.writeFileSync(audioPath, audioBuffer);

        storyJobs[storyId].beats[i].status = 'muxing';
        const finalBeatPath = path.join(workDir, `${storyId}-beat${i}-final.mp4`);
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest'])
            .on('error', reject)
            .on('end', resolve)
            .save(finalBeatPath);
        });

        beatFinalPaths.push(finalBeatPath);
        storyJobs[storyId].beats[i].status = 'done';

        fs.unlink(videoPath, () => {});
        fs.unlink(audioPath, () => {});
      }

      // Concatenate all beats into one final video
      const listPath = path.join(workDir, `${storyId}-concat-list.txt`);
      const listContent = beatFinalPaths.map((p) => `file '${p}'`).join('\n');
      fs.writeFileSync(listPath, listContent);

      const concatPath = path.join(workDir, `${storyId}-concat.mp4`);
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
      const musicPath = musicId ? musicFiles[musicId] : null;
      if (musicPath && fs.existsSync(musicPath)) {
        const withMusicPath = path.join(workDir, `${storyId}-final.mp4`);
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

      storyJobs[storyId].status = 'done';
      storyJobs[storyId].finalPath = finalPath;

      beatFinalPaths.forEach((p) => fs.unlink(p, () => {}));
      fs.unlink(listPath, () => {});
    } catch (err) {
      console.error('story generate error:', err);
      storyJobs[storyId].status = 'error';
      storyJobs[storyId].error = err.message || 'Story generation failed';
    }
  })();
});

app.get('/api/story/status/:storyId', (req, res) => {
  const job = storyJobs[req.params.storyId];
  if (!job) return res.status(404).json({ error: 'Story job not found' });
  res.json({ status: job.status, beats: job.beats, error: job.error });
});

app.get('/api/story/video/:storyId', (req, res) => {
  const job = storyJobs[req.params.storyId];
  if (!job || job.status !== 'done' || !job.finalPath) {
    return res.status(404).json({ error: 'Story video not ready' });
  }
  res.set('Content-Type', 'video/mp4');
  fs.createReadStream(job.finalPath).pipe(res);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Script-to-video backend listening on port ${PORT}`);
});
