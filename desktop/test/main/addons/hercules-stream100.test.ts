import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { addonMessageSchema } from "@/shared/addon-protocol";
import { readAddonManifest } from "@polaris/core/device-addons";

/** The first device add-on, as CI packages it (device-addons/hercules-stream100). */
const folder = new URL("../../../../device-addons/hercules-stream100/", import.meta.url);
const entry = createRequire(import.meta.url)(fileURLToPath(new URL("any/main.cjs", folder))) as {
    run(options: unknown): void;
    describe(error: string, ownership: unknown): { state: string; detail?: string; };
};

type Read = { report?: Uint8Array; error?: string; };

/** A native module whose reader answers the scripted reads, then waits forever. Nothing touches a real device or volume. */
function fakeNative(reads: Read[], actions: string[][] = []) {
    const feed = vi.fn(() => actions.shift() ?? []);
    const setSettings = vi.fn();
    const reset = vi.fn();
    const close = vi.fn();
    const native = {
        Reader: class {
            next() {
                const read = reads.shift();
                return read ? Promise.resolve(read) : new Promise<Read>(() => {});
            }
            close = close;
        },
        Controller: class {
            constructor(readonly settings: string) {}
            feed = feed;
            setSettings = setSettings;
            reset = reset;
        },
        settingsFromAddon: (values: string) => `full:${values}`,
        ownershipJson: () => JSON.stringify({ observed: {}, ownership: { state: "herculesSdk" } })
    };
    return { native, feed, setSettings, reset, close };
}

function fakePort() {
    let listener: (event: { data: unknown; }) => void = () => {};
    const sent: unknown[] = [];
    return {
        sent,
        port: { postMessage: (message: unknown) => sent.push(message), on: (_: string, next: typeof listener) => (listener = next) },
        deliver: (data: unknown) => listener({ data })
    };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

describe("Hercules Stream 100 add-on", () => {
    it("ships a manifest the app reads, with one entry on every platform it is built for", () => {
        const manifest = readAddonManifest(JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")));
        expect(manifest?.id).toBe("hercules-stream100");
        expect(manifest?.claims).toEqual([{ vendorId: 0x06f8, productId: 0xe053, name: "Hercules Stream 100" }]);
        expect(manifest?.entries).toEqual({ "win32-x64": "main.cjs", "linux-x64": "main.cjs" });
        expect(manifest?.settings.map((setting) => setting.key)).toContain("button4");
    });

    it("says who holds the controller when it cannot be read", () => {
        expect(entry.describe("notFound", { ownership: { state: "absent" } }).state).toBe("sleeping");
        expect(entry.describe("notFound", { ownership: { state: "herculesBusy" } }).detail).toMatch(/Hercules driver/);
        expect(entry.describe("notFound", { ownership: { state: "unknown", service: "Foo" } }).detail).toMatch(/Foo/);
        expect(entry.describe("busy", null).state).toBe("busy");
        expect(entry.describe("unsupported", null).state).toBe("error");
        expect(entry.describe("noAccess", null).state).toBe("error");
    });

    it("reports in, call actions out to the app, under the names the app knows", async () => {
        const report = new Uint8Array(11);
        const fake = fakeNative([{ error: "notFound" }, { report }], [["call.hangup", "call.mic"]]);
        const { port, sent, deliver } = fakePort();
        const exit = vi.fn();
        entry.run({ port, native: fake.native, now: () => 1_000, sleep: () => Promise.resolve(), exit });
        deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: { knob1: "music" } });
        await flush();

        for (const message of sent) expect(addonMessageSchema.safeParse(message).success).toBe(true);
        expect(sent[0]).toEqual({ type: "ready" });
        expect(sent).toContainEqual({ type: "status", state: "busy", detail: "The Hercules driver holds the Stream 100, so Polaris cannot read it yet." });
        expect(sent).toContainEqual({ type: "status", state: "connected" });
        expect(fake.feed).toHaveBeenCalledWith(report, 1_000);
        const calls = sent.filter((message) => (message as { type: string; }).type === "call") as { id: number; params: unknown; }[];
        expect(calls.map((message) => message.params)).toEqual([{ action: "call.leave" }, { action: "call.mic" }]);

        for (const message of calls) deliver({ type: "reply", id: message.id, ok: true, value: null });
        deliver({ type: "settings", settings: { knob1: "games" } });
        expect(fake.setSettings).toHaveBeenCalledWith(`full:${JSON.stringify({ knob1: "games" })}`);

        deliver({ type: "stop" });
        expect(fake.close).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(0);
    });

    it("forgets the knobs' baseline when the controller goes away", async () => {
        const fake = fakeNative([{ report: new Uint8Array(11) }, { error: "io" }]);
        const { port, deliver } = fakePort();
        entry.run({ port, native: fake.native, now: () => 5, sleep: () => Promise.resolve(), exit: vi.fn() });
        deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: {} });
        await flush();
        expect(fake.reset).toHaveBeenCalledTimes(1);
    });
});
