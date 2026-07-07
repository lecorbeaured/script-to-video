# Script to Video

Text box → OpenRouter video generation (Veo 3.1, Seedance, Wan, etc.) → playable video.

## Backend (Railway)

1. Push `backend/` as its own repo or subfolder.
2. In Railway: New Project → Deploy from GitHub → point at `backend/`.
3. Set environment variables:
   - `OPENROUTER_API_KEY` — your OpenRouter key
   - `ALLOWED_ORIGIN` — your Vercel frontend URL (e.g. `https://script-to-video.vercel.app`), or `*` while testing
   - `DEFAULT_VIDEO_MODEL` — optional, defaults to `google/veo-3.1-lite`
4. Railway auto-detects `npm start`. Note the generated public URL (e.g. `https://script-to-video-backend.up.railway.app`).

## Frontend (Vercel)

1. Deploy `frontend/` as a static site (no build step needed — it's plain HTML/JS).
2. Once live, open the site, expand "Backend URL" below the button, and paste your Railway backend URL. It's saved in the browser via localStorage so you only set it once per device.

## Notes

- Default model is `google/veo-3.1-lite` — cheapest per-second option, good for testing.
- Clips are capped at whatever the chosen model supports (Veo 3.1 family: 4-8 sec). This is single-clip generation only, no scene-splitting or stitching.
- Video generation is async: submit → poll → download. The backend exposes `/api/generate` (submit) and `/api/status/:jobId` (poll), matching OpenRouter's job pattern.
- `GET /api/models` on the backend proxies OpenRouter's model list if you want to see live pricing/capabilities.
