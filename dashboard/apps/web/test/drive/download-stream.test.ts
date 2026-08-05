/**
 * A download hands its driver's lifetime to the response body: the handler returns
 * long before the bytes do, so the session it borrowed comes back when the stream
 * ends - and a session that never comes back pins its connection for the life of
 * the process, one more per download.
 */

import { describe, expect, it, vi } from "vitest";
import { pipeThenDispose } from "@/lib/drive-stream";

function driverStub() {
    return { dispose: vi.fn(async () => undefined) };
}

function sourceOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
}

describe("download streams", () => {
    it("gives the session back once the last byte has left", async () => {
        const driver = driverStub();
        const body = pipeThenDispose(sourceOf(["one", "two"]), driver);

        const text = await new Response(body).text();

        expect(text).toBe("onetwo");
        expect(driver.dispose).toHaveBeenCalledTimes(1);
    });

    it("gives it back when the client walks away mid-file", async () => {
        const driver = driverStub();
        const body = pipeThenDispose(sourceOf(["one", "two"]), driver);

        const reader = body.getReader();
        await reader.read();
        await reader.cancel("navigated away");

        expect(driver.dispose).toHaveBeenCalledTimes(1);
    });

    it("gives it back when the read itself fails", async () => {
        const driver = driverStub();
        const source = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error("STATUS_FILE_CLOSED"));
            }
        });

        await expect(new Response(pipeThenDispose(source, driver)).text()).rejects.toThrow();
        expect(driver.dispose).toHaveBeenCalledTimes(1);
    });
});
