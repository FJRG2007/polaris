"use client";

/**
 * Talk through a camera: press to open its speaker, press again to close it.
 *
 * A toggle rather than a button held down, because a held button is a thumb
 * pinned to a phone for as long as somebody speaks, and lifting it by accident
 * cuts them off mid-word.
 *
 * The microphone is recorded with the browser's echo cancelling on, brought
 * down to 8 kHz here, and posted to Polaris a quarter of a second at a time -
 * over the same HTTPS as the page, so it works wherever the page does. A camera
 * reached over RTSP has no way in to its speaker; its button says what does.
 */

import * as actions from "./actions";
import { useToast } from "@polaris/ui";
import { usePlacesT } from "./use-places-t";
import { ViewerControl } from "./viewer-control";
import type { TalkSupport } from "../lib/vendors";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHUNK_BYTES, TALK_RATE, TalkResampler } from "../lib/talk-audio";

/** How often what the microphone heard is sent. Short enough to sound live,
 *  long enough not to be a request per word. */
const SEND_EVERY_MS = 250;

/** A piece still on its way after this long is given up on, so one stalled
 *  request does not hold every piece behind it. */
const SEND_TIMEOUT_MS = 5000;

/** At most a second of voice waits to be sent. Older than that is dropped: a
 *  voice heard seconds late is worse than a gap. */
const MAX_QUEUED_BYTES = TALK_RATE * 2;

interface Live {
    readonly talkId: string;
    readonly stream: MediaStream;
    readonly context: AudioContext;
    readonly source: MediaStreamAudioSourceNode;
    readonly node: ScriptProcessorNode;
    readonly timer: ReturnType<typeof setInterval>;
    readonly pending: Uint8Array[];
    sending: boolean;
}

function joined(parts: Uint8Array[]): Uint8Array {
    let size = 0;
    for (const part of parts) size += part.byteLength;
    const out = new Uint8Array(Math.min(size, MAX_CHUNK_BYTES));
    let at = 0;
    while (parts.length > 0 && at < out.byteLength) {
        const part = parts[0] as Uint8Array;
        const room = out.byteLength - at;
        if (part.byteLength <= room) {
            out.set(part, at);
            at += part.byteLength;
            parts.shift();
        } else {
            out.set(part.subarray(0, room), at);
            parts[0] = part.subarray(room);
            at += room;
        }
    }
    return out;
}

function dropStale(parts: Uint8Array[]): void {
    let size = 0;
    for (const part of parts) size += part.byteLength;
    while (size > MAX_QUEUED_BYTES && parts.length > 1)
        size -= (parts.shift() as Uint8Array).byteLength;
}

export function TalkControl({ cameraId, support }: { cameraId: string; support: TalkSupport }) {
    const t = usePlacesT();
    const toast = useToast();
    const key = `places-talk-${cameraId}`;
    const [state, setState] = useState<"idle" | "starting" | "live">("idle");
    const live = useRef<Live | null>(null);
    const mounted = useRef(true);

    const stop = useCallback(
        (tellServer: boolean) => {
            const current = live.current;
            live.current = null;
            if (mounted.current) setState("idle");
            if (!current) return;
            clearInterval(current.timer);
            current.node.onaudioprocess = null;
            current.source.disconnect();
            current.node.disconnect();
            void current.context.close().catch(() => undefined);
            for (const track of current.stream.getTracks()) track.stop();
            if (tellServer)
                void actions.stopTalkAction(cameraId, current.talkId).catch(() => undefined);
        },
        [cameraId]
    );

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            stop(true);
        };
    }, [stop]);

    const flush = useCallback(() => {
        const current = live.current;
        if (!current || current.sending || current.pending.length === 0) return;
        const body = joined(current.pending);
        current.sending = true;
        const url = `/api/home/cameras/${cameraId}/talk?talk=${encodeURIComponent(current.talkId)}`;
        fetch(url, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: body.slice().buffer,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        })
            .then((response) => {
                // Over on the server: ended by the camera, by the relay, or by a
                // pause long enough to close it.
                if (
                    live.current === current &&
                    (response.status === 409 || response.status === 403)
                ) {
                    stop(false);
                    toast.show({ key, title: t("talk.ended") });
                }
            })
            .catch(() => undefined)
            .finally(() => {
                current.sending = false;
            });
    }, [cameraId, key, stop, t, toast]);

    const start = useCallback(async () => {
        setState("starting");
        const context = new AudioContext();
        void context.resume().catch(() => undefined);
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        } catch {
            void context.close().catch(() => undefined);
            if (mounted.current) setState("idle");
            toast.show({ key, title: t("talk.noMic") });
            return;
        }
        const result = await actions.startTalkAction(cameraId).catch(() => null);
        if (!result?.talkId || !mounted.current) {
            for (const track of stream.getTracks()) track.stop();
            void context.close().catch(() => undefined);
            if (result?.talkId)
                void actions.stopTalkAction(cameraId, result.talkId).catch(() => undefined);
            if (mounted.current) {
                setState("idle");
                toast.show({ key, title: result?.error ?? t("talk.failed") });
            }
            return;
        }
        const source = context.createMediaStreamSource(stream);
        // Deprecated in favour of a worklet, and still in every browser; a
        // worklet would need a script file of its own served next to the page.
        const node = context.createScriptProcessor(4096, 1, 1);
        const resampler = new TalkResampler(context.sampleRate);
        const pending: Uint8Array[] = [];
        node.onaudioprocess = (event) => {
            pending.push(resampler.push(event.inputBuffer.getChannelData(0)));
            dropStale(pending);
            // Nothing is played back: the output stays silent.
            event.outputBuffer.getChannelData(0).fill(0);
        };
        source.connect(node);
        node.connect(context.destination);
        live.current = {
            talkId: result.talkId,
            stream,
            context,
            source,
            node,
            timer: setInterval(() => flush(), SEND_EVERY_MS),
            pending,
            sending: false
        };
        setState("live");
    }, [cameraId, flush, key, t, toast]);

    if (support === "rtsp")
        return (
            <ViewerControl
                label={t("talk.rtsp")}
                onClick={() => toast.show({ key, title: t("talk.rtsp") })}
            >
                <MicOff className="size-4 shrink-0" />
            </ViewerControl>
        );

    return (
        <ViewerControl
            label={state === "live" ? t("talk.stop") : t("talk.start")}
            active={state === "live"}
            disabled={state === "starting"}
            onClick={() => (state === "live" ? stop(true) : void start())}
        >
            {state === "starting" ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : (
                <Mic className="size-4 shrink-0" />
            )}
        </ViewerControl>
    );
}
