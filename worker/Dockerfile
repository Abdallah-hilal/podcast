FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg is used both as the composite renderer and (via a subprocess) as the
# audio pre-decoder that bypasses faster-whisper's PyAV incompatibility.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py .

# Cache dir for faster-whisper model downloads survives container restarts
# when /root/.cache/huggingface is a named volume (see docker-compose.yml).
ENV HF_HOME=/root/.cache/huggingface

CMD ["python", "-u", "main.py"]
