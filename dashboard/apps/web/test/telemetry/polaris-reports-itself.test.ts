/**
 * Polaris reporting the failures it HANDLED.
 *
 * The Telemetry screen says "and what Polaris reports about itself" and, until
 * this existed, showed almost none of it: the only things captured were a
 * process falling over, which is the rare case. What actually happens all day is
 * caught, logged with `console.error`, and carried on from - a model that would
 * not load, a route that could not be published, storage that was away. Every
 * one of those went into a container log the person running Polaris is never
 * going to open, while the screen built to show them stayed empty.
 *
 * Asserted through the store rather than through the capture function, because
 * the wrapper calls its own module's binding and a spy on the export would never
 * be the thing it reaches. What is checked is what would actually be written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureEvent = vi.fn(async () => {});

vi.mock("@/lib/telemetry/store", () => ({ captureEvent }));
vi.mock("@/lib/telemetry/project-service", () => ({
    systemProject: vi.fn(async () => ({ id: "project-1", retentionDays: 30 }))
}));
vi.mock("@/lib/build-stamp", () => ({ buildStamp: () => "test" }));

const capture = await import("@/lib/telemetry/capture");

const original = console.error;

/** What was written down, once the promise the wrapper did not wait for has
 *  settled. */
async function written(): Promise<Record<string, unknown>[]> {
    await Promise.resolve();
    await Promise.resolve();
    return captureEvent.mock.calls.map((call) => (call as unknown[])[1] as Record<string, unknown>);
}

beforeEach(() => {
    captureEvent.mockClear();
    console.error = original;
});

describe("a failure Polaris handled", () => {
    it("still reaches the console, and is written down as well", async () => {
        const said: unknown[][] = [];
        console.error = (...args: unknown[]) => said.push(args);
        capture.watchLoggedFailures();

        console.error("polaris: could not publish the call route");

        // The line somebody reading container logs looks for is untouched.
        expect(said).toHaveLength(1);
        expect(said[0]?.[0]).toBe("polaris: could not publish the call route");

        const events = await written();
        expect(events).toHaveLength(1);
        expect(events[0]?.value).toBe("polaris: could not publish the call route");
        expect(events[0]?.transaction).toBe("polaris");
    });

    it("prefers a thrown error among the arguments, for its stack", async () => {
        console.error = () => {};
        capture.watchLoggedFailures();

        console.error("polaris: the fast pass failed:", new Error("the archive failed"));

        const events = await written();
        expect(events[0]?.value).toBe("the archive failed");
        // The place still comes off the line, which is the half the error does
        // not carry.
        expect(events[0]?.transaction).toBe("polaris");
    });

    it("files it under the place the line names, and admits when there is none", async () => {
        console.error = () => {};
        capture.watchLoggedFailures();

        console.error("avatars: gravatar unreachable");
        console.error("no prefix here");

        const events = await written();
        expect(events[0]?.transaction).toBe("avatars");
        expect(events[1]?.transaction).toBe("console.error");
    });

    it("says nothing about a console call with nothing in it", async () => {
        console.error = () => {};
        capture.watchLoggedFailures();

        console.error();
        console.error("");

        expect(await written()).toHaveLength(0);
    });

    it("marks it as having come from a logged line", async () => {
        console.error = () => {};
        capture.watchLoggedFailures();

        console.error("polaris: something went wrong");

        const events = await written();
        expect((events[0]?.tags as Record<string, string>).via).toBe("console");
        expect((events[0]?.tags as Record<string, string>).source).toBe("polaris");
    });
});
