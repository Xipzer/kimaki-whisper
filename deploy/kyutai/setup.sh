#!/usr/bin/env bash
# One-time setup of the Kyutai STT+TTS server venv (CUDA). Re-runnable.
#   deploy/kyutai/setup.sh            # creates ~/kyutai-server/.venv, downloads models on first start
set -euo pipefail
DIR="$HOME/kyutai-server"
mkdir -p "$DIR"
command -v uv >/dev/null || { echo "uv missing: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
[ -d "$DIR/.venv" ] || uv venv -q --python 3.12 "$DIR/.venv"
source "$DIR/.venv/bin/activate"
uv pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install -q "moshi==0.2.13" websockets numpy sphn julius huggingface_hub
python -c "import torch,moshi;print('torch',torch.__version__,'cuda',torch.cuda.is_available(),'moshi',moshi.__version__)"
echo "ok. start with: deploy/kyutai/run.sh   (or enable the systemd unit, see docs/OPERATIONS.md)"
