/**
 * The Polaris folder: the key goes to the profile bundled for its deck, or
 * back from it, and every bundled profile is one the manifest declares, built
 * as a ZIP the Stream Deck app can read, holding only this plugin's keys.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FOLDER_PROFILES, folderTarget } from "../src/folder";
// @ts-expect-error - a build script in plain JavaScript, without types.
import { DECKS, profileFiles, stableUuid, zip } from "../scripts/profiles.mjs";

type Deck = {
    profile: string;
    deviceType: number;
    model: string;
    keys: unknown[][];
    dials?: unknown[];
};
type Placed = { UUID: string; Settings: Record<string, unknown>; Plugin: { Version: string } };
type Page = { Controllers: { Type: string; Actions: Record<string, Placed> | null }[] };

const SD_PLUGIN = join(__dirname, "..", "io.github.fjrg2007.polaris.sdPlugin");
const manifest = JSON.parse(readFileSync(join(SD_PLUGIN, "manifest.json"), "utf8")) as {
    Version: string;
    Actions: { UUID: string; Controllers: string[] }[];
    Profiles: { Name: string; DeviceType: number; AutoInstall: boolean }[];
};
const decks = DECKS as Deck[];

/** The entries of a ZIP, read back the way any reader would. */
function unzip(bytes: Buffer): Map<string, string> {
    const files = new Map<string, string>();
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let at = bytes.readUInt32LE(end + 16);
    for (let n = bytes.readUInt16LE(end + 10); n > 0; n--) {
        expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
        const method = bytes.readUInt16LE(at + 10);
        const size = bytes.readUInt32LE(at + 20);
        const nameLength = bytes.readUInt16LE(at + 28);
        const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
        const offset = bytes.readUInt32LE(at + 42);
        const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
        const start =
            offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
        const raw = bytes.subarray(start, start + size);
        files.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
        at += 46 + nameLength + extra;
    }
    return files;
}

describe("the folder key", () => {
    it("opens the profile for its deck, and goes back from inside it", () => {
        expect(folderTarget({}, 2)).toEqual({ to: "profile", profile: "profiles/polaris-xl" });
        expect(folderTarget({}, 7)).toEqual({ to: "profile", profile: "profiles/polaris-plus" });
        expect(folderTarget({ back: true }, 2)).toEqual({ to: "back" });
    });

    it("has nowhere to go on a deck no profile is made for", () => {
        // The Stream Deck Mobile and Pedal have no bundled profile.
        expect(folderTarget({}, 3)).toEqual({ to: "none" });
        expect(folderTarget({}, 5)).toEqual({ to: "none" });
    });
});

describe("the bundled profiles", () => {
    it("are the ones the manifest declares, installed only when first opened", () => {
        const declared = Object.fromEntries(manifest.Profiles.map((p) => [p.DeviceType, p.Name]));
        const built = Object.fromEntries(decks.map((d) => [d.deviceType, d.profile]));
        expect(declared).toEqual(FOLDER_PROFILES);
        expect(built).toEqual(FOLDER_PROFILES);
        for (const p of manifest.Profiles) expect(p.AutoInstall).toBe(false);
    });

    it("come out the same byte for byte on every build", () => {
        for (const deck of decks) {
            const once = zip(profileFiles(deck, manifest.Version)) as Buffer;
            const again = zip(profileFiles(deck, manifest.Version)) as Buffer;
            expect(once.equals(again)).toBe(true);
        }
        expect(stableUuid("a")).toBe(stableUuid("a"));
        expect(stableUuid("a")).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
    });

    it("read back as a profile of this plugin's own keys, with the way back first", () => {
        const actions = new Map(manifest.Actions.map((a) => [a.UUID, a.Controllers]));
        for (const deck of decks) {
            const files = unzip(zip(profileFiles(deck, manifest.Version)) as Buffer);
            const pkg = JSON.parse(files.get("package.json")!) as { DeviceModel: string };
            expect(pkg.DeviceModel).toBe(deck.model);

            const roots = [...files.keys()].filter((n) =>
                /^Profiles\/[^/]+\.sdProfile\/manifest\.json$/.test(n)
            );
            expect(roots).toHaveLength(1);
            const root = JSON.parse(files.get(roots[0]!)!) as {
                Device: { Model: string };
                Pages: { Default: string; Pages: string[] };
            };
            expect(root.Device.Model).toBe(deck.model);
            const dir = roots[0]!.replace("manifest.json", "Profiles/");
            for (const id of [root.Pages.Default, ...root.Pages.Pages])
                expect(files.has(`${dir}${id.toUpperCase()}/manifest.json`)).toBe(true);

            const page = JSON.parse(
                files.get(`${dir}${root.Pages.Pages[0]!.toUpperCase()}/manifest.json`)!
            ) as Page;
            const keypad = page.Controllers.find((c) => c.Type === "Keypad")!.Actions!;
            expect(keypad["0,0"]?.UUID).toBe("io.github.fjrg2007.polaris.folder");
            expect(keypad["0,0"]?.Settings).toEqual({ back: true });

            for (const controller of page.Controllers) {
                for (const [at, placed] of Object.entries(controller.Actions ?? {})) {
                    // Every key is an action this plugin has, on a controller it runs on.
                    expect(actions.get(placed.UUID)).toContain(controller.Type);
                    expect(placed.Plugin.Version).toBe(manifest.Version);
                    const [x, y] = at.split(",").map(Number);
                    const rows = controller.Type === "Keypad" ? deck.keys : [deck.dials!];
                    expect(rows[y!]?.[x!]).toBeTruthy();
                }
            }
            expect(page.Controllers.some((c) => c.Type === "Encoder")).toBe(Boolean(deck.dials));
        }
    });
});
