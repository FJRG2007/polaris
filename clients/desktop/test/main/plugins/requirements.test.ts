import { describe, expect, it, vi } from "vitest";
import { readPluginManifest, type PluginManifest } from "@polaris/core/device-plugins";
import { createRequirements, type RequirementLook, type RequirementOutcome } from "../../../src/main/plugins/requirements";

const MANIFEST = {
    requires: {
        "win32-x64": [
            {
                key: "driver",
                label: { "en-US": "Install a driver", "es-ES": "Instalar un driver" },
                missing: { "en-US": "The driver is not set up.", "es-ES": "El driver no está instalado." },
                restored: { "en-US": "The driver is back.", "es-ES": "El driver ha vuelto." }
            }
        ]
    }
} as Pick<PluginManifest, "requires">;

function setup(options: { look?: RequirementLook; outcome?: RequirementOutcome; kept?: unknown; platform?: "win32-x64" | "linux-x64"; } = {}) {
    let look: RequirementLook = options.look ?? { state: "missing", before: false };
    let stored: unknown = options.kept ?? {};
    const runner = {
        look: vi.fn(async () => look),
        setUp: vi.fn(async (): Promise<RequirementOutcome> => {
            const outcome = options.outcome ?? { ok: true };
            if (outcome.ok) look = { state: "met", before: true };
            return outcome;
        })
    };
    const restored = vi.fn();
    const changed = vi.fn();
    const requirements = createRequirements({
        platform: options.platform ?? "win32-x64",
        runnerFor: (id, key) => (id === "pad" && key === "driver" ? runner : null),
        read: async () => stored,
        write: async (value) => {
            stored = value;
        },
        changed,
        restored
    });
    return { requirements, runner, restored, changed, stored: () => stored, setLook: (next: RequirementLook) => (look = next) };
}

describe("plugin requirements", () => {
    it("are read from the manifest per platform, and a manifest without them still reads", () => {
        const base = { schema: 1, id: "pad", name: "Pad", version: "1.0.0", publisher: "P", summary: "S", category: "devices", minAppVersion: "0.1.0", entries: { "linux-x64": "main.cjs" } };
        expect(readPluginManifest(base)?.requires).toEqual({});
        expect(readPluginManifest({ ...base, ...MANIFEST })?.requires["win32-x64"]?.[0]?.key).toBe("driver");
        expect(readPluginManifest({ ...base, requires: { "win32-x64": [MANIFEST.requires["win32-x64"]![0], MANIFEST.requires["win32-x64"]![0]] } })).toBeNull();
    });

    it("set up what the install consented to, and offer nothing after", async () => {
        const { requirements, runner, restored, stored } = setup();
        await requirements.consent("pad", ["driver"]);
        await requirements.ensure("pad", MANIFEST, "install");
        expect(runner.setUp).toHaveBeenCalledTimes(1);
        expect(stored()).toEqual({ pad: ["driver"] });
        expect(restored).not.toHaveBeenCalled();
        expect(await requirements.actions("pad", MANIFEST)).toEqual([]);
    });

    it("never set up by themselves without a consent: the page offers them instead (an install from before)", async () => {
        const { requirements, runner } = setup();
        await requirements.ensure("pad", MANIFEST, "start");
        expect(runner.setUp).not.toHaveBeenCalled();
        expect(await requirements.actions("pad", MANIFEST)).toEqual([
            { id: "driver", label: MANIFEST.requires["win32-x64"]![0]!.label, detail: MANIFEST.requires["win32-x64"]![0]!.missing }
        ]);
        expect(await requirements.run("pad", MANIFEST, "driver")).toBe(true);
        expect(runner.setUp).toHaveBeenCalledTimes(1);
        expect(await requirements.actions("pad", MANIFEST)).toEqual([]);
    });

    it("are put back by themselves when something else undid them, and say so", async () => {
        const { requirements, runner, restored } = setup({ look: { state: "missing", before: true } });
        await requirements.ensure("pad", MANIFEST, "plugged");
        expect(runner.setUp).toHaveBeenCalledTimes(1);
        expect(restored).toHaveBeenCalledWith("pad", MANIFEST.requires["win32-x64"]![0]);
    });

    it("do not ask again by themselves after a declined prompt; the page's action asks again", async () => {
        const { requirements, runner } = setup({ outcome: { ok: false, reason: "declined" }, kept: { pad: ["driver"] } });
        await requirements.ensure("pad", MANIFEST, "start");
        await requirements.ensure("pad", MANIFEST, "plugged");
        expect(runner.setUp).toHaveBeenCalledTimes(1);
        expect(requirements.failure("pad", "driver")).toBe("declined");
        expect((await requirements.actions("pad", MANIFEST)).map((item) => item.id)).toEqual(["driver"]);
        expect(await requirements.run("pad", MANIFEST, "driver")).toBe(false);
        expect(runner.setUp).toHaveBeenCalledTimes(2);
    });

    it("wait for an absent device instead of failing, then set up when it is plugged in", async () => {
        const { requirements, runner, setLook } = setup({ look: { state: "away", before: false }, kept: { pad: ["driver"] } });
        await requirements.ensure("pad", MANIFEST, "start");
        expect(runner.setUp).not.toHaveBeenCalled();
        expect(await requirements.actions("pad", MANIFEST)).toEqual([]);
        setLook({ state: "missing", before: false });
        await requirements.ensure("pad", MANIFEST, "plugged");
        expect(runner.setUp).toHaveBeenCalledTimes(1);
    });

    it("are nothing on a platform the manifest names none for, and for an unknown runner", async () => {
        const linux = setup({ platform: "linux-x64", kept: { pad: ["driver"] } });
        await linux.requirements.ensure("pad", MANIFEST, "start");
        expect(linux.runner.look).not.toHaveBeenCalled();
        expect(await linux.requirements.actions("pad", MANIFEST)).toEqual([]);
        expect(await linux.requirements.run("pad", MANIFEST, "driver")).toBe(false);
        const other = setup();
        await other.requirements.ensure("other", MANIFEST, "start");
        expect(await other.requirements.actions("other", MANIFEST)).toEqual([]);
        expect(await other.requirements.run("pad", MANIFEST, "missing")).toBe(false);
    });

    it("read a damaged consent file as none, and forget an uninstalled plugin", async () => {
        const damaged = setup({ kept: "garbage" });
        await damaged.requirements.ensure("pad", MANIFEST, "start");
        expect(damaged.runner.setUp).not.toHaveBeenCalled();
        const kept = setup({ kept: { pad: ["driver"], other: ["x"] } });
        await kept.requirements.forget("pad");
        expect(kept.stored()).toEqual({ other: ["x"] });
    });
});
