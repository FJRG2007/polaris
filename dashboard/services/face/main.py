"""
The recognizer Home installs for itself.

Face recognition used to mean going away, reading somebody else's project, running
a five-container stack by hand and pasting an address back into Polaris. This is
that stack replaced by one container Home can install on its own, on the machine
the owner picked, with a key nobody types.

It speaks the CompreFace dialect on purpose. Home was written against those
paths, and a house that already runs CompreFace should be able to keep it - so
the address field stays, and this is simply what the button installs.

What it holds is the thing worth being careful about. A face template is
biometric data, it never leaves this container, and Polaris never sees one: the
database here keeps a name and a vector, the photograph itself is thrown away
after the vector is taken, and removing somebody removes both.
"""

import os
import uuid
import sqlite3
import secrets
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

# The key is minted by the install and presented on every call. Refusing to start
# without one is deliberate: a recognizer that comes up open on somebody's home
# network is a face database anybody on that network can read and write.
API_KEY = os.environ.get("FACE_API_KEY", "").strip()
if not API_KEY:
    raise SystemExit("FACE_API_KEY is required: this service holds face data and will not run unauthenticated.")

# A volume, so the people a house has taught it survive a redeploy.
DATA_DIR = os.environ.get("FACE_DATA_DIR", "/data")

# Enough for a photograph from a phone, and small enough that a bad request
# cannot exhaust the machine.
MAX_UPLOAD_BYTES = 12 * 1024 * 1024

# A name is a label on an event, not a document.
MAX_SUBJECT_LENGTH = 120

analyzer = None

def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(os.path.join(DATA_DIR, "faces.db"))
    connection.row_factory = sqlite3.Row
    return connection

def migrate() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS face (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # Every read is either "everything for this subject" or "everything", and
        # forgetting somebody is by subject.
        connection.execute("CREATE INDEX IF NOT EXISTS face_subject ON face (subject)")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load the models before the port opens.

    They are a few seconds and a few hundred megabytes, and paying that here means
    the first face of the night is answered at the speed of every other one rather
    than timing out while something downloads.
    """
    global analyzer
    from uniface import FaceAnalyzer

    migrate()
    analyzer = FaceAnalyzer()
    yield

app = FastAPI(title="Polaris face recognition", lifespan=lifespan)

@app.exception_handler(HTTPException)
async def refusal(_request, exc: HTTPException) -> JSONResponse:
    """Say what went wrong in the shape the caller reads.

    Home shows this text to whoever is standing at the screen, so "no face is
    visible in that photograph" has to survive the trip - a generic failure is
    something nobody can act on.
    """
    return JSONResponse({"message": exc.detail}, status_code=exc.status_code)

def authorize(x_api_key: str = Header(default="")) -> None:
    # Compared in constant time: the key is a bearer credential to a face
    # database, and a comparison that returns early leaks it a byte at a time.
    if not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Wrong key")

Guarded = Depends(authorize)

def clean_subject(subject: str) -> str:
    trimmed = " ".join(subject.split())
    if not trimmed:
        raise HTTPException(status_code=400, detail="A face has to belong to somebody: give a subject")
    if len(trimmed) > MAX_SUBJECT_LENGTH:
        raise HTTPException(status_code=400, detail="That name is too long")
    return trimmed

async def decode(upload: UploadFile) -> np.ndarray:
    """The uploaded bytes as an image, or a refusal that says which it was.

    Read with a cap rather than whole: this is the one endpoint that takes a file
    from outside, and the size is not known until it has been read.
    """
    raw = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That photograph is too large")
    if not raw:
        raise HTTPException(status_code=400, detail="No file was sent")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="That file is not an image this can read")
    return image

def look(image: np.ndarray) -> list:
    """Every face in one picture, largest first.

    Largest is nearly always nearest, and nearest is nearly always the subject -
    which is what makes "the one that matters" a defensible default for the
    endpoints that want a single face.
    """
    faces = analyzer.analyze(image)
    return sorted(faces, key=lambda face: area(face.bbox), reverse=True)

def area(bbox: np.ndarray) -> float:
    return float(max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1]))

def box_of(face) -> dict:
    bbox = face.bbox
    return {
        "probability": round(float(face.confidence), 4),
        "x_min": int(bbox[0]),
        "y_min": int(bbox[1]),
        "x_max": int(bbox[2]),
        "y_max": int(bbox[3])
    }

def unit(embedding: np.ndarray) -> np.ndarray:
    """The embedding at length one, so comparing two of them is one dot product.

    Normalized on the way in rather than on every comparison: a house asks this
    question far more often than it teaches a new face.
    """
    vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        raise HTTPException(status_code=400, detail="That photograph did not produce a usable face")
    return vector / norm

def known() -> tuple[list[str], np.ndarray]:
    """Everybody taught so far, as one matrix.

    A household is tens of faces, so this is read per request rather than cached.
    A cache here would buy microseconds and cost the bug where somebody removed an
    hour ago is still recognized.
    """
    with connect() as connection:
        rows = connection.execute("SELECT subject, embedding FROM face").fetchall()
    if not rows:
        return [], np.zeros((0, 0), dtype=np.float32)
    subjects = [row["subject"] for row in rows]
    matrix = np.vstack([np.frombuffer(row["embedding"], dtype=np.float32) for row in rows])
    return subjects, matrix

@app.get("/healthz")
async def healthz() -> dict:
    """Whether the models are loaded. No key: this is what a deploy polls, and it
    says nothing about who is in the database."""
    return {"status": "ok" if analyzer is not None else "starting"}

@app.post("/api/v1/recognition/faces")
async def add_face(
    subject: str = Query(...),
    file: UploadFile = File(...),
    _: None = Guarded
) -> dict:
    """Teach it somebody.

    One face per photograph, and it refuses rather than guesses when there are
    several. Enrolling the wrong person is not a mistake that shows up until the
    night it matters, and by then the photograph is long gone.
    """
    name = clean_subject(subject)
    faces = look(await decode(file))
    if not faces:
        raise HTTPException(status_code=400, detail="No face is visible in the file provided")
    if len(faces) > 1:
        raise HTTPException(
            status_code=400,
            detail="There is more than one face in that photograph, so it is not clear who to learn"
        )
    if faces[0].embedding is None:
        raise HTTPException(status_code=400, detail="That face is too small or too turned away to learn")

    image_id = str(uuid.uuid4())
    with connect() as connection:
        connection.execute(
            "INSERT INTO face (id, subject, embedding) VALUES (?, ?, ?)",
            (image_id, name, unit(faces[0].embedding).tobytes())
        )
    return {"image_id": image_id, "subject": name}

@app.get("/api/v1/recognition/faces")
async def list_faces(size: int = Query(default=1000, ge=1, le=10_000), _: None = Guarded) -> dict:
    with connect() as connection:
        rows = connection.execute(
            "SELECT id, subject FROM face ORDER BY created_at ASC LIMIT ?", (size,)
        ).fetchall()
    return {"faces": [{"image_id": row["id"], "subject": row["subject"]} for row in rows]}

@app.delete("/api/v1/recognition/subjects/{subject}")
async def forget(subject: str, _: None = Guarded) -> dict:
    name = clean_subject(subject)
    with connect() as connection:
        removed = connection.execute("DELETE FROM face WHERE subject = ?", (name,)).rowcount
    if removed == 0:
        raise HTTPException(status_code=404, detail="Nobody by that name was taught")
    return {"subject": name, "deleted": removed}

@app.post("/api/v1/recognition/recognize")
async def recognize(
    file: UploadFile = File(...),
    limit: int = Query(default=1, ge=1, le=20),
    prediction_count: int = Query(default=1, ge=1, le=20),
    _: None = Guarded
) -> dict:
    """Who is in this frame.

    Similarity is the cosine between two unit vectors, reported the way the caller
    expects it: nought to one, higher is more certain. Negative similarity is a
    face that is nothing like the stored one, and it is reported as nought rather
    than as a negative number nobody can put a threshold on.
    """
    faces = look(await decode(file))[:limit]
    subjects, matrix = known()

    result = []
    for face in faces:
        matches = []
        if face.embedding is not None and matrix.size:
            scores = matrix @ unit(face.embedding)
            # Somebody taught from several photographs has several rows, and the
            # best of them is how well that person matches - not the average,
            # which a single bad photograph would drag down forever.
            best: dict[str, float] = {}
            for name, score in zip(subjects, scores):
                value = max(0.0, float(score))
                if value > best.get(name, -1.0):
                    best[name] = value
            matches = [
                {"subject": name, "similarity": round(value, 4)}
                for name, value in sorted(best.items(), key=lambda item: item[1], reverse=True)
            ][:prediction_count]
        result.append({"box": box_of(face), "subjects": matches})
    return {"result": result}

@app.post("/api/v1/detection/detect")
async def detect(
    file: UploadFile = File(...),
    limit: int = Query(default=1, ge=1, le=20),
    _: None = Guarded
) -> dict:
    """Whether there is a face at all, which for a house is the practical answer
    to whether there is a person."""
    faces = look(await decode(file))[:limit]
    return {"result": [{"box": box_of(face)} for face in faces]}
