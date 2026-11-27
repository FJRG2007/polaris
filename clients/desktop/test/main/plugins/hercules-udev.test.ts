import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as udev from "../../../src/main/plugins/hercules-udev";
import { DRIVER_REQUIREMENT, requirementRunnerFor, UDEV_REQUIREMENT, udevRunnerFor } from "../../../src/main/plugins/official";
import type { OfficialHost } from "../../../src/main/plugins/hercules-official-run";

function fakeHost(answers: { rule?: string | null; code?: number; }) {
    const runs: { file: string; args: readonly string[]; }[] = [];
    const host: OfficialHost = {
        run: async (file, args) => {
            runs.push({ file, args });
            return { code: answers.code ?? 0, stdout: "" };
        },
        launch: async () => false,
        readText: async (path) => (path === udev.RULE_PATH ? (answers.rule ?? null) : null),
        writeText: async () => undefined,
        exists: async () => false,
        sleep: async () => undefined
    };
    return { host, runs };
}

describe("the Stream 100 udev rule", () => {
    it("grants the seat user the controller, before udev turns uaccess into an ACL", () => {
        expect(udev.RULE).toContain('ATTR{idVendor}=="06f8", ATTR{idProduct}=="e053", TAG+="uaccess"');
        expect(udev.RULE_PATH).toMatch(/\/70-[^/]+\.rules$/);
        expect(udev.RULE.endsWith("\n")).toBe(true);
    });

    it("installs with one pkexec prompt, the rule passed as an argument and never spliced into the script", async () => {
        const { host, runs } = fakeHost({});
        await expect(udev.createUdevRunner(host).install()).resolves.toEqual({ ok: true });
        expect(runs).toHaveLength(1);
        const { file, args } = runs[0]!;
        expect(file).toBe("/usr/bin/pkexec");
        expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
        expect(args[2]).toBe(udev.INSTALL_SCRIPT);
        expect(args[2]).not.toContain("uaccess");
        expect(args.slice(3)).toEqual(["sh", udev.RULE]);
        expect(udev.INSTALL_SCRIPT).toContain("udevadm trigger");
    });

    it("removes the rule with one prompt", async () => {
        const { host, runs } = fakeHost({ rule: udev.RULE });
        await expect(udev.createUdevRunner(host).remove()).resolves.toEqual({ ok: true });
        expect(runs[0]!.args).toEqual(["/bin/sh", "-c", udev.REMOVE_SCRIPT]);
        expect(udev.REMOVE_SCRIPT).toContain(`rm -f ${udev.RULE_PATH}`);
    });

    it("reads a dismissed prompt as declined and anything else as failed", async () => {
        expect(await udev.createUdevRunner(fakeHost({ code: 126 }).host).install()).toEqual({ ok: false, reason: "declined" });
        expect(await udev.createUdevRunner(fakeHost({ code: 127 }).host).install()).toEqual({ ok: false, reason: "declined" });
        expect(await udev.createUdevRunner(fakeHost({ code: 1 }).host).install()).toEqual({ ok: false, reason: "failed" });
    });

    it("is missing without the rule, met with it, and set up before when its text was changed", async () => {
        expect(await udev.createUdevRunner(fakeHost({}).host).state()).toEqual({ state: "missing", before: false });
        expect(await udev.createUdevRunner(fakeHost({ rule: udev.RULE }).host).state()).toEqual({ state: "met", before: true });
        expect(await udev.createUdevRunner(fakeHost({ rule: "# edited\n" }).host).state()).toEqual({ state: "missing", before: true });
    });

    it("is the Stream 100's udevRule requirement on Linux only, and the Windows driver stays Windows only", async () => {
        const { host, runs } = fakeHost({});
        const runner = requirementRunnerFor("hercules-stream100", UDEV_REQUIREMENT, "/plugins", "linux", host);
        expect(runner).not.toBeNull();
        await expect(runner!.look()).resolves.toEqual({ state: "missing", before: false });
        await expect(runner!.setUp()).resolves.toEqual({ ok: true });
        expect(runs[0]!.args[2]).toBe(udev.INSTALL_SCRIPT);
        expect(requirementRunnerFor("hercules-stream100", UDEV_REQUIREMENT, "/plugins", "darwin", host)).toBeNull();
        expect(requirementRunnerFor("hercules-stream100", UDEV_REQUIREMENT, "/plugins", "win32", host)).toBeNull();
        expect(requirementRunnerFor("another-plugin", UDEV_REQUIREMENT, "/plugins", "linux", host)).toBeNull();
        expect(requirementRunnerFor("hercules-stream100", DRIVER_REQUIREMENT, "/plugins", "linux", host)).toBeNull();
        expect(udevRunnerFor("hercules-stream100", "darwin", host)).toBeNull();
    });

    it("is what the manifest lists for both Linux packages, in both languages", () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, "../../../../device-plugins/hercules-stream100/manifest.json"), "utf8"));
        for (const platform of ["linux-x64", "linux-arm64"]) {
            const [requirement] = manifest.requires[platform];
            expect(requirement.key).toBe(UDEV_REQUIREMENT);
            expect(Object.keys(requirement.label)).toEqual(["en-US", "es-ES"]);
        }
        // macOS lists recording system audio instead (mac-audio-capture.ts), never the rule.
        expect(manifest.requires["darwin-arm64"]?.map((item: { key: string; }) => item.key)).toEqual(["audioCapture"]);
    });
});
