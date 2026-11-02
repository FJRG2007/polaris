/**
 * The page names a tool and the app decides what runs: only the official scripts,
 * started with no shell on Windows, and a refusal is told from a real install.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    browserFromName,
    extensionsPageLaunch,
    installable,
    installedPath,
    installFailure,
    installLaunch,
    installPath,
    installRequestSchema,
    INSTALL_TOOLS,
    lastSaid,
    repositorySlug,
    scriptFinished
} from "@/shared/install-tools";

const REPO = "example/polaris";
const SCRIPTS = {
    extension: "dashboard/apps/extension/scripts",
    cli: "dashboard/packages/cli/scripts",
    deck: "dashboard/apps/streamdeck/scripts"
};

describe("what a page may ask for", () => {
    it("takes a tool from the list and nothing else", () => {
        expect(installRequestSchema.safeParse({ tool: "cli" }).success).toBe(true);
        expect(installRequestSchema.safeParse({ tool: "calc.exe" }).success).toBe(false);
        expect(installRequestSchema.safeParse({ tool: "extension", browser: "x; rm -rf" }).success).toBe(false);
    });

    it("does not offer the deck on Linux", () => {
        expect(installable("deck", "linux")).toBe(false);
        expect(installable("cli", "linux")).toBe(true);
    });
});

describe("how a script starts", () => {
    it("runs the official script on Windows, with the arguments apart", () => {
        const launch = installLaunch("cli", "win32", REPO);
        expect(launch.file).toBe("powershell.exe");
        expect(launch.args.at(-1)).toBe(
            "irm 'https://raw.githubusercontent.com/example/polaris/main/dashboard/packages/cli/scripts/install.ps1' | iex"
        );
    });

    it("runs the official script elsewhere", () => {
        expect(installLaunch("extension", "darwin", REPO).args).toEqual([
            "-c",
            "curl -fsSL 'https://raw.githubusercontent.com/example/polaris/main/dashboard/apps/extension/scripts/install.sh' | sh"
        ]);
    });

    it("reads the repository from package.json's address", () => {
        expect(repositorySlug("https://github.com/example/polaris.git")).toBe(REPO);
        expect(repositorySlug("https://example.test/not-github")).toBeNull();
    });
});

describe("the PATH a script gets", () => {
    it("is the shell's, past anything its startup files print", () => {
        expect(installPath("welcome\n__POLARIS_PATH__/nvm/bin:/usr/bin__POLARIS_PATH__\n", "/usr/bin:/bin")).toBe(
            "/nvm/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
        );
    });

    it("still reaches the usual places when the shell said nothing", () => {
        expect(installPath("", "/usr/bin")).toBe("/usr/bin:/usr/local/bin:/opt/homebrew/bin");
        expect(installPath("", undefined)).toBe("/usr/local/bin:/opt/homebrew/bin");
    });
});

describe("whether it worked", () => {
    it("looks where each script installs", () => {
        const windows = { home: "C:\\Users\\fixture", localAppData: "C:\\Local", appData: "C:\\Roaming" };
        expect(installedPath("extension", "win32", windows)).toBe("C:\\Local\\Polaris\\extension\\chrome");
        expect(installedPath("cli", "win32", windows)).toBe("C:\\Local\\Programs\\polaris-cli\\polaris.mjs");
        expect(installedPath("deck", "win32", windows)).toContain("C:\\Roaming\\Elgato\\StreamDeck\\Plugins");
        expect(installedPath("cli", "linux", { home: "/home/fixture" })).toBe("/home/fixture/.local/share/polaris-cli/polaris.mjs");
        expect(installedPath("extension", "darwin", { home: "/Users/fixture" })).toBe(
            "/Users/fixture/Library/Application Support/Polaris/extension/chrome"
        );
    });

    it("knows the end of every script, on every system", () => {
        for (const tool of INSTALL_TOOLS) {
            for (const file of ["install.ps1", "install.sh"]) {
                const script = readFileSync(join(__dirname, "../../..", SCRIPTS[tool], file), "utf8");
                expect(scriptFinished(tool, script), `${tool} ${file}`).toBe(true);
            }
        }
    });

    it("does not take a refusal for the end", () => {
        expect(scriptFinished("cli", "+  Polaris CLI\n!  polaris-cli: could not find a CLI release\n")).toBe(false);
        expect(scriptFinished("extension", "polaris: could not reach GitHub: timed out\n")).toBe(false);
        expect(scriptFinished("deck", "")).toBe(false);
    });

    it("says what a script said when it refused", () => {
        expect(lastSaid("polaris: fetching\r\npolaris: the download does not match\r\npolaris: \r\n", "/h")).toBe(
            "the download does not match"
        );
        expect(lastSaid("+  Polaris CLI\n!  polaris-cli: node is not installed: https://nodejs.org\n", "/h")).toBe(
            "node is not installed: https://nodejs.org"
        );
    });

    it("keeps a refusal of several lines whole", () => {
        const output = [
            "+  Polaris CLI",
            "!  polaris-cli: this computer runs a Polaris server (a server checkout at /opt/polaris).",
            "!  polaris-cli: the server has its own polaris and plr commands,",
            "!  polaris-cli: so it is not installed here.",
            ""
        ].join("\n");
        expect(lastSaid(output, "/h")).toBe(
            "this computer runs a Polaris server (a server checkout at /opt/polaris). the server has its own polaris and plr commands, so it is not installed here."
        );
    });

    it("does not pass on what PowerShell or curl printed", () => {
        expect(lastSaid("irm : Unable to connect\n    + FullyQualifiedErrorId : WebCmdlet\n", "/h")).toBeNull();
        expect(lastSaid("curl: (6) Could not resolve host\n", "/h")).toBeNull();
        expect(lastSaid("\n\n", "/h")).toBeNull();
    });

    it("keeps this account's folder off the page", () => {
        const output = "!  polaris-cli: this computer runs a Polaris server (C:\\Users\\fixture\\AppData\\polaris.ps1).\n";
        expect(lastSaid(output, "C:\\Users\\fixture")).toBe("this computer runs a Polaris server (~\\AppData\\polaris.ps1).");
    });

    it("gives no sentence when the script ended but the tool is not there", () => {
        const output = "polaris: Next: open the Stream Deck app, find Polaris in the actions list\n";
        expect(installFailure("deck", output, "/h")).toEqual({ ok: false, reason: "failed" });
    });

    it("hands a refusal to the page as a reason and its sentence", () => {
        expect(installFailure("cli", "!  polaris-cli: nope\n", "/h")).toEqual({ ok: false, reason: "failed", said: "nope" });
    });
});

describe("the browser", () => {
    it("is named by the default the system reports", () => {
        expect(browserFromName("Google Chrome")).toBe("chrome");
        expect(browserFromName("Brave")).toBe("brave");
        expect(browserFromName("Microsoft Edge")).toBe("edge");
        expect(browserFromName("Opera Internet Browser")).toBe("opera");
        expect(browserFromName("Firefox")).toBeNull();
    });

    it("opens on its own extensions page", () => {
        expect(extensionsPageLaunch("brave", "darwin")).toEqual({
            file: "/usr/bin/open",
            args: ["-a", "Brave Browser", "brave://extensions"]
        });
        expect(extensionsPageLaunch("edge", "win32").args.at(-1)).toBe("Start-Process 'msedge' 'edge://extensions'");
    });
});
