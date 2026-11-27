import { describe, expect, it } from "vitest";
import * as udev from "../../../src/main/plugins/hercules-udev";
import { driverRunnerFor } from "../../../src/main/plugins/official";
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
        const [{ file, args }] = runs;
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
        expect(runs[0].args).toEqual(["/bin/sh", "-c", udev.REMOVE_SCRIPT]);
        expect(udev.REMOVE_SCRIPT).toContain(`rm -f ${udev.RULE_PATH}`);
    });

    it("reads a dismissed prompt as declined and anything else as failed", async () => {
        expect(await udev.createUdevRunner(fakeHost({ code: 126 }).host).install()).toEqual({ ok: false, reason: "declined" });
        expect(await udev.createUdevRunner(fakeHost({ code: 127 }).host).install()).toEqual({ ok: false, reason: "declined" });
        expect(await udev.createUdevRunner(fakeHost({ code: 1 }).host).install()).toEqual({ ok: false, reason: "failed" });
    });

    it("is needed without the rule, installed with it, and offered again when it was changed", async () => {
        expect(await udev.createUdevRunner(fakeHost({}).host).state()).toEqual({ state: "needed", hercules: false });
        expect(await udev.createUdevRunner(fakeHost({ rule: udev.RULE }).host).state()).toEqual({ state: "installed" });
        expect(await udev.createUdevRunner(fakeHost({ rule: "# edited\n" }).host).state()).toEqual({ state: "repair" });
    });

    it("is what the Stream 100 gets on Linux, and nothing is asked for on macOS", () => {
        const { host } = fakeHost({});
        expect(driverRunnerFor("hercules-stream100", "/plugins", "linux", host)).not.toBeNull();
        expect(driverRunnerFor("hercules-stream100", "/plugins", "darwin", host)).toBeNull();
        expect(driverRunnerFor("another-plugin", "/plugins", "linux", host)).toBeNull();
    });
});
