#!/usr/bin/env bash
# Run the Kyutai STT+TTS server in the foreground (models load ~60 s, ~6 GB VRAM).
#   TTS_VOICE=expresso/ex04-ex02_happy_001_channel1_118s.wav PORT=8010 deploy/kyutai/run.sh
cd "$(dirname "$0")"
export PORT="${PORT:-8010}"
exec "$HOME/kyutai-server/.venv/bin/python" server.py
