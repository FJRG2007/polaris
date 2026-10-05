/**
 * Live video fed to the player a fragment at a time, the moment it arrives.
 *
 * Handing a `<video>` the stream's address and letting it get on with it is what
 * made a camera take about fourteen seconds to open. A browser treats a URL as a
 * file: it reads ahead until it holds what it considers enough to play smoothly,
 * and only then starts - which for a stream that arrives in real time is the
 * same several seconds of waiting every time, followed by a picture that many
 * seconds behind the camera.
 *
 * Media Source Extensions take that decision away from it. The same bytes, from
 * the same authenticated route, are read here and appended as they come in, so
 * the first keyframe the relay sends is the first frame on screen. Nothing is
 * re-encoded anywhere: the relay passes the camera's own H.264 or H.265 through,
 * and the codec string it names in its answer is what the buffer is opened with.
 * This is the technique go2rtc's own player, Frigate and Home Assistant use for
 * the same reason.
 *
 * It also keeps the picture live. A playhead that falls behind - a tab in the
 * background, a slow moment on the network - is moved back up to the newest
 * frame rather than left to play through the backlog, and what is behind it is
 * dropped so a camera left open all day does not fill the browser's memory.
 *
 * Client-only.
 */

/** Seconds of video kept behind the playhead. Enough for the browser to step
 *  back over a gap; anything more is memory spent on the past. */
export const KEEP_BEHIND_S = 8;

/** How far the playhead may fall behind the newest frame before it is moved up
 *  to it. Above the jitter of an ordinary network, below what reads as a delay. */
export const MAX_LAG_S = 1.5;

/** Where a moved playhead lands: just short of the newest frame, so there is
 *  something left to play into while the next fragment arrives. */
export const EDGE_S = 0.15;

/** The part of `MediaSource` this needs, so Safari's managed variant fits too. */
interface SourceType {
    new (): MediaSource;
    isTypeSupported(type: string): boolean;
}

/**
 * The media source this browser offers, or null when it has none.
 *
 * The standard one first. An iPhone has only the managed variant (iOS 17.1 and
 * later), which takes the same calls; anything older has neither and gets HLS.
 */
export function mediaSourceType(scope: unknown = globalThis): SourceType | null {
    const found = scope as { MediaSource?: SourceType; ManagedMediaSource?: SourceType };
    return found.MediaSource ?? found.ManagedMediaSource ?? null;
}

/** What to do with the buffer before the next fragment goes in. */
export interface LivePlan {
    /** Move the playhead here, or leave it where it is. */
    readonly seekTo: number | null;
    /** Drop everything before this, or keep it all. */
    readonly trimTo: number | null;
}

/**
 * Keep the playhead at the live edge and the buffer short.
 *
 * `first` is where the oldest buffered range starts; `newest` is the range the
 * relay is appending to. The playhead is measured against the newest one only:
 * a gap left by a dropped fragment is something to jump over, not to wait in.
 *
 * Pure, so the rules are tests rather than something to reproduce by leaving a
 * tab in the background.
 */
export function keepLive(
    first: number | null,
    newest: { start: number; end: number } | null,
    playhead: number
): LivePlan {
    if (first === null || !newest) return { seekTo: null, trimTo: null };
    const behind = playhead < newest.start || newest.end - playhead > MAX_LAG_S;
    const seekTo = behind ? Math.max(newest.start, newest.end - EDGE_S) : null;
    // Trimmed in steps rather than on every fragment: a removal is an operation
    // the buffer has to finish before anything else can go in, and doing one
    // per frame would hold the picture back by exactly the work it saves.
    const anchor = seekTo ?? playhead;
    const trimTo = anchor - first > KEEP_BEHIND_S + 2 ? anchor - KEEP_BEHIND_S : null;
    return { seekTo, trimTo };
}

/** Why live playback stopped on its own. The caller only needs to know that it
 *  did - every one of these means "try the next format" - but a name is what
 *  makes a report from somebody's phone readable. */
export type LiveFailure = "unsupported" | "network" | "refused" | "codec" | "decode" | "ended";

/**
 * Play a live fragmented-MP4 stream into a video element.
 *
 * Answers the function that stops it. Stopping closes the request as well as
 * the picture: a stream left running holds a consumer on the relay for somebody
 * who has gone.
 */
export function playLive(
    video: HTMLVideoElement,
    url: string,
    onFail: (reason: LiveFailure) => void
): () => void {
    const Source = mediaSourceType();
    if (!Source) {
        onFail("unsupported");
        return () => {};
    }

    const request = new AbortController();
    const source = new Source();
    let stopped = false;

    const fail = (reason: LiveFailure) => {
        if (stopped) return;
        stopped = true;
        request.abort();
        onFail(reason);
    };

    // The managed source refuses to open on an element that could be sent to
    // another screen, and the standard one does not care either way.
    video.disableRemotePlayback = true;
    const objectUrl = URL.createObjectURL(source);
    video.src = objectUrl;

    const feed = async () => {
        URL.revokeObjectURL(objectUrl);
        let response: Response;
        try {
            response = await fetch(url, { signal: request.signal, cache: "no-store" });
        } catch {
            fail("network");
            return;
        }
        if (!response.ok || !response.body) {
            fail("refused");
            return;
        }
        // The relay names the codecs it is passing through, profile and level
        // included - which is exactly what the buffer has to be opened with.
        const type = response.headers.get("content-type") ?? "";
        if (!type.includes("codecs=") || !Source.isTypeSupported(type)) {
            fail("codec");
            return;
        }
        let buffer: SourceBuffer;
        try {
            buffer = source.addSourceBuffer(type);
            buffer.mode = "segments";
        } catch {
            fail("codec");
            return;
        }

        const queue: Uint8Array[] = [];
        const follow = () => {
            const ranges = buffer.buffered;
            if (ranges.length === 0) return null;
            const last = ranges.length - 1;
            return keepLive(
                ranges.start(0),
                { start: ranges.start(last), end: ranges.end(last) },
                video.currentTime
            );
        };
        const pump = () => {
            if (stopped || buffer.updating || source.readyState !== "open") return;
            const plan = follow();
            if (plan?.seekTo !== null && plan?.seekTo !== undefined)
                video.currentTime = plan.seekTo;
            if (plan?.trimTo !== null && plan?.trimTo !== undefined) {
                buffer.remove(buffer.buffered.start(0), plan.trimTo);
                return;
            }
            if (queue.length === 0) return;
            const chunk = queue.length === 1 ? queue[0]! : join(queue);
            queue.length = 0;
            try {
                buffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>);
            } catch {
                fail("decode");
            }
        };
        buffer.addEventListener("updateend", () => {
            pump();
            // Autoplay is set on the element, but a play() that was refused
            // before there was anything to play is not retried by the browser.
            if (!stopped && video.paused && buffer.buffered.length > 0) {
                video.play().catch(() => {});
            }
        });
        buffer.addEventListener("error", () => fail("decode"));

        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) queue.push(value);
                pump();
            }
        } catch {
            fail("network");
            return;
        }
        // The relay closed a stream that is meant to run for as long as somebody
        // watches: the camera went away. Said, so the caller can try again.
        fail("ended");
    };
    source.addEventListener("sourceopen", () => void feed(), { once: true });

    return () => {
        stopped = true;
        request.abort();
        try {
            if (source.readyState === "open") source.endOfStream();
        } catch {
            // Already closing - which is what was being asked for.
        }
        video.removeAttribute("src");
        video.load();
    };
}

function join(parts: readonly Uint8Array[]): Uint8Array {
    const size = parts.reduce((total, part) => total + part.byteLength, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}
