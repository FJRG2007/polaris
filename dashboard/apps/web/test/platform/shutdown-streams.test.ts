/**
 * An update replacing this container sends it SIGTERM. Next.js then waits for
 * every open connection before it exits, and a live stream never ends on its
 * own, so the streams end themselves the moment the signal arrives and the
 * browser reconnects to the new container. A request that is not a stream is
 * left to finish.
 */

import { describe, expect, it } from "vitest";
import { beginShutdown, shutdownSignal, shuttingDown, untilShutdown } from "@/lib/shutdown";
import { metricTickStream, subjectKey } from "@/lib/metrics-live";

describe("stopping the container", () => {
    it("ends a live stream when SIGTERM arrives, and leaves other signals alone", async () => {
        const open = new AbortController();
        const response = metricTickStream(new Request("http://polaris.test/stream", { signal: open.signal }), [
            subjectKey("app", "app-1")
        ]);
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("event: ready");

        const request = new AbortController();
        const watched = untilShutdown(request.signal);
        expect(shuttingDown()).toBe(false);

        // What the SIGTERM listener runs; raising the real signal here would
        // reach the test runner's own handlers too.
        expect(process.listeners("SIGTERM")).toContain(beginShutdown);
        beginShutdown();

        expect(shuttingDown()).toBe(true);
        expect(shutdownSignal().aborted).toBe(true);
        expect(watched.aborted).toBe(true);
        expect(request.signal.aborted).toBe(false);
        let done = false;
        for (let reads = 0; reads < 5 && !done; reads += 1) done = (await reader.read()).done;
        expect(done).toBe(true);
    });
});
