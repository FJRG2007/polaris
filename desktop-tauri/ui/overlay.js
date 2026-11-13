// The see-through window over a shared display (`desktop/src/renderer/overlay.ts`):
// draws the strokes the call hands it and fades each a few seconds after its
// last point, the way the room's screens do. The app has already checked each
// stroke's shape (`polaris_client::annotate::read_stroke`); the board's limits
// are those of `desktop/src/shared/annotate.ts`.
const { listen } = window.__TAURI__.event;

/** How long a stroke stays after its last point, and how long it fades. The
 *  same as the call's, so the sharer sees what the room sees. */
const HOLD_MS = 3_000;
const FADE_MS = 1_000;
const POINTS_PER_STROKE = 2_048;
const STROKES_MAX = 200;

const canvas = document.getElementById("board");
const board = new Map();
let frame = 0;

/** Add a stroke's points to what is shown, starting it if it is new. */
function addShown(stroke, now) {
    const held = board.get(stroke.key);
    if (held) {
        held.points.push(...stroke.points.slice(0, Math.max(0, POINTS_PER_STROKE - held.points.length)));
        held.last = now;
        return;
    }
    board.set(stroke.key, { color: stroke.color, points: [...stroke.points], last: now });
    while (board.size > STROKES_MAX) {
        const oldest = board.keys().next().value;
        if (oldest === undefined) break;
        board.delete(oldest);
    }
}

/** How visible a stroke is now: whole while held, then fading to none. */
function shownAlpha(stroke, now) {
    const age = now - stroke.last;
    return age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
}

function paint() {
    frame = 0;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(3, Math.min(width, height) / 220);
    const now = Date.now();
    for (const [key, stroke] of board) {
        const alpha = shownAlpha(stroke, now);
        if (alpha <= 0) {
            board.delete(key);
            continue;
        }
        context.globalAlpha = alpha;
        context.strokeStyle = stroke.color;
        context.beginPath();
        stroke.points.forEach(([x, y], index) => {
            if (index === 0) context.moveTo(x * width, y * height);
            else context.lineTo(x * width, y * height);
        });
        // A tap is a dot: a line to where it started draws nothing.
        const [first] = stroke.points;
        if (stroke.points.length === 1 && first) context.lineTo(first[0] * width + 0.1, first[1] * height);
        context.stroke();
    }
    if (board.size > 0) frame = requestAnimationFrame(paint);
}

listen("polaris://overlay-stroke", (event) => {
    addShown(event.payload, Date.now());
    if (!frame) frame = requestAnimationFrame(paint);
});
