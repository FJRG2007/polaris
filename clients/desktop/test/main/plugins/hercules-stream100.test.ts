import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { pluginMessageSchema } from "@/shared/plugin-protocol";
import { resolveViewFile } from "@/main/plugins/view";
import { readPluginManifest } from "@polaris/core/device-plugins";

/** The first device plugin, as CI packages it (clients/device-plugins/hercules-stream100). */
const folder = new URL("../../../../device-plugins/hercules-stream100/", import.meta.url);
const entry = createRequire(import.meta.url)(fileURLToPath(new URL("any/main.cjs", folder))) as {
    run(options: unknown): void;
    describe(error: string, ownership: unknown): { state: string; detail?: string; code?: string; };
    connectedStatus(access: string): { state: string; detail?: string; code?: string; };
};

type Read = { report?: Uint8Array; error?: string; };

/** A native module whose reader answers the scripted reads, then waits forever. Nothing touches a real device or volume. */
function fakeNative(reads: Read[], actions: string[][] = [], playing: () => Promise<string> = async () => "null") {
    const feed = vi.fn(() => actions.shift() ?? []);
    const setLocale = vi.fn();
    const setCall = vi.fn();
    const setNowPlaying = vi.fn();
    const nowPlaying = vi.fn(playing);
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
            setLocale = setLocale;
            setCall = setCall;
            setNowPlaying = setNowPlaying;
        },
        nowPlaying,
        settingsFromPlugin: (values: string) => `full:${values}`,
        ownershipJson: () => JSON.stringify({ observed: {}, ownership: { state: "herculesSdk" } })
    };
    return { native, feed, setSettings, reset, close, setLocale, setCall, setNowPlaying, nowPlaying };
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

describe("Hercules Stream 100 plugin", () => {
    it("ships a manifest the app reads, with one entry on every platform it is built for", () => {
        const manifest = readPluginManifest(JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")));
        expect(manifest?.id).toBe("hercules-stream100");
        expect(manifest?.claims).toEqual([{ vendorId: 0x06f8, productId: 0xe053, name: "Hercules Stream 100" }]);
        expect(manifest?.entries).toEqual(Object.fromEntries(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].map((platform) => [platform, "main.cjs"])));
        expect(manifest?.settings.map((setting) => setting.key)).toContain("button4");
    });

    it("says who holds the controller when it cannot be read", () => {
        expect(entry.describe("notFound", { ownership: { state: "absent" } }).state).toBe("sleeping");
        expect(entry.describe("notFound", { ownership: { state: "herculesBusy" } }).detail).toMatch(/Close Hercules Stream Control/);
        expect(entry.describe("notFound", { ownership: { state: "unknown", service: "Foo" } }).detail).toMatch(/Foo/);
        expect(entry.describe("busy", null).state).toBe("busy");
        expect(entry.describe("unsupported", null).state).toBe("error");
        expect(entry.describe("noAccess", null).state).toBe("error");
    });

    it("names every sentence it can, so the page says it in the reader's language", () => {
        const cases: [string, unknown][] = [["busy", null], ["noAccess", null], ["unsupported", null], ["io", null], ["notFound", { ownership: { state: "absent" } }], ["notFound", { ownership: { state: "herculesBusy" } }], ["notFound", { ownership: { state: "herculesSdk" } }], ["notFound", { ownership: { state: "other" } }]];
        const codes = cases.map(([error, held]) => entry.describe(error, held).code);
        expect(codes).toEqual(["otherProgram", "noAccess", "unsupported", "stopped", "unplugged", "herculesApp", "herculesDriver", "noControls"]);
        for (const [error, held] of cases) expect(pluginMessageSchema.safeParse({ type: "status", ...entry.describe(error, held) }).success).toBe(true);
        // The service's own name is only in the English words, so that one stays uncoded.
        expect(entry.describe("notFound", { ownership: { state: "unknown", service: "Foo" } }).code).toBeUndefined();
        // Its own sentences ship in its manifest, in every language; the page has only the shared ones.
        const manifest = readPluginManifest(JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")));
        expect(Object.keys(manifest?.statusTexts ?? {}).sort()).toEqual(["herculesApp", "herculesDriver", "perAppNeedsMacos", "perAppNotAllowed"]);
        for (const [error, held] of cases) {
            const said = entry.describe(error, held);
            const text = said.code ? manifest?.statusTexts?.[said.code] : undefined;
            if (!text) continue;
            expect(Object.keys(text).sort()).toEqual(["en-US", "es-ES"]);
            expect(text["en-US"]).toBe(said.detail);
        }
        for (const access of ["needsNewerMacos", "notAllowed"]) {
            const said = entry.connectedStatus(access);
            expect(manifest?.statusTexts?.[said.code ?? ""]?.["en-US"]).toBe(said.detail);
        }
    });

    it("reports in, call actions out to the app, under the names the app knows", async () => {
        const report = new Uint8Array(11);
        const fake = fakeNative([{ error: "notFound" }, { report }], [["call.hangup", "call.mic"]]);
        const { port, sent, deliver } = fakePort();
        const exit = vi.fn();
        entry.run({ port, native: fake.native, now: () => 1_000, sleep: () => Promise.resolve(), exit });
        deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: { knob1: "music" } });
        await flush();

        for (const message of sent) expect(pluginMessageSchema.safeParse(message).success).toBe(true);
        expect(sent[0]).toEqual({ type: "ready" });
        expect(sent).toContainEqual({ type: "status", state: "busy", code: "herculesDriver", detail: "The Stream 100 still has the Hercules driver. It works here once Polaris' driver is on it." });
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

    it("draws the screen in the app's language, or this system's on an app that sends none", async () => {
        const spanish = fakeNative([]);
        const first = fakePort();
        entry.run({ port: first.port, native: spanish.native, every: () => null, exit: vi.fn() });
        first.deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: {}, locale: "es-ES" });
        expect(spanish.setLocale).toHaveBeenCalledWith("es-ES");

        const older = fakeNative([]);
        const second = fakePort();
        entry.run({ port: second.port, native: older.native, every: () => null, exit: vi.fn() });
        second.deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: {} });
        expect(older.setLocale).toHaveBeenCalledWith(Intl.DateTimeFormat().resolvedOptions().locale);
    });

    it("follows the app's call on the call page, and treats a refused or older app as no call", async () => {
        const fake = fakeNative([]);
        const { port, sent, deliver } = fakePort();
        const ticks: (() => void)[] = [];
        entry.run({ port, native: fake.native, every: (tick: () => void) => ticks.push(tick), exit: vi.fn() });
        deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: ["polaris-actions"], devices: [], settings: { display: "call" } });
        const asked = () => sent.filter((message) => (message as { method?: string; }).method === "polaris.state") as { id: number; }[];
        expect(asked()).toHaveLength(1);
        for (const message of sent) expect(pluginMessageSchema.safeParse(message).success).toBe(true);
        const call = { participants: [{ id: "u1", name: "Ana", speaking: true, muted: false, deafened: false }], selfMuted: true, selfDeafened: false };
        deliver({ type: "reply", id: asked()[0]!.id, ok: true, value: { call } });
        await flush();
        expect(fake.setCall).toHaveBeenLastCalledWith(JSON.stringify(call));

        ticks[0]!();
        deliver({ type: "reply", id: asked()[1]!.id, ok: false, error: "unknown-method" });
        await flush();
        expect(fake.setCall).toHaveBeenLastCalledWith("null");
        // Never reads what is playing on the call page.
        expect(fake.nowPlaying).not.toHaveBeenCalled();
    });

    it("shows what the system says is playing on the now-playing page, and nothing when it cannot say", async () => {
        const answers = [async () => JSON.stringify({ title: "Canción", artist: "Rosalía", playing: true }), async () => { throw new Error("no bus"); }];
        const fake = fakeNative([], [], () => answers.shift()!());
        const { port, sent, deliver } = fakePort();
        const ticks: (() => void)[] = [];
        entry.run({ port, native: fake.native, every: (tick: () => void) => ticks.push(tick), exit: vi.fn() });
        deliver({ type: "start", id: "hercules-stream100", version: "0.1.0", permissions: [], devices: [], settings: { display: "nowPlaying" } });
        await flush();
        expect(fake.setNowPlaying).toHaveBeenLastCalledWith(JSON.stringify({ title: "Canción", artist: "Rosalía", playing: true }));
        ticks[0]!();
        await flush();
        expect(fake.setNowPlaying).toHaveBeenLastCalledWith("null");
        expect(sent).toContainEqual({ type: "log", level: "warn", text: "could not read what is playing: no bus" });
        // The mixer page reads neither.
        deliver({ type: "settings", settings: { display: "mixer" } });
        ticks[0]!();
        await flush();
        expect(fake.nowPlaying).toHaveBeenCalledTimes(2);
        expect(sent.some((message) => (message as { method?: string; }).method === "polaris.state")).toBe(false);
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
        const manifest = readPluginManifest(JSON.parse(readFileSync(new URL("manifest.json", folder), "utf8")))!;
        const root = fileURLToPath(new URL("any/", folder));
        const view = createRequire(import.meta.url)(fileURLToPath(new URL("any/view/view.js", folder))) as {
            wordsFor(locale: string): { categories: Record<string, string>; displays: Record<string, string>; caption: string; driver: Record<string, unknown> & { failed: Record<string, string> } };
            readDriver(value: unknown): { state: string; hercules: boolean; installed: boolean; failure: string | null } | null;
            driverSentence(driver: unknown): string | null;
            DRIVER_FAILURES: readonly string[];
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

        it("says where the driver stands only where the app says it is needed, in both languages", () => {
            expect(view.readDriver(null)).toBeNull();
            expect(view.readDriver({ state: "other" })).toBeNull();
            // Missing with no failure: the app is setting it up by itself, Hercules driver or not.
            expect(view.driverSentence(view.readDriver({ state: "needed", hercules: true }))).toBe("settingUp");
            expect(view.driverSentence(view.readDriver({ state: "needed", hercules: false }))).toBe("settingUp");
            expect(view.driverSentence(view.readDriver({ state: "repair" }))).toBe("repair");
            // Declined or failed: what does not work, beside the reason and the page's action.
            expect(view.driverSentence(view.readDriver({ state: "needed", hercules: true, failure: "declined" }))).toBe("stopped");
            expect(view.driverSentence(view.readDriver({ state: "repair", failure: "binding" }))).toBe("stopped");
            expect(view.driverSentence(view.readDriver({ state: "installed" }))).toBe("installed");
            expect(view.driverSentence(view.readDriver({ state: "notNeeded" }))).toBeNull();
            expect(view.driverSentence(view.readDriver({ state: "unplugged", installed: true }))).toBeNull();
            expect(view.driverSentence(view.readDriver({ state: "unplugged", installed: false }))).toBe("unplugged");
            expect(view.readDriver({ state: "needed" })?.failure).toBeNull();
            expect(view.readDriver({ state: "needed", failure: "declined" })?.failure).toBe("declined");
            expect(view.readDriver({ state: "needed", failure: "C:\secret" })?.failure).toBe("failed");
            const en = view.wordsFor("en-US").driver;
            const es = view.wordsFor("es-ES").driver;
            expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
            expect(Object.keys(en.failed).sort()).toEqual([...view.DRIVER_FAILURES].sort());
            expect(Object.keys(es.failed).sort()).toEqual([...view.DRIVER_FAILURES].sort());
        });

        it("never asks for a manual install, and names the page's action as the manifest labels it", () => {
            const label = manifest.requires["win32-x64"]!.find((item) => item.key === "driver")!.label;
            const texts = (driver: Record<string, unknown> & { failed: Record<string, string> }) => [...Object.values(driver).filter((value): value is string => typeof value === "string"), ...Object.values(driver.failed)];
            const statuses = Object.values(manifest.statusTexts ?? {});
            const missing = manifest.requires["win32-x64"]!.map((item) => item.missing!);
            for (const [locale, driver] of [["en-US", view.wordsFor("en-US").driver], ["es-ES", view.wordsFor("es-ES").driver]] as const) {
                const all = [...texts(driver), ...statuses.map((text) => text[locale]!), ...missing.map((text) => text[locale]!)];
                for (const text of all) expect(text, text).not.toMatch(/from this page|desde esta página|reinstall|reinstala|install it|instálalo/i);
                for (const text of Object.values(driver.failed)) expect(text, text).toContain(label[locale]!);
            }
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

describe("the header while per-app volume cannot be used", () => {
    it("says why on macOS, and nothing when it can", () => {
        expect(entry.connectedStatus("ready")).toEqual({ state: "connected" });
        expect(entry.connectedStatus("needsNewerMacos")).toMatchObject({ state: "connected", code: "perAppNeedsMacos" });
        expect(entry.connectedStatus("notAllowed")).toMatchObject({ state: "connected", code: "perAppNotAllowed" });
        expect(entry.connectedStatus("notAsked")).toMatchObject({ state: "connected", code: "perAppNotAllowed" });
        for (const access of ["needsNewerMacos", "notAllowed"]) expect(pluginMessageSchema.safeParse({ type: "status", ...entry.connectedStatus(access) }).success).toBe(true);
    });
});
