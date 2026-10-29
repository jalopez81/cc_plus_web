#!/usr/bin/env bash
# start.sh — instala, configura CUDA/cuDNN y arranca el servidor
set -e
cd "$(dirname "$0")"

# Caché de modelos en /workspace (sobrevive a Stop si usas volumen)
export HF_HOME=/workspace/hf_cache
# En Vast se instala como root a propósito; el aviso de pip no aporta nada.
export PIP_ROOT_USER_ACTION=ignore

echo ">>> Instalando dependencias..."
pip install -q fastapi "uvicorn[standard]" websockets faster-whisper av transformers sentencepiece protobuf sacremoses nvidia-ml-py
# Si torch ya trae cuBLAS/cuDNN compatibles, pip no los toca
pip install -q "ctranslate2==4.6.0" nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
# Convertir el modelo de traducción a CTranslate2 necesita torch; basta la versión CPU, mucho más ligera.
python -c "import torch" 2>/dev/null || pip install -q torch --index-url https://download.pytorch.org/whl/cpu

# Hacer visibles las librerías CUDA 12 / cuDNN 9 instaladas por pip
NV_LIBS=$(python - <<'EOF'
import glob, site
dirs = set()
for r in site.getsitepackages():
    dirs.update(glob.glob(f"{r}/nvidia/*/lib"))
print(":".join(sorted(dirs)))
EOF
)
export LD_LIBRARY_PATH="$NV_LIBS:${LD_LIBRARY_PATH}"

echo ">>> Arrancando servidor..."
python -u server.py 2>&1 | tee server.log
