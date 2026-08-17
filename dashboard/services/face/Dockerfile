# The Polaris face recognizer.
#
# One container, which is the entire point of it existing: the alternative Home
# used to point people at is a five-container stack with its own database, run by
# hand, and installing that from a button was never going to be a button that
# worked. This is SCRFD for finding faces and ArcFace for telling them apart, the
# smallest variants of each, on the CPU.
#
# The weights are baked in rather than fetched on first use. A recognizer that
# downloads a few hundred megabytes the first time somebody walks past a camera
# is a recognizer that misses that person, and one on a house network with no way
# out never works at all.
FROM python:3.12-slim-bookworm

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UNIFACE_CACHE_DIR=/models \
    FACE_DATA_DIR=/data

# opencv is a hard dependency of the analysis library and wants a couple of
# system libraries even when nothing is ever drawn on screen.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY services/face/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Loading the analyzer once at build time is what pulls the weights down and
# checks them; the layer is then part of the image.
RUN python -c "from uniface import FaceAnalyzer; FaceAnalyzer()" && \
    chmod -R a+rX /models

COPY services/face/main.py ./

# Faces belong to a volume, so the people a house taught survive a redeploy.
RUN mkdir -p /data && useradd --system --uid 10001 recognizer && chown recognizer /data /app
VOLUME ["/data"]

# Nothing here needs root, and it holds the most sensitive data in the house.
USER recognizer
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
