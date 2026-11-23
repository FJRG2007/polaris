/**
 * The browser manifests name exactly the allowed extensions and land where
 * each browser reads them, per operating system; the uninstaller takes back
 * everything the app writes.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
    applyManifestPlan,
    idsInManifest,
    manifestFor,
    planManifests,
    planRemoval,
    type ManifestIo,
    type PlanInput
} from "@/main/native-host/manifests";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";

const input = (overrides: Partial<PlanInput>): PlanInput => ({
    platform: "linux",
    home: "/home/someone",
    dataDir: "C:\\Users\\someone\\AppData\\Roaming\\Polaris\\native-host",
    hostPath: "/opt/host",
    chromiumIds: [ID],
    exists: () => true,
    ...overrides
});

describe("the manifest", () => {
    it("lists Chromium extensions by origin, sorted and without repeats, never a wildcard", () => {
        const manifest = manifestFor("chromium", "/opt/host", [OTHER, ID, ID]) as Record<string, unknown>;
        expect(manifest).toEqual({
            name: "local.polaris.desktop",
            description: expect.any(String),
            path: "/opt/host",
            type: "stdio",
            allowed_origins: [`chrome-extension://${ID}/`, `chrome-extension://${OTHER}/`]
        });
        expect(JSON.stringify(manifest)).not.toContain("*");
    });

    it("names the Firefox add-on by its fixed id", () => {
        expect(manifestFor("firefox", "/opt/host", [])).toMatchObject({ allowed_extensions: ["vault@polaris.local"] });
    });

    it("writes no Chromium manifest when no extension is known", () => {
        expect(manifestFor("chromium", "/opt/host", [])).toBeNull();
    });

    it("reads back the ids an earlier manifest allowed, ignoring anything else", () => {
        const text = JSON.stringify({ allowed_origins: [`chrome-extension://${ID}/`, "chrome-extension://*/", "https://x/"] });
        expect(idsInManifest(text)).toEqual([ID]);
        expect(idsInManifest("not json")).toEqual([]);
    });
});

describe("planning on Windows", () => {
    const plan = planManifests(input({ platform: "win32", hostPath: "C:\\app\\resources\\native-host\\polaris-native-host.exe" }));

    it("keeps two manifest files in the app's data folder", () => {
        expect(plan.write.map((item) => item.file)).toEqual([
            "C:\\Users\\someone\\AppData\\Roaming\\Polaris\\native-host\\local.polaris.desktop.chromium.json",
            "C:\\Users\\someone\\AppData\\Roaming\\Polaris\\native-host\\local.polaris.desktop.firefox.json"
        ]);
    });

    it("points each browser's HKCU key at its manifest", () => {
        const keys = Object.fromEntries(plan.registry.map((args) => [args[1], args[args.indexOf("/d") + 1]]));
        const chromium = plan.write[0]?.file;
        const firefox = plan.write[1]?.file;
        expect(keys).toEqual({
            "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\local.polaris.desktop": chromium,
            "HKCU\\Software\\Chromium\\NativeMessagingHosts\\local.polaris.desktop": chromium,
            "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\local.polaris.desktop": chromium,
            "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\local.polaris.desktop": chromium,
            "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\local.polaris.desktop": firefox
        });
        for (const args of plan.registry) expect(args.at(-1)).toBe("/f");
    });

    it("removes the Chromium entries when no extension is known", () => {
        const empty = planManifests(input({ platform: "win32", chromiumIds: [] }));
        expect(empty.remove).toEqual(["C:\\Users\\someone\\AppData\\Roaming\\Polaris\\native-host\\local.polaris.desktop.chromium.json"]);
        expect(empty.registry.filter((args) => args[0] === "delete")).toHaveLength(4);
    });
});

describe("planning on macOS", () => {
    it("writes into each installed browser's NativeMessagingHosts folder", () => {
        const plan = planManifests(input({ platform: "darwin", home: "/Users/someone" }));
        const support = "/Users/someone/Library/Application Support";
        expect(plan.write.map((item) => item.file)).toEqual([
            `${support}/Google/Chrome/NativeMessagingHosts/local.polaris.desktop.json`,
            `${support}/Chromium/NativeMessagingHosts/local.polaris.desktop.json`,
            `${support}/Microsoft Edge/NativeMessagingHosts/local.polaris.desktop.json`,
            `${support}/BraveSoftware/Brave-Browser/NativeMessagingHosts/local.polaris.desktop.json`,
            `${support}/Mozilla/NativeMessagingHosts/local.polaris.desktop.json`
        ]);
        expect(plan.registry).toEqual([]);
    });
});

describe("planning on Linux", () => {
    it("writes only for installed browsers, and removes the rest", () => {
        const installed = new Set(["/home/someone/.config/BraveSoftware/Brave-Browser", "/home/someone/.mozilla"]);
        const plan = planManifests(input({ exists: (dir) => installed.has(dir) }));
        expect(plan.write.map((item) => item.file)).toEqual([
            "/home/someone/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/local.polaris.desktop.json",
            "/home/someone/.mozilla/native-messaging-hosts/local.polaris.desktop.json"
        ]);
        expect(plan.remove).toContain("/home/someone/.config/google-chrome/NativeMessagingHosts/local.polaris.desktop.json");
        expect(JSON.parse(plan.write[0]?.content ?? "")).toMatchObject({ path: "/opt/host", allowed_origins: [`chrome-extension://${ID}/`] });
    });
});

describe("removal", () => {
    it("takes back every key and file on Windows", () => {
        const plan = planRemoval("win32", "", "C:\\data");
        expect(plan.registry).toHaveLength(5);
        expect(plan.registry.every((args) => args[0] === "delete" && args[1]?.startsWith("HKCU\\"))).toBe(true);
        expect(plan.remove).toHaveLength(2);
    });

    it("takes back every file on macOS and Linux", () => {
        expect(planRemoval("linux", "/home/a", "").remove).toHaveLength(5);
        expect(planRemoval("darwin", "/Users/a", "").remove).toHaveLength(5);
    });
});

describe("applying a plan", () => {
    const realIo = (runReg = vi.fn(async () => undefined)): ManifestIo & { runReg: typeof runReg; } => ({
        readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
        writeFile: vi.fn((file: string, content: string) => writeFileSync(file, content)),
        removeFile: (file) => rmSync(file, { force: true }),
        runReg
    });

    it("writes, leaves an unchanged file alone, and removes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-manifests-"));
        const file = join(dir, "a.json");
        const gone = join(dir, "gone.json");
        writeFileSync(gone, "x");
        const io = realIo();
        await applyManifestPlan({ write: [{ file, content: "{}\n" }], remove: [gone], registry: [["add", "HKCU\\X", "/f"]] }, io);
        expect(readFileSync(file, "utf8")).toBe("{}\n");
        expect(existsSync(gone)).toBe(false);
        expect(io.runReg).toHaveBeenCalledOnce();
        await applyManifestPlan({ write: [{ file, content: "{}\n" }], remove: [], registry: [] }, io);
        expect(io.writeFile).toHaveBeenCalledOnce();
    });
});
