/**
 * An open chart hears about new samples for its own subject, and only those.
 *
 * The stream is what lets a chart stop polling, so the two ways it can fail
 * are both silent: a chart that is never told (and never moves again, because
 * it stopped polling the moment the stream said ready), and a chart told about
 * every subject on the instance, which re-reads on every sample anybody gets.
 */

import { describe, expect, it } from "vitest";
import {
    metricTickStream,
    publishMetricTick,
    subjectKey,
    subscribeMetricTicks
} from "@/lib/metrics-live";

const APP = "0192f6a0-0000-7000-8000-0000000000bb";
const OTHER = "0192f6a0-0000-7000-8000-0000000000cc";
const VOLUME = "0192f6a0-0000-7000-8000-0000000000dd";

async function readSome(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    until: string
): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(until)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
    }
    return text;
}

describe("the metric bus", () => {
    it("hands a tick to every listener with the subjects written", () => {
        const seen: string[][] = [];
        const stop = subscribeMetricTicks((tick) => seen.push([...tick.subjects].sort()));
        publishMetricTick([
            { subjectType: "app", subjectId: APP },
            { subjectType: "volume", subjectId: VOLUME }
        ]);
        stop();
        publishMetricTick([{ subjectType: "app", subjectId: APP }]);
        expect(seen).toEqual([[`app:${APP}`, `volume:${VOLUME}`]]);
    });

    it("keeps publishing when one listener throws", () => {
        const seen: number[] = [];
        const stopBad = subscribeMetricTicks(() => {
            throw new Error("a dead connection");
        });
        const stopGood = subscribeMetricTicks((tick) => seen.push(tick.at));
        const original = console.error;
        console.error = () => undefined;
        try {
            publishMetricTick([{ subjectType: "host", subjectId: APP }], 42);
        } finally {
            console.error = original;
            stopBad();
            stopGood();
        }
        expect(seen).toEqual([42]);
    });
});

describe("a chart's stream", () => {
    it("says ready, then tick for its own subjects and nothing for others", async () => {
        const abort = new AbortController();
        const response = metricTickStream(
            new Request("http://polaris.test/stream", { signal: abort.signal }),
            [subjectKey("app", APP), subjectKey("volume", VOLUME)]
        );
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        expect(await readSome(reader, "event: ready")).toContain("event: ready");

        publishMetricTick([{ subjectType: "app", subjectId: OTHER }], 1);
        publishMetricTick([{ subjectType: "volume", subjectId: VOLUME }], 2);
        const text = await readSome(reader, "event: tick");
        expect(text).toContain('data: {"at":2}');
        expect(text).not.toContain('"at":1');

        abort.abort();
        await reader.cancel();
    });
});
