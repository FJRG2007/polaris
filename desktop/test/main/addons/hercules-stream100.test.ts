import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { addonMessageSchema } from "@/shared/addon-protocol";
import { resolveViewFile } from "@/main/addons/view";
import { readAddonManifest } from "@polaris/core/device-addons";

/** The first device add-on, as CI packages it (device-addons/hercules-stream100). */
const folder = new URL("../../../../device-addons/hercules-stream100/", import.meta.url);
const entry = createRequire(import.meta.url)(fileURLToPath(new URL("any/main.cjs", folder))) as {
    run(options: unknown): void;
    describe(error: string, ownership: unknown): { state: string; detail?: string; code?: string; };
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
        expect(entry.describe("notFound", { ownership: { state: "herculesBusy" } }).detail).toMatch(/Stream Control is running/);
        expect(entry.describe("notFound", { ownership: { state: "unknown", service: "Foo" } }).detail).toMatch(/Foo/);
        expect(entry.describe("busy", null).state).toBe("busy");
        expect(entry.describe("unsupported", null).state).toBe("error");
        expect(entry.describe("noAccess", null).state).toBe("error");
    });

    it("names every sentence it can, so the page says it in the reader's language", () => {
        const cases: [string, unknown][] = [["busy", null], ["noAccess", null], ["unsupported", null], ["io", null], ["notFound", { ownership: { state: "absent" } }], ["notFound", { ownership: { state: "herculesBusy" } }], ["notFound", { ownership: { state: "herculesSdk" } }], ["notFound", { ownership: { state: "other" } }]];
        const codes = cases.map(([error, held]) => entry.describe(error, held).code);
        expect(codes).toEqual(["otherProgram", "noAccess", "unsupported", "stopped", "unplugged", "herculesApp", "herculesDriver", "noControls"]);
        for (const [error, held] of cases) expect(addonMessageSchema.safeParse({ type: "status", ...entry.describe(error, held) }).success).toBe(true);
        // The service's own name is only in the English words, so that one stays uncoded.
        expect(entry.describe("notFound", { ownership: { state: "unknown", service: "Foo" } }).code).toBeUndefined();
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
        expect(sent).toContainEqual({ type: "status", state: "busy", code: "herculesDriver", detail: "Polaris can't use the Stream 100 yet: the Hercules software has it. Until then, use Hercules Stream Control." });
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

    describe("its screen preview", () => {
        const manifest = readAddonManifest(JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")))!;
        const root = fileURLToPath(new URL("any/", folder));
        const view = createRequire(import.meta.url)(fileURLToPath(new URL("any/view/view.js", folder))) as {
            wordsFor(locale: string): { categories: Record<string, string>; displays: Record<string, string>; caption: string };
            readValues(values: unknown): Record<string, unknown>;
            fill(text: string, values: Record<string, unknown>): string;
            tokenEntries(tokens: unknown): Array<[string, string]>;
            DEFAULTS: Record<string, unknown>;
        };

        it("is declared, and everything its page loads is served from its folder, with no inline script", () => {
            expect(manifest.view).toBe("view/index.html");
            const html = readFileSync(new URL("any/view/index.html", folder), "utf8");
            const loaded = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
            expect(loaded.sort()).toEqual(["view.css", "view.js"]);
            for (const path of loaded) expect(resolveViewFile(root, manifest.view!, path)).not.toBeNull();
            const scripts = html.match(/<script[^>]*>/g) ?? [];
            expect(scripts.length).toBeGreaterThan(0);
            for (const tag of scripts) expect(tag).toMatch(/^<script src="[^"]+">$/);
        });

        it("names exactly the choices the manifest declares, and starts from its defaults", () => {
            const words = view.wordsFor("en-US");
            for (const setting of manifest.settings) {
                if (setting.kind === "choice") {
                    const labels = setting.key === "display" ? words.displays : words.categories;
                    expect(Object.keys(labels).sort(), setting.key).toEqual(setting.options.map((option) => option.value).sort());
                }
                if (setting.key in view.DEFAULTS) expect(view.DEFAULTS[setting.key], setting.key).toBe(setting.default);
            }
            expect(Object.keys(view.wordsFor("es-ES").categories).sort()).toEqual(Object.keys(words.categories).sort());
            expect(Object.keys(view.wordsFor("es-ES")).sort()).toEqual(Object.keys(words).sort());
            expect(view.wordsFor("fr-FR")).toBe(words);
        });

        it("reads what is stored field by field", () => {
            expect(view.readValues({ knob1: "music", knob2: "loud", button1: null, button4: "call.leave", brightness: 400 })).toMatchObject({
                knob1: "music",
                knob2: "music",
                button1: "none",
                button4: "call.hangup",
                brightness: 100
            });
            expect(view.fill(view.wordsFor("en-US").caption, { display: "Off", brightness: 40 })).toBe("Screen preview: Off, 40% bright");
            expect(view.tokenEntries({ "--primary": "1 2% 3%", "color": "red", "--x": 4 })).toEqual([["--primary", "1 2% 3%"]]);
        });
        it("lays its settings out as the controller: knobs as dials, buttons as buttons", () => {
            const looks = Object.fromEntries(manifest.groups.map((group) => [group.key, group.look]));
            for (const setting of manifest.settings) {
                if (setting.key.startsWith("knob")) expect(looks[setting.group!], setting.key).toBe("dials");
                if (setting.key.startsWith("button")) expect(looks[setting.group!], setting.key).toBe("buttons");
            }
        });
    });
});
