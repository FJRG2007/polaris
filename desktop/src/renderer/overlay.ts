/**
 * The see-through window over a shared display: draws the strokes the call
 * hands it and fades each a few seconds after its last point, the way the
 * room's screens do.
 */

import { byId } from "./dom";
import { addShown, shownAlpha, strokeSchema, type ShownStroke } from "@/shared/annotate";

const canvas = byId<HTMLCanvasElement>("board");
const board = new Map<string, ShownStroke>();
let frame = 0;

function paint(): void {
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

window.polarisLocal.overlay.onStroke((raw) => {
    const stroke = strokeSchema.safeParse(raw);
    if (!stroke.success) return;
    addShown(board, stroke.data, Date.now());
    if (!frame) frame = requestAnimationFrame(paint);
});
