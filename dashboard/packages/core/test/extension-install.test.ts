/**
 * The line that installs the extension, as both the dashboard and the
 * extension's own popup offer it.
 */

import { describe, expect, it } from "vitest";
import { detectOs, installLine, installShell, repoFromReleaseUrl } from "../src/extension-install";

describe("the install line", () => {
    it("is one line per shell, for the repository it is given", () => {
        expect(installLine("windows", "example-org/example-repo")).toBe(
            "irm https://raw.githubusercontent.com/example-org/example-repo/main/dashboard/apps/extension/scripts/install.ps1 | iex"
        );
        expect(installLine("unix", "example-org/example-repo")).toBe(
            "curl -fsSL https://raw.githubusercontent.com/example-org/example-repo/main/dashboard/apps/extension/scripts/install.sh | sh"
        );
        expect(installShell("windows")).toBe("PowerShell");
        expect(installShell("unix")).toBe("Terminal");
        expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
        expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unix");
    });
});

describe("the repository behind a release page", () => {
    it("is read off a GitHub release address", () => {
        expect(
            repoFromReleaseUrl(
                "https://github.com/example-org/example-repo/releases/tag/extension-v0.1.13"
            )
        ).toBe("example-org/example-repo");
    });

    it("is nothing for any other address", () => {
        expect(repoFromReleaseUrl("https://example.test/releases/extension-v0.2.0")).toBeNull();
        expect(repoFromReleaseUrl("http://github.com/a/b/releases/tag/x")).toBeNull();
        expect(repoFromReleaseUrl("https://github.com/a/b/issues")).toBeNull();
        expect(repoFromReleaseUrl("")).toBeNull();
    });
});
