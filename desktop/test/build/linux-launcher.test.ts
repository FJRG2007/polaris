/**
 * The Linux launcher: it starts the real executable with the arguments it was
 * given, and adds --no-sandbox only where user namespaces are refused and the
 * setuid helper cannot stand in for them.
 *
 * The kernel switches it reads are pointed at files here, so each system it
 * decides for can be staged without being that system.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

const { LINUX_LAUNCHER } = createRequire(import.meta.url)("../../build/linux-launcher.cjs") as { LINUX_LAUNCHER: string; };

const SWITCHES = {
    restrict: "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    apparmor: "/sys/module/apparmor/parameters/enabled",
    clone: "/proc/sys/kernel/unprivileged_userns_clone",
    max: "/proc/sys/user/max_user_namespaces"
} as const;

const posix = process.platform !== "win32";

describe.runIf(posix)("the Linux launcher", () => {
    let root: string | null = null;

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = null;
    });

    /** An installed app whose launcher reads its switches from `values`. */
    function install(values: Partial<Record<keyof typeof SWITCHES, string>>): { app: string; launcher: string; } {
        root = mkdtempSync(join(tmpdir(), "polaris-launcher-"));
        const app = join(root, "lib", "polaris-desktop");
        mkdirSync(app, { recursive: true });
        let script = LINUX_LAUNCHER;
        for (const [name, path] of Object.entries(SWITCHES)) {
            const staged = join(root, name);
            const value = values[name as keyof typeof SWITCHES];
            if (value !== undefined) writeFileSync(staged, `${value}\n`);
            script = script.replace(path, staged);
        }
        const launcher = join(app, "polaris");
        writeFileSync(launcher, script, { mode: 0o755 });
        writeFileSync(join(app, "polaris.bin"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
        return { app, launcher };
    }

    function run(launcher: string, env: NodeJS.ProcessEnv = {}): string[] {
        const { APPIMAGE: _ignored, ...base } = process.env;
        return execFileSync(launcher, ["--flag", "a b"], { env: { ...base, ...env }, encoding: "utf8" })
            .split("\n")
            .filter(Boolean);
    }

    it("passes the arguments on untouched where namespaces are allowed", () => {
        const { launcher } = install({ restrict: "0", apparmor: "Y", clone: "1", max: "63000" });
        expect(run(launcher)).toEqual(["--flag", "a b"]);
    });

    it("adds --no-sandbox where AppArmor refuses namespaces and there is no usable helper", () => {
        const { app, launcher } = install({ restrict: "1", apparmor: "Y" });
        expect(run(launcher)).toEqual(["--no-sandbox", "--flag", "a b"]);
        if (process.getuid?.() === 0) return;
        writeFileSync(join(app, "chrome-sandbox"), "");
        chmodSync(join(app, "chrome-sandbox"), 0o4755);
        expect(run(launcher)).toEqual(["--no-sandbox", "--flag", "a b"]);
    });

    it("keeps the sandbox where AppArmor restricts namespaces but is not running", () => {
        const { launcher } = install({ restrict: "1", apparmor: "N" });
        expect(run(launcher)).toEqual(["--flag", "a b"]);
    });

    it("adds --no-sandbox where the kernel refuses namespaces outright", () => {
        expect(run(install({ clone: "0" }).launcher)).toEqual(["--no-sandbox", "--flag", "a b"]);
        expect(run(install({ max: "0" }).launcher)).toEqual(["--no-sandbox", "--flag", "a b"]);
    });

    it("finds the real executable through a link on the PATH", () => {
        const { launcher } = install({ restrict: "1", apparmor: "Y" });
        const bin = join(root as string, "bin");
        mkdirSync(bin);
        symlinkSync(launcher, join(bin, "polaris-desktop"));
        const out = execFileSync("polaris-desktop", ["x"], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
            encoding: "utf8"
        });
        expect(out.split("\n").filter(Boolean)).toEqual(["--no-sandbox", "x"]);
    });
});

describe("the Linux launcher's text", () => {
    it("is one script ending in the exec of the real executable", () => {
        expect(LINUX_LAUNCHER.startsWith("#!/bin/sh\n")).toBe(true);
        expect(LINUX_LAUNCHER.endsWith('exec "$dir/polaris.bin" "$@"\n')).toBe(true);
        expect(LINUX_LAUNCHER).toContain('[ -z "${APPIMAGE:-}" ]');
    });
});
