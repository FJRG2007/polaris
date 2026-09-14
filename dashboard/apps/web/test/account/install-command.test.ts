/**
 * The one-line install for the browser extension.
 *
 * The scripts existed and nothing in Polaris pointed at them, so the only way
 * offered was the zip and five manual steps - and by hand into a different
 * folder each time, which is what makes updating feel like installing again.
 *
 * What is pinned here is what would be silently wrong: a line built for the
 * wrong shell, a repository baked in rather than passed in, and the guess about
 * which system the reader is on.
 */

import { describe, expect, it } from "vitest";
import { INSTALL_OSES, detectOs, installCommand } from "@/lib/install-command";

const REPO = "example-org/example-repo";

describe("the line that installs the extension", () => {
    it("gives PowerShell its own line and everything else the shell one", () => {
        expect(installCommand("windows", REPO).command).toContain("irm ");
        expect(installCommand("windows", REPO).command).toContain("install.ps1");
        expect(installCommand("unix", REPO).command).toContain("curl -fsSL ");
        expect(installCommand("unix", REPO).command).toContain("install.sh");
    });

    it("never offers a line for the wrong window", () => {
        // Pasting the PowerShell line into a terminal is the mistake this
        // prevents, and it fails in a way that reads like the script is broken.
        expect(installCommand("windows", REPO).shell).toBe("PowerShell");
        expect(installCommand("unix", REPO).command).not.toContain("iex");
        expect(installCommand("windows", REPO).command).not.toContain("curl");
    });

    it("points at the repository it was given, not at the one it was written in", () => {
        // A deployment built from a fork has to hand out its own address.
        for (const os of INSTALL_OSES) {
            const { command } = installCommand(os, REPO);
            expect(command).toContain(`/${REPO}/`);
            expect(command).not.toContain("FJRG2007");
        }
    });

    it("reaches the scripts where they actually live", () => {
        for (const os of INSTALL_OSES) {
            expect(installCommand(os, REPO).command).toContain(
                "/main/dashboard/apps/extension/scripts/"
            );
        }
    });

    it("offers both systems, each named for the reader rather than the kernel", () => {
        expect(INSTALL_OSES.length).toBe(2);
        expect(installCommand("windows", REPO).label).toBe("Windows");
        expect(installCommand("unix", REPO).label).toContain("macOS");
        expect(installCommand("unix", REPO).label).toContain("Linux");
    });
});

describe("guessing the system", () => {
    it("knows Windows", () => {
        expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    });

    it("takes macOS and Linux as the same line, because they are", () => {
        expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("unix");
        expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unix");
    });

    it("falls to the shell line on anything it cannot read", () => {
        // The answer that is right more often, and the picker is one click away
        // either way.
        expect(detectOs("")).toBe("unix");
        expect(detectOs("something nobody has seen")).toBe("unix");
    });
});
