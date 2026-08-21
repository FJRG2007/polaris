/**
 * Getting pixels out of a stream, and a picture back out of pixels.
 *
 * Everything here is ffmpeg, and everything here reads the relay rather than a
 * camera - the relay holds the one connection to the camera and re-serves it,
 * which is the rule the whole of Places is built on.
 *
 * Three shapes are needed and no more:
 *
 *   - How big the picture is, asked once when a camera starts being watched.
 *     Without it there is no way to put a detected box back where it came from.
 *   - A run of small grey frames, which is the movement watcher and the only
 *     thing that runs continuously.
 *   - A run of square colour frames in the model's own convention, opened only
 *     while something is happening and closed the moment it stops.
 *
 * And one thing back the other way: a JPEG made from a frame already in memory,
 * so the picture kept for an event is exactly the frame the detector liked best
 * and costs no second look at the camera.
 */

import { LETTERBOX_FILL } from "@polaris/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** The grey ffmpeg fills the empty part of the model's square with, written the
 *  way ffmpeg wants it. Taken from the decoder's own constant rather than
 *  repeated as a hex string: the model was trained against that exact value, so
 *  it is part of the input format, and the two must never drift apart. */
const LETTERBOX_COLOR = `0x${LETTERBOX_FILL.toString(16).repeat(3)}`;

export interface StreamSource {
    readonly url: string;
    /** What the relay wants to see, already built. */
    readonly authorization: string;
}

function ffmpegInput(source: StreamSource): string[] {
    return ["-headers", `Authorization: ${source.authorization}\r\n`, "-i", source.url];
}

/**
 * How big the camera's picture is.
 *
 * Asked with ffprobe rather than parsed out of ffmpeg's chatter, because the
 * chatter is a log format and this is a number every box downstream is divided
 * by. Null when the stream would not answer, which the caller reads as "watch
 * it for movement and do not try to detect anything in it" - a wrong guess here
 * would put every box in the wrong place, and no boxes beats wrong ones.
 */
export function probeSize(
    source: StreamSource,
    timeoutMs = 15_000
): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
        const child = spawn(
            "ffprobe",
            [
                "-v",
                "error",
                "-headers",
                `Authorization: ${source.authorization}\r\n`,
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                source.url
            ],
            { windowsHide: true }
        );
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => {
            text += chunk.toString();
        });
        child.stderr.resume();
        const done = (value: { width: number; height: number } | null) => {
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            done(null);
        }, timeoutMs);
        timer.unref();
        child.on("error", () => done(null));
        child.on("close", () => {
            const [width, height] = text.trim().split("\n")[0]?.split("x").map(Number) ?? [];
            done(
                Number.isInteger(width) && Number.isInteger(height) && width! > 0 && height! > 0
                    ? { width: width!, height: height! }
                    : null
            );
        });
    });
}

/** A run of fixed-size frames off one ffmpeg, handed over one at a time. */
export interface FrameStream {
    readonly process: ChildProcessWithoutNullStreams;
    /** Called with each whole frame, in arrival order. */
    onFrame(handler: (frame: Uint8Array) => void): void;
    onClosed(handler: (code: number | null) => void): void;
    stop(): void;
}

/**
 * Cut a byte stream into frames.
 *
 * ffmpeg writes raw frames back to back with nothing between them, so the only
 * thing that says where one ends is that they are all the same size. Bytes are
 * gathered until there are enough for a frame, and what is left over is the
 * start of the next one.
 */
function framed(child: ChildProcessWithoutNullStreams, frameBytes: number): FrameStream {
    let handler: ((frame: Uint8Array) => void) | null = null;
    let closed: ((code: number | null) => void) | null = null;
    let pending = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        while (pending.length >= frameBytes) {
            const frame = pending.subarray(0, frameBytes);
            pending = pending.subarray(frameBytes);
            // Copied, because the buffer above is a view onto bytes that are
            // about to be reused.
            handler?.(new Uint8Array(frame));
        }
    });
    // ffmpeg is chatty on stderr even when it is fine; a death is what matters
    // and the reconciler is what acts on it.
    child.stderr.resume();
    child.on("close", (code) => closed?.(code));
    child.on("error", () => closed?.(null));

    return {
        process: child,
        onFrame(next) {
            handler = next;
        },
        onClosed(next) {
            closed = next;
        },
        stop() {
            handler = null;
            child.kill("SIGKILL");
        }
    };
}

/**
 * The movement watcher's frames: small, grey, and a couple a second.
 *
 * The size is the cheapest thing that still shows a person crossing a garden.
 * The aspect ratio is kept rather than squared off, so an area drawn on the
 * picture lines up with the pixels it was drawn over.
 */
export function openMotionFrames(
    source: StreamSource,
    width: number,
    height: number,
    fps: number
): FrameStream {
    const child = spawn(
        "ffmpeg",
        [
            ...ffmpegInput(source),
            "-an",
            "-vf",
            `fps=${fps},scale=${width}:${height},format=gray`,
            "-f",
            "rawvideo",
            "-"
        ],
        { windowsHide: true }
    );
    return framed(child, width * height);
}

/** How a frame is fitted into the model's square, as ffmpeg is told to do it.
 *  The picture keeps its shape, is scaled by one factor, and sits in the
 *  top-left corner - which is what makes putting a box back a division rather
 *  than a division and a subtraction. */
export function letterboxFilter(sourceWidth: number, sourceHeight: number, size: number): string {
    const scale = Math.min(size / sourceWidth, size / sourceHeight);
    const width = Math.trunc(sourceWidth * scale);
    const height = Math.trunc(sourceHeight * scale);
    return `scale=${width}:${height},pad=${size}:${size}:0:0:color=${LETTERBOX_COLOR}`;
}

/**
 * The detector's frames, in the model's own convention.
 *
 * Opened when something starts happening and closed when it stops, which is
 * what keeps a house of cameras affordable: this is a second connection to the
 * relay and a full decode, and it runs seconds a day rather than continuously.
 */
export function openDetectFrames(
    source: StreamSource,
    sourceWidth: number,
    sourceHeight: number,
    size: number,
    fps: number
): FrameStream {
    const child = spawn(
        "ffmpeg",
        [
            ...ffmpegInput(source),
            "-an",
            "-vf",
            `fps=${fps},${letterboxFilter(sourceWidth, sourceHeight, size)}`,
            "-pix_fmt",
            "bgr24",
            "-f",
            "rawvideo",
            "-"
        ],
        { windowsHide: true }
    );
    return framed(child, size * size * 3);
}

/**
 * Turn a frame already in memory into a JPEG.
 *
 * No camera is touched: the bytes came off a stream that is already open, and
 * this is ffmpeg reading them back off a pipe. That is what lets the picture
 * kept for an event be the exact frame the detector liked best, rather than
 * whatever the camera happened to be showing by the time somebody asked for one.
 *
 * The crop takes the letterbox padding back off, and can be narrowed further to
 * cut one thing out of the picture - which is how a face is sent to the
 * recognizer without sending the whole garden with it.
 */
export function encodeJpeg(
    frame: Uint8Array,
    size: number,
    crop: { x: number; y: number; width: number; height: number },
    timeoutMs = 10_000
): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const width = Math.max(2, Math.round(crop.width));
        const height = Math.max(2, Math.round(crop.height));
        const child = spawn(
            "ffmpeg",
            [
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgr24",
                "-s",
                `${size}x${size}`,
                "-i",
                "-",
                "-vf",
                `crop=${width}:${height}:${Math.max(0, Math.round(crop.x))}:${Math.max(0, Math.round(crop.y))}`,
                "-frames:v",
                "1",
                "-f",
                "mjpeg",
                "-"
            ],
            { windowsHide: true }
        );
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr.resume();
        const done = (value: Buffer | null) => {
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            done(null);
        }, timeoutMs);
        timer.unref();
        child.on("error", () => done(null));
        child.on("close", () => done(chunks.length > 0 ? Buffer.concat(chunks) : null));
        child.stdin.on("error", () => undefined);
        child.stdin.end(frame);
    });
}
