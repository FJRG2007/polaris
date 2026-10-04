/**
 * Telling a machine that runs a Polaris SERVER from one that does not, from
 * what a server install leaves on disk - and never mistaking the CLI's own
 * launchers, or the extension's folder, for it.
 */

import { describe, expect, it } from "vitest";
import type { Host } from "../../src/paths.js";
import { detectServerInstall, serverInstallMessage, type Probe } from "../../src/guard.js";

/** A filesystem that is only the files it is given. */
function fixture(files: Record<string, string>): Probe {
    return {
        exists: (path) => Object.hasOwn(files, path),
        read: (path) => files[path] ?? null
    };
}

const SERVER_SCRIPT =
    "#!/bin/sh\n# polaris - manage a Polaris dashboard deployment. Works on the host\n";
const CLI_LAUNCHER =
    '#!/bin/sh\n# polaris-developer-cli: launcher for the Polaris CLI\nexec node "/home/dev/.local/share/polaris-cli/polaris.mjs" "$@"\n';

const linux: Host = { platform: "linux", env: {}, home: "/home/dev" };
const windows: Host = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", ProgramData: "C:\\ProgramData" },
    home: "C:\\Users\\dev"
};

describe("on Linux and macOS", () => {
    it("finds nothing on a clean machine", () => {
        expect(detectServerInstall(linux, fixture({})).found).toBe(false);
    });

    it("finds the server's own polaris command by its header", () => {
        const found = detectServerInstall(
            linux,
            fixture({ "/usr/local/bin/polaris": SERVER_SCRIPT })
        );
        expect(found.found).toBe(true);
        expect(found.evidence[0]).toContain("/usr/local/bin/polaris");
    });

    it("does not mistake something else called polaris for the server", () => {
        expect(
            detectServerInstall(linux, fixture({ "/usr/local/bin/polaris": CLI_LAUNCHER })).found
        ).toBe(false);
        expect(
            detectServerInstall(
                linux,
                fixture({ "/usr/local/bin/plr": "#!/bin/sh\necho unrelated\n" })
            ).found
        ).toBe(false);
    });

    it("finds the server checkout, wherever POLARIS_INSTALL_DIR puts it", () => {
        expect(
            detectServerInstall(
                linux,
                fixture({ "/opt/polaris/dashboard/docker/docker-compose.yml": "" })
            ).found
        ).toBe(true);
        const moved: Host = { ...linux, env: { POLARIS_INSTALL_DIR: "/srv/polaris" } };
        expect(
            detectServerInstall(
                moved,
                fixture({ "/srv/polaris/dashboard/docker/docker-compose.yml": "" })
            ).found
        ).toBe(true);
    });

    it("finds the server's secrets store", () => {
        expect(
            detectServerInstall(linux, fixture({ "/var/lib/polaris/secrets.env": "" })).found
        ).toBe(true);
    });

    it("names everything it found in the refusal, and what to do instead", () => {
        const found = detectServerInstall(
            linux,
            fixture({ "/usr/local/bin/plr": SERVER_SCRIPT, "/var/lib/polaris/secrets.env": "" })
        );
        const message = serverInstallMessage(found);
        expect(message).toContain("/usr/local/bin/plr");
        expect(message).toContain("/var/lib/polaris/secrets.env");
        expect(message).toContain("another computer");
    });
});

describe("on Windows", () => {
    it("finds the server's polaris.ps1 by its header", () => {
        const found = detectServerInstall(
            windows,
            fixture({
                "C:\\Users\\dev\\AppData\\Local\\Polaris\\bin\\polaris.ps1":
                    "# polaris - manage a Polaris dashboard deployment (Windows PowerShell).\n"
            })
        );
        expect(found.found).toBe(true);
    });

    it("finds the checkout and the secrets store under ProgramData", () => {
        expect(
            detectServerInstall(
                windows,
                fixture({ "C:\\ProgramData\\Polaris\\dashboard\\docker\\docker-compose.yml": "" })
            ).found
        ).toBe(true);
        expect(
            detectServerInstall(windows, fixture({ "C:\\ProgramData\\Polaris\\secrets.env": "" }))
                .found
        ).toBe(true);
    });

    it("leaves the browser extension's folder alone - it is not a server", () => {
        const found = detectServerInstall(
            windows,
            fixture({
                "C:\\Users\\dev\\AppData\\Local\\Polaris\\extension\\chrome\\manifest.json": "{}"
            })
        );
        expect(found.found).toBe(false);
    });
});
