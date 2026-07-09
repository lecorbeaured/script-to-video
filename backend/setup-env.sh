#!/bin/zsh
railway variables --set "OPENROUTER_API_KEY=sk-or-your-key-here"
railway variables --set "ALLOWED_ORIGIN=*"
railway variables --set "DEFAULT_VIDEO_MODEL=google/veo-3.1-lite"
railway variables --set "API_KEY=$(openssl rand -hex 32)"
