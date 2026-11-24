/**
 * An app bundle's action made with Polaris out of reach: kept as data (app,
 * module, action, arguments), sent to the action route from any page, its
 * `{ ok: false }` answer shown as the app's own refusal, a whole save replacing
 * one still waiting, and nothing kept for a function that is not an action stub.
 */

import "fake-indexeddb/auto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    noteResponseStatus: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const writes = await import("@/lib/offline/app-action-writes");
// The bundler is plain Node, read from its file as the bundle tests do.
const BUNDLER = pathToFileURL(resolve(__dirname, "../../../../packages/app-host/bundler/build.mjs")).href;
const { actionStubSource } = (await import(/* @vite-ignore */ BUNDLER)) as {
    actionStubSource: (app: string, module: string, names: string[]) => string;
};

const REF = Symbol.for("polaris.app-action-ref");

/** An action stub as the bundler writes it, calling `impl`. */
function stub(name: string, impl: (...args: unknown[]) => Promise<unknown>) {
    return Object.assign(impl, { [REF]: { app: "calendar", module: "src/actions/events.ts", name } });
}

const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("delivering a kept app action", () => {
    const entry = { payload: { app: "calendar", module: "m", name: "saveEventAction", args: [{ a: 1 }], label: "", meta: null } };

    it("posts the call to the action route as it was kept", async () => {
        fetchMock.mockResolvedValue(answer(200, { value: { ok: true, objectId: "x" } }));
        expect(await writes.deliverAppAction(entry)).toEqual({ sent: "" });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("/api/app-bundles/action");
        expect(JSON.parse(String(init?.body))).toEqual({ app: "calendar", module: "m", name: "saveEventAction", args: [{ a: 1 }] });
    });

    it("maps each answer", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        expect(await writes.deliverAppAction(entry)).toBe("unreachable");
        for (const status of [408, 429, 500, 502, 503, 504]) {
            fetchMock.mockResolvedValueOnce(answer(status, { error: "later" }));
            expect(await writes.deliverAppAction(entry)).toBe("unreachable");
        }
        fetchMock.mockResolvedValueOnce(answer(404, { error: "That is not something this app does." }));
        expect(await writes.deliverAppAction(entry)).toEqual({ refused: "That is not something this app does." });
        fetchMock.mockResolvedValueOnce(answer(200, { value: { ok: false, error: "This event changed meanwhile." } }));
        expect(await writes.deliverAppAction(entry)).toEqual({ refused: "This event changed meanwhile." });
        fetchMock.mockResolvedValueOnce(answer(200, { redirect: "/calendar" }));
        expect(await writes.deliverAppAction(entry)).toEqual({ sent: "" });
    });
});

describe("attempting an app action", () => {
    it("answers what the action answered when Polaris is there", async () => {
        const save = stub("saveEventAction", async () => ({ ok: true }));
        expect(await writes.attemptAppAction(save, [{}], { target: "e1", label: "Lunch" })).toEqual({ value: { ok: true } });
        expect(await writes.keptAppActions("calendar")).toEqual([]);
    });

    it("keeps it when no server answers, and later calls to the same event wait behind it", async () => {
        const shift = stub("shiftEventAction", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
        expect(await writes.attemptAppAction(shift, [{ d: 1 }], { target: "e1", label: "Lunch", meta: { op: "shift" } })).toEqual({ kept: true });
        const remove = stub("deleteEventAction", vi.fn(async () => ({ ok: true })));
        expect(await writes.attemptAppAction(remove, [{ d: 2 }], { target: "e1", label: "Lunch" })).toEqual({ kept: true });
        expect(remove).not.toHaveBeenCalled();
        const kept = await writes.keptAppActions("calendar", "e1");
        expect(kept.map((call) => [call.name, call.args, call.target])).toEqual([
            ["shiftEventAction", [{ d: 1 }], "e1"],
            ["deleteEventAction", [{ d: 2 }], "e1"]
        ]);
        expect(kept[0]!.meta).toEqual({ op: "shift" });
    });

    it("rethrows any other failure, and keeps nothing for a function that is not an action stub", async () => {
        const broken = stub("saveEventAction", async () => Promise.reject(new Error("The server could not do that.")));
        await expect(writes.attemptAppAction(broken, [], { target: "e1", label: "" })).rejects.toThrow("could not do that");
        const plain = async () => Promise.reject(new TypeError("Failed to fetch"));
        await expect(writes.attemptAppAction(plain, [], { target: "e1", label: "" })).rejects.toThrow(TypeError);
        expect(await writes.keptAppActions("calendar")).toEqual([]);
    });

    it("lets a whole save replace one still waiting, but not a drag", async () => {
        const save = stub("saveEventAction", async () => ({ ok: true }));
        const shift = stub("shiftEventAction", async () => ({ ok: true }));
        await writes.keepAppAction(shift, [{ n: 0 }], { target: "e1", label: "" });
        await writes.keepAppAction(save, [{ n: 1 }], { target: "e1", label: "", replace: true });
        await writes.keepAppAction(save, [{ n: 2 }], { target: "e1", label: "", replace: true });
        await writes.keepAppAction(save, [{ n: 3 }], { target: "e2", label: "", replace: true });
        const kept = await writes.keptAppActions("calendar");
        expect(kept.map((call) => [call.target, call.name, call.args])).toEqual([
            ["e1", "shiftEventAction", [{ n: 0 }]],
            ["e1", "saveEventAction", [{ n: 2 }]],
            ["e2", "saveEventAction", [{ n: 3 }]]
        ]);
    });

    it("sends what was kept when Polaris answers, and keeps a refusal with its reason for Try again with new arguments", async () => {
        const save = stub("saveEventAction", async () => ({ ok: true }));
        await writes.keepAppAction(save, [{ version: "v1" }], { target: "e1", label: "" });
        fetchMock.mockResolvedValue(answer(200, { value: { ok: false, error: "Changed meanwhile." } }));
        appWrites.flush();
        await vi.waitFor(async () => expect((await writes.keptAppActions("calendar"))[0]?.state).toBe("failed"));
        const [failed] = await writes.keptAppActions("calendar");
        expect(failed!.reason).toBe("Changed meanwhile.");
        fetchMock.mockResolvedValue(answer(200, { value: { ok: true } }));
        await writes.retryAppAction(failed!.key, [{ version: null }]);
        await vi.waitFor(async () => expect(await writes.keptAppActions("calendar")).toEqual([]));
        expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)).args).toEqual([{ version: null }]);
    });

    it("drops only an app's own kept call", async () => {
        await appWrites.enqueue({ key: "note-1", kind: "note.update", target: "n1", payload: {} });
        await writes.discardAppAction("note-1");
        expect((await appWrites.readAll()).map((entry) => entry.key)).toEqual(["note-1"]);
    });
});

describe("the bundler's action stubs", () => {
    it("call through the dashboard and say which action they are", async () => {
        const calls: unknown[] = [];
        (globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-action")] = async (...args: unknown[]) => {
            calls.push(args);
            return "done";
        };
        const source = actionStubSource("calendar", "src/actions/events.ts", ["saveEventAction"]);
        const module = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const save = module.saveEventAction!;
        expect(await save({ a: 1 })).toBe("done");
        expect(calls).toEqual([["calendar", "src/actions/events.ts", "saveEventAction", [{ a: 1 }]]]);
        expect(writes.actionRefOf(save)).toEqual({ app: "calendar", module: "src/actions/events.ts", name: "saveEventAction" });
    });
});
