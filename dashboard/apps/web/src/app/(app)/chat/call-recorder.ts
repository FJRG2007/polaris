"use client";

/**
 * Recording a call, in the browser of whoever pressed record.
 *
 * The obvious way to record a call is on the server: a machine joins as a
 * silent participant, mixes the room and writes a file. Every product that does
 * it that way needs a second service, a queue, a share to write into and an
 * operator to set all three up - and this is a Polaris where **the person
 * running it never opens a terminal**. A recording that only works once
 * somebody has deployed a recorder is a button that is greyed out on every
 * installation in the world.
 *
 * So it is done here. The room is already in this browser - every face, every
 * screen and everybody's voice, decoded and playing - and drawing that onto a
 * canvas and mixing it into one track is a few hundred lines with no
 * infrastructure behind it at all. What it costs is honest and worth saying
 * plainly:
 *
 * - **It is one person's view of the call.** What is recorded is what that
 *   browser could see and hear, at the moment it saw and heard it. Somebody
 *   whose picture was never subscribed to is not in the file.
 * - **It ends when they leave.** Closing the tab ends the recording, and the
 *   file is whatever had been written by then.
 * - **It costs that machine something.** A canvas being drawn and encoded is
 *   real work on top of a call.
 *
 * And the part that is not a trade-off: **everybody in the call is told.** The
 * browser recording says so in an attribute, every screen in the room draws it,
 * and it is said again to anybody who joins afterwards - see `call-peer-state`.
 * A call that can be recorded without the room knowing is not one anybody should
 * be in.
 *
 * The picture is composed rather than sent as several tracks, and the sound is
 * mixed rather than kept per person, for the same reason a screen clip is: what
 * comes out has to be a file that plays anywhere, and a video with nine tracks
 * plays one of them, chosen by the player.
 */

import * as core from "@polaris/core";
import type { CallState } from "./call-state";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordingExtension, recordingType } from "./recording-format";

/**
 * How long one may run.
 *
 * An hour, and it is a stop rather than a limit anybody should reach: the
 * recording is held whole in memory until it is stopped, so this is a ceiling on
 * what a tab is asked to hold as much as on what a meeting can be. The size
 * ceiling below is what usually ends a long one first.
 */
export const MAX_RECORDING_SECONDS = 60 * 60;

/**
 * The most it may grow to.
 *
 * The ceiling an attachment can be on any Polaris, because the point of a
 * recording is to end up in the conversation the call belongs to, and one that
 * cannot be sent there is a file somebody has to keep on a laptop. An instance
 * whose own limit is lower will refuse the upload with its own message, and the
 * panel offers the download instead - which is the only case where the two
 * numbers can disagree.
 */
export const MAX_RECORDING_BYTES = core.CHAT_ATTACHMENT_CEILING_MIB * 1024 * 1024;

/** What the recording is composed at. 720p: legible for a shared screen, and a
 *  size any machine can encode while also being in a call. */
const WIDTH = 1280;
const HEIGHT = 720;

/**
 * How often the picture is drawn.
 *
 * Twenty-four, which is enough for faces and a pointer moving over a document,
 * and half the encoding cost of forty-eight. Drawn on a timer rather than on
 * animation frames deliberately: a browser stops handing out frames to a tab
 * that is not on screen, and a call keeps running when somebody switches to
 * another tab - a recording that froze whenever they looked away would be a
 * still picture over a live conversation.
 */
const FPS = 24;

/** How often the recorder catches up with who is in the call. People arrive,
 *  leave, turn cameras on and start sharing while it runs. */
const SETTLE_MS = 1000;

/** One rectangle of the composed picture. */
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Cut a rectangle into as many roughly square tiles as there are people.
 *
 * The same arithmetic the room's own grid does, kept here rather than shared
 * with it: that one is a Tailwind column class and this one is pixels on a
 * canvas, and folding them together would make each of them worse.
 */
export function recordingTiles(count: number, area: Rect): Rect[] {
    if (count <= 0) return [];
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const width = area.width / columns;
    const height = area.height / rows;
    return Array.from({ length: count }, (_, index) => ({
        x: area.x + (index % columns) * width,
        y: area.y + Math.floor(index / columns) * height,
        width,
        height
    }));
}

/**
 * Where everything goes in the recorded picture.
 *
 * The same shape the room uses, because a recording of a call should look like
 * the call: a screen being shared takes most of the frame and the faces become a
 * strip under it, and with nothing shared the faces are an even grid.
 *
 * Pure, so the one thing here that can be wrong in a way a test can catch - a
 * tile off the edge, a strip with no height, a division by a count of zero - is
 * caught without a canvas or a call.
 */
export function recordingLayout(
    screens: number,
    faces: number,
    width = WIDTH,
    height = HEIGHT
): { stage: Rect[]; faces: Rect[] } {
    if (screens <= 0) {
        return { stage: [], faces: recordingTiles(faces, { x: 0, y: 0, width, height }) };
    }
    // A quarter of the height for the faces, which at 720p is a strip of
    // recognisable heads rather than a row of thumbnails.
    const strip = faces > 0 ? Math.round(height * 0.25) : 0;
    const stage = recordingTiles(screens, { x: 0, y: 0, width, height: height - strip });
    if (faces === 0) return { stage, faces: [] };
    const each = width / faces;
    return {
        stage,
        faces: Array.from({ length: faces }, (_, index) => ({
            x: index * each,
            y: height - strip,
            width: each,
            height: strip
        }))
    };
}

export interface CallRecording {
    /** Whether this browser is recording right now. */
    readonly running: boolean;
    /** How long it has been running, in seconds. */
    readonly seconds: number;
    /** How much has been written so far. Shown because the ceiling is real and
     *  somebody recording an hour of screen share should see it coming. */
    readonly bytes: number;
    /** The finished recording, waiting to be sent or saved. */
    readonly file: File | null;
    readonly error: string;
    /** Whether this browser can record video at all. */
    readonly supported: boolean;
    start: () => void;
    stop: () => void;
    /** Throw away what was recorded, without sending it anywhere. */
    discard: () => void;
}

/** Everything opened while a recording runs, so the cleanup can reach all of it
 *  from an effect that ran once. */
interface Machinery {
    recorder: MediaRecorder | null;
    canvas: HTMLCanvasElement | null;
    painting: ReturnType<typeof setInterval> | null;
    settling: ReturnType<typeof setInterval> | null;
    audio: AudioContext | null;
    mixed: MediaStreamAudioDestinationNode | null;
    /** One source node per slot being mixed, with the stream it was built over -
     *  so the pass that catches up with the room can tell a slot that is already
     *  connected from one whose stream has been replaced under it. */
    sources: Map<string, { stream: MediaStream; node: MediaStreamAudioSourceNode }>;
    /** One off-screen element per stream being drawn. A stream is only drawable
     *  through an element that is playing it. */
    videos: Map<string, HTMLVideoElement>;
    chunks: Blob[];
    bytes: number;
    stopping: boolean;
}

/**
 * The recorder for the call this browser is in.
 *
 * Lives beside the call rather than beside the room that draws it - see
 * `call-session` - because a call survives navigation here and a recording that
 * stopped when somebody opened another screen would be useless in exactly the
 * situation people record calls for.
 */
export function useCallRecorder(call: CallState): CallRecording {
    const [running, setRunning] = useState(false);
    const [seconds, setSeconds] = useState(0);
    const [bytes, setBytes] = useState(0);
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState("");

    /** The call as it is right now, for the timers to read. They are started
     *  once and would otherwise be composing the room as it was when record was
     *  pressed - the people in it, their cameras and their screens all change. */
    const latest = useRef(call);
    latest.current = call;

    const kit = useRef<Machinery>({
        recorder: null,
        canvas: null,
        painting: null,
        settling: null,
        audio: null,
        mixed: null,
        sources: new Map(),
        videos: new Map(),
        chunks: [],
        bytes: 0,
        stopping: false
    });

    /** Everything opened, closed. Safe to call twice. */
    const teardown = useCallback(() => {
        const parts = kit.current;
        if (parts.painting) clearInterval(parts.painting);
        if (parts.settling) clearInterval(parts.settling);
        parts.painting = null;
        parts.settling = null;
        for (const video of parts.videos.values()) {
            video.srcObject = null;
            video.remove();
        }
        parts.videos.clear();
        for (const source of parts.sources.values()) source.node.disconnect();
        parts.sources.clear();
        parts.mixed = null;
        void parts.audio?.close().catch(() => undefined);
        parts.audio = null;
        parts.recorder = null;
        parts.canvas = null;
    }, []);

    const stop = useCallback(() => {
        const parts = kit.current;
        if (!parts.recorder || parts.recorder.state === "inactive") return;
        parts.stopping = true;
        parts.recorder.stop();
    }, []);

    const start = useCallback(() => {
        const type = recordingType();
        if (!type) {
            setError("This browser cannot record video.");
            return;
        }
        const parts = kit.current;
        if (parts.recorder) return;

        setError("");
        setFile(null);
        setSeconds(0);
        setBytes(0);
        parts.chunks = [];
        parts.bytes = 0;
        parts.stopping = false;

        const canvas = document.createElement("canvas");
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const brush = canvas.getContext("2d");
        if (!brush) {
            setError("This browser cannot compose the picture.");
            return;
        }
        parts.canvas = canvas;

        const audio = new AudioContext();
        const mixed = audio.createMediaStreamDestination();
        parts.audio = audio;
        parts.mixed = mixed;

        // A context made before the reader has pressed anything opens suspended,
        // which is an hour of silence over a perfectly good picture.
        void audio.resume().catch(() => undefined);

        const settle = () => settleSources(parts, latest.current);
        settle();
        parts.settling = setInterval(settle, SETTLE_MS);
        parts.painting = setInterval(() => paint(brush, parts, latest.current), 1000 / FPS);

        const recorded = new MediaStream(canvas.captureStream(FPS).getVideoTracks());
        for (const track of mixed.stream.getAudioTracks()) recorded.addTrack(track);

        const recorder = new MediaRecorder(recorded, { mimeType: type });
        parts.recorder = recorder;
        recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;
            parts.chunks.push(event.data);
            parts.bytes += event.data.size;
            setBytes(parts.bytes);
            // Stopped at the ceiling rather than left to grow: a recording that
            // ran past what a message can carry is one somebody made and cannot
            // send, which they find out about at the end.
            if (parts.bytes > MAX_RECORDING_BYTES && recorder.state !== "inactive") {
                parts.stopping = true;
                setError("Stopped: the recording reached the size a message can carry.");
                recorder.stop();
            }
        };
        recorder.onstop = () => {
            const blob = new Blob(parts.chunks, { type });
            parts.chunks = [];
            teardown();
            setRunning(false);
            latest.current.setRecording(false);
            if (blob.size === 0) return;
            setFile(
                new File([blob], `call-recording.${recordingExtension(type)}`, { type })
            );
        };

        // A slice a second, so the size is known while it grows rather than only
        // at the end.
        recorder.start(1000);
        setRunning(true);
        // Said out loud before anything else: from this moment the room is being
        // written down, and everybody in it is entitled to see that on screen.
        latest.current.setRecording(true);
    }, [teardown]);

    /** The clock. */
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setSeconds((count) => count + 1), 1000);
        return () => clearInterval(timer);
    }, [running]);

    useEffect(() => {
        if (running && seconds >= MAX_RECORDING_SECONDS) stop();
    }, [running, seconds, stop]);

    /**
     * The call ending stops the recording rather than losing it.
     *
     * The room going away takes every stream with it, so what would carry on
     * being recorded is a black rectangle and silence. Stopping keeps what was
     * made up to that point, which is the whole meeting.
     */
    useEffect(() => {
        if (running && call.ended) stop();
    }, [call.ended, running, stop]);

    // The tab closing on a recording still holds a canvas, an audio context and
    // a recorder. What was recorded cannot be saved from here - there is nowhere
    // to put it in the time a page has while it is closing - but the devices
    // being let go of is the difference between a clean exit and a browser that
    // thinks the page is still using them.
    useEffect(() => () => teardown(), [teardown]);

    const discard = useCallback(() => {
        setFile(null);
        setSeconds(0);
        setBytes(0);
        setError("");
    }, []);

    return {
        running,
        seconds,
        bytes,
        file,
        error,
        supported: recordingType() !== null,
        start,
        stop,
        discard
    };
}

/** Everything the recording is being made of, in the order it is drawn. */
function piecesOf(call: CallState): {
    stage: { key: string; stream: MediaStream; name: string }[];
    faces: { key: string; stream: MediaStream | null; name: string }[];
} {
    const named = (personId: string): string => {
        const person = call.meeting?.participants.find((entry) => entry.id === personId);
        return person?.name ?? "Somebody";
    };

    const stage: { key: string; stream: MediaStream; name: string }[] = [];
    if (call.localScreen) {
        stage.push({ key: "screen:self", stream: call.localScreen, name: "Your screen" });
    }
    for (const [personId, stream] of call.screens) {
        if (call.localScreen && personId === call.participantId) continue;
        stage.push({ key: `screen:${personId}`, stream, name: `${named(personId)} - screen` });
    }

    const faces: { key: string; stream: MediaStream | null; name: string }[] = [];
    for (const person of call.meeting?.participants ?? []) {
        if (person.admission !== "admitted") continue;
        const own = person.id === call.participantId;
        faces.push({
            key: `face:${person.id}`,
            stream: own ? call.localStream : (call.remote.get(person.id) ?? null),
            name: person.name
        });
    }
    return { stage, faces };
}

/**
 * Keep the mixed sound and the playing elements level with the room.
 *
 * Run on a timer rather than driven by the call, because a recording is started
 * once and the room changes under it for as long as it runs: people join, leave,
 * turn a camera on, start and stop sharing. Anything new is connected, anything
 * gone is disconnected, and everything else is left exactly as it was - a source
 * node rebuilt for a stream that had not changed would be an audible break in
 * the recording.
 */
function settleSources(parts: Machinery, call: CallState): void {
    const audio = parts.audio;
    const mixed = parts.mixed;
    if (!audio || !mixed) return;

    const { stage, faces } = piecesOf(call);
    const streams = new Map<string, MediaStream>();
    for (const piece of [...stage, ...faces]) {
        if (piece.stream) streams.set(piece.key, piece.stream);
    }

    for (const [key, stream] of streams) {
        if (parts.videos.has(key)) {
            // The same slot holding a different stream - somebody republished a
            // camera, or their screen was replaced by another screen.
            const video = parts.videos.get(key);
            if (video && video.srcObject !== stream) {
                video.srcObject = stream;
                void video.play().catch(() => undefined);
            }
        } else if (stream.getVideoTracks().length > 0) {
            const video = document.createElement("video");
            video.srcObject = stream;
            // Muted, always: the sound is mixed below, and an element playing it
            // as well would put every voice into the room twice.
            video.muted = true;
            video.playsInline = true;
            void video.play().catch(() => undefined);
            parts.videos.set(key, video);
        }

        if (stream.getAudioTracks().length === 0) continue;
        const held = parts.sources.get(key);
        // Rebuilt only when the stream itself was replaced - somebody
        // republishing a microphone. A node rebuilt for a stream that had not
        // changed is an audible break in the recording.
        if (held && held.stream === stream) continue;
        held?.node.disconnect();
        try {
            const node = audio.createMediaStreamSource(stream);
            node.connect(mixed);
            parts.sources.set(key, { stream, node });
        } catch {
            // A stream with no live audio track yet. The next pass picks it up.
            parts.sources.delete(key);
        }
    }

    for (const [key, video] of parts.videos) {
        if (streams.has(key)) continue;
        video.srcObject = null;
        video.remove();
        parts.videos.delete(key);
    }
    for (const [key, source] of parts.sources) {
        if (streams.has(key)) continue;
        source.node.disconnect();
        parts.sources.delete(key);
    }
}

/** One frame of the recording. */
function paint(brush: CanvasRenderingContext2D, parts: Machinery, call: CallState): void {
    const { stage, faces } = piecesOf(call);
    const places = recordingLayout(stage.length, faces.length);

    brush.fillStyle = "#0b0b0f";
    brush.fillRect(0, 0, WIDTH, HEIGHT);

    stage.forEach((piece, index) => {
        const rect = places.stage[index];
        if (rect) drawPiece(brush, parts.videos.get(piece.key) ?? null, rect, piece.name);
    });
    faces.forEach((piece, index) => {
        const rect = places.faces[index];
        if (rect) drawPiece(brush, parts.videos.get(piece.key) ?? null, rect, piece.name);
    });
}

/**
 * One tile: the picture if there is one, and the name either way.
 *
 * A camera that is off draws as the person's name on a plain tile rather than
 * being left out. A recording where somebody with no camera simply does not
 * appear is a recording that does not show who was in the meeting, which is one
 * of the two things anybody watches it back for.
 */
function drawPiece(
    brush: CanvasRenderingContext2D,
    video: HTMLVideoElement | null,
    rect: Rect,
    name: string
): void {
    const pad = 4;
    const x = rect.x + pad;
    const y = rect.y + pad;
    const width = Math.max(1, rect.width - pad * 2);
    const height = Math.max(1, rect.height - pad * 2);

    brush.fillStyle = "#17171d";
    brush.fillRect(x, y, width, height);

    if (video && video.readyState >= 2 && video.videoWidth > 0) {
        // Filled rather than fitted, and cropped to do it: a tile with bars down
        // both sides wastes a quarter of the picture on nothing, and every call
        // client crops for the same reason.
        const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
        const drawn = { width: video.videoWidth * scale, height: video.videoHeight * scale };
        brush.save();
        brush.beginPath();
        brush.rect(x, y, width, height);
        brush.clip();
        brush.drawImage(
            video,
            x + (width - drawn.width) / 2,
            y + (height - drawn.height) / 2,
            drawn.width,
            drawn.height
        );
        brush.restore();
    }

    if (!name) return;
    const size = Math.max(12, Math.round(height * 0.07));
    brush.font = `${size}px system-ui, sans-serif`;
    brush.textBaseline = "bottom";
    const label = brush.measureText(name).width;
    brush.fillStyle = "rgba(0,0,0,0.55)";
    brush.fillRect(x, y + height - size - 10, Math.min(width, label + 16), size + 10);
    brush.fillStyle = "#ffffff";
    brush.fillText(name, x + 8, y + height - 4, width - 16);
}
