import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginChild } from "@/main/plugins/supervisor";
import { GLANCE_SOURCE, parseGlance } from "@/main/game-detect";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createPluginManager, NO_PROFILE_SIGNALS } from "@/main/plugins/manager";
import type { PluginProfileSignals, UsbDevice } from "@polaris/core/device-plugins";
import { meetingProgram, watchProfileSignals, PROFILE_GLANCE_MS } from "@/main/plugins/profile-signals";
import { catalogOf, entryFor, fakeFetch, fixturePackage, manifest, PACKAGE_URL, sign, TEST_KEYS } from "./fixtures";

const CATALOG = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/catalog.json";
const DEVICE: UsbDevice = { vendorId: 0x06f8, productId: 0xe053 };
const SETTINGS = [
    ...manifest.settings,
    { kind: "choice", key: "knob1", group: "knobs", label: { "en-US": "Knob 1" }, default: "calls", options: ["calls", "music", "games"].map((value) => ({ value, label: { "en-US": value } })) }
];
const PROFILED = { settings: SETTINGS, profiles: true };

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "plugins-profiles-"));
    dirs.push(dir);
    const bytes = fixturePackage(PROFILED);
    const catalogBytes = new TextEncoder().encode(JSON.stringify(catalogOf([entryFor(bytes, PROFILED as never)])));
    const fetcher = fakeFetch({ [CATALOG]: catalogBytes, [`${CATALOG}.sig`]: sign(catalogBytes), [PACKAGE_URL]: bytes });
    const sent: unknown[] = [];
    let clock = 0;
    let ids = 0;
    const manager = createPluginManager({
        dir,
        platform: "linux-x64",
        appVersion: "0.1.136",
        fetcher,
        keys: TEST_KEYS,
        now: () => clock,
        profileId: () => `p${++ids}`,
        profileReads: { meeting: true, front: true },
        fork: (): PluginChild => ({ postMessage: (message) => sent.push(message), kill: () => undefined, onMessage: () => undefined, onExit: () => undefined }),
        call: async () => null,
        devices: () => [DEVICE]
    });
    await manager.refresh();
    expect(await manager.install("fixture-mixer", ["usb", "polaris-actions"])).toMatchObject({ ok: true });
    const lastSettings = () => [...sent].reverse().find((message) => (message as { type: string; }).type !== "devices") as { settings: Record<string, unknown>; };
    return { manager, dir, sent, lastSettings, tick: (ms: number) => (clock += ms) };
}

const view = async (manager: Awaited<ReturnType<typeof setup>>["manager"]) => (await manager.snapshot()).installed[0]?.profiles;

describe("device plugin profiles in the app", () => {
    it("keeps the settings as they were as Default, and a new profile's changes in its own file", async () => {
        const { manager, dir, lastSettings } = await setup();
        expect(await manager.setSetting("fixture-mixer", "knob1", "music")).toEqual({ lights: true, knob1: "music" });
        expect(await view(manager)).toMatchObject({ list: [], manual: null, active: { id: "default", reason: "default" } });

        expect(await manager.profile("fixture-mixer", { op: "create", name: "Gaming", from: "default" })).toEqual({ ok: true, id: "p1" });
        expect(await manager.profile("fixture-mixer", { op: "pick", profile: "p1" })).toEqual({ ok: true, id: "p1" });
        expect(await manager.setSetting("fixture-mixer", "knob1", "games")).toEqual({ lights: true, knob1: "games" });
        // A setting in no group is one for all profiles: it goes to the settings file.
        expect(await manager.setSetting("fixture-mixer", "lights", false)).toEqual({ lights: false, knob1: "games" });
        expect(lastSettings().settings).toEqual({ lights: false, knob1: "games" });

        // The settings file stays what an app older than profiles reads: Default's values.
        expect(JSON.parse(await readFile(join(dir, "settings", "fixture-mixer.json"), "utf8"))).toEqual({ lights: false, knob1: "music" });
        const stored = JSON.parse(await readFile(join(dir, "settings", "fixture-mixer.profiles.json"), "utf8"));
        expect(stored).toMatchObject({ manual: "p1", list: [{ id: "p1", name: "Gaming", values: { knob1: "games" } }] });

        expect(await manager.profile("fixture-mixer", { op: "pick", profile: null })).toEqual({ ok: true, id: null });
        expect(await manager.settings("fixture-mixer")).toEqual({ lights: false, knob1: "music" });
        expect(await manager.profile("fixture-mixer", { op: "create", name: "gaming" })).toEqual({ ok: false, error: "name-taken" });
        expect(await manager.profile("fixture-mixer", { op: "delete", profile: "default" })).toEqual({ ok: false, error: "default" });
        expect(await manager.profile("fixture-mixer", { op: "rename", profile: "nope", name: "X" })).toEqual({ ok: false, error: "not-found" });
        expect(await manager.profile("fixture-mixer", { op: "launch" })).toEqual({ ok: false, error: "bad-request" });
    });

    it("reads an install from before profiles as its Default profile, with nothing lost", async () => {
        const { manager, dir } = await setup();
        await mkdir(join(dir, "settings"), { recursive: true });
        await writeFile(join(dir, "settings", "fixture-mixer.json"), JSON.stringify({ lights: false, knob1: "games" }));
        expect(await manager.settings("fixture-mixer")).toEqual({ lights: false, knob1: "games" });
        expect(await view(manager)).toMatchObject({ list: [], active: { id: "default" } });
    });

    it("switches by the rules once the new choice has held for 2 s, and tells the plugin", async () => {
        const { manager, lastSettings, tick } = await setup();
        await manager.profile("fixture-mixer", { op: "create", name: "Gaming" });
        await manager.profile("fixture-mixer", { op: "rules", profile: "p1", rules: { call: false, meeting: false, game: true, apps: [] } });
        await manager.setSetting("fixture-mixer", "knob1", "music");
        const playing: PluginProfileSignals = { ...NO_PROFILE_SIGNALS, games: ["valorant"] };

        await manager.profileSignals(playing);
        expect((await view(manager))?.active.id).toBe("default");
        tick(1_000);
        await manager.profileSignals(playing);
        expect((await view(manager))?.active.id).toBe("default");
        tick(1_000);
        await manager.profileSignals(playing);
        expect((await view(manager))?.active).toEqual({ id: "p1", reason: "game", subject: "valorant" });
        // Created with the plugin's defaults: knob1 is "calls" in this profile.
        expect(lastSettings().settings).toEqual({ lights: true, knob1: "calls" });

        // A blip back for under 2 s does not switch.
        tick(1_000);
        await manager.profileSignals(NO_PROFILE_SIGNALS);
        tick(500);
        await manager.profileSignals(playing);
        expect((await view(manager))?.active.id).toBe("p1");
        expect(manager.profileNeeds()).toEqual({ meeting: false, front: false });
    });
});

describe("what profiles look at", () => {
    it("reads a glance: the app in front, and who has the microphone", () => {
        const glance = parseGlance("f\tC:\\Games\\Valorant.exe\nm\tC:#Program Files#Zoom#bin#Zoom.exe\nm\tMSTeams_8wekyb3d8bbwe\nnoise\n");
        expect(glance).toEqual({ front: "C:\\Games\\Valorant.exe", microphone: ["C:\\Program Files\\Zoom\\bin\\Zoom.exe", "MSTeams"] });
        expect(parseGlance("")).toEqual({ front: null, microphone: [] });
    });

    it("compiles in the shell: no single quote, registry path and tab escaped for C#", () => {
        expect(GLANCE_SOURCE).not.toContain("'");
        expect(GLANCE_SOURCE).toContain("\"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\CapabilityAccessManager\\\\ConsentStore\\\\microphone\"");
        expect(GLANCE_SOURCE).toContain("o.Append(\"m\\t\")");
    });

    it("does not count this app's own microphone as a meeting", () => {
        expect(meetingProgram(["C:\\Polaris\\Polaris.exe"], "c:\\polaris\\polaris.exe")).toBeNull();
        expect(meetingProgram(["C:\\Polaris\\Polaris.exe", "C:\\Zoom\\Zoom.exe"], "C:\\Polaris\\Polaris.exe")).toBe("zoom");
    });

    it("glances only while a rule needs it, at most every 2 s", async () => {
        let clock = 0;
        let glances = 0;
        let needs = { meeting: false, front: false };
        const pushed: PluginProfileSignals[] = [];
        let tick = () => undefined as void;
        watchProfileSignals(
            {
                inCall: () => true,
                games: () => [],
                glance: async () => {
                    glances++;
                    return { front: "C:\\obs\\obs64.exe", microphone: ["C:\\Zoom\\Zoom.exe"] };
                },
                needs: () => needs,
                ownPath: "C:\\Polaris\\Polaris.exe",
                push: (signals) => pushed.push(signals),
                now: () => clock
            },
            (run) => {
                tick = run;
                return () => undefined;
            }
        );
        expect(glances).toBe(0);
        needs = { meeting: true, front: true };
        tick();
        await new Promise((done) => setTimeout(done, 0));
        clock += 1_000;
        tick();
        expect(glances).toBe(1);
        expect(pushed.at(-1)).toEqual({ call: true, meeting: "zoom", games: [], front: "C:\\obs\\obs64.exe" });
        clock += PROFILE_GLANCE_MS;
        tick();
        expect(glances).toBe(2);
    });
});
