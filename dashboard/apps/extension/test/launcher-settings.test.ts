import { describe, expect, it } from "vitest";
import { LAUNCHER_DEFAULTS } from "@polaris/core/launcher";
import { launcherPatterns, readLauncher, saveLauncher } from "@/lib/launcher-settings";

const WEB = ["https://*/*", "http://*/*"];

describe("launcher registration", () => {
    it("runs on every reachable page but the Polaris instance and skipped sites", () => {
        const settings = { ...LAUNCHER_DEFAULTS, sites: ["github.com"] };
        expect(launcherPatterns(WEB, settings, "https://polaris.example")).toEqual({
            matches: WEB,
            excludeMatches: ["https://polaris.example/*", "*://github.com/*", "*://*.github.com/*"]
        });
    });

    it("keeps to the listed sites in include-only mode", () => {
        const settings = { ...LAUNCHER_DEFAULTS, mode: "only" as const, sites: ["example.com"] };
        expect(launcherPatterns(WEB, settings, null)).toEqual({
            matches: ["*://example.com/*", "*://*.example.com/*"],
            excludeMatches: []
        });
    });

    it("registers nothing when off or without site access", () => {
        expect(launcherPatterns(WEB, { ...LAUNCHER_DEFAULTS, enabled: false }, null).matches).toEqual([]);
        expect(launcherPatterns([], LAUNCHER_DEFAULTS, null).matches).toEqual([]);
        expect(launcherPatterns(["chrome-extension://x/*"], LAUNCHER_DEFAULTS, null).matches).toEqual([]);
    });
});

describe("launcher storage", () => {
    const area = (): { api: unknown; held: Record<string, unknown> } => {
        const held: Record<string, unknown> = {};
        return {
            held,
            api: {
                storage: {
                    local: {
                        get: async (key: string) => ({ [key]: held[key] }),
                        set: async (items: Record<string, unknown>) => void Object.assign(held, items)
                    }
                }
            }
        };
    };

    it("reads the defaults before anything is saved", async () => {
        expect(await readLauncher(area().api)).toEqual(LAUNCHER_DEFAULTS);
    });

    it("saves cleaned settings and reads them back", async () => {
        const { api } = area();
        await saveLauncher(api, { ...LAUNCHER_DEFAULTS, mode: "only", sites: ["https://www.A.com/x"] });
        expect(await readLauncher(api)).toEqual({ ...LAUNCHER_DEFAULTS, mode: "only", sites: ["a.com"] });
    });
});
