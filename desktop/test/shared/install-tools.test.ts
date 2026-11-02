/**
 * The page names a tool and the app decides what runs: only the official scripts,
 * started with no shell on Windows, and a refusal is told from a real install.
 */

import { describe, expect, it } from "vitest";
import {
    browserFromName,
    extensionsPageLaunch,
    installable,
    installedPath,
    installLaunch,
    installRequestSchema,
    lastSaid,
    repositorySlug
} from "@/shared/install-tools";

const REPO = "example/polaris";

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

describe("whether it worked", () => {
    it("looks where each script installs", () => {
        const windows = { home: "C:\\Users\\fixture", localAppData: "C:\\Local", appData: "C:\\Roaming" };
        expect(installedPath("extension", "win32", windows)).toBe("C:\\Local\\Polaris\\extension\\chrome");
        expect(installedPath("cli", "win32", windows)).toBe("C:\\Local\\Programs\\polaris-cli");
        expect(installedPath("deck", "win32", windows)).toContain("C:\\Roaming\\Elgato\\StreamDeck\\Plugins");
        expect(installedPath("cli", "linux", { home: "/home/fixture" })).toBe("/home/fixture/.local/share/polaris-cli");
        expect(installedPath("extension", "darwin", { home: "/Users/fixture" })).toBe(
            "/Users/fixture/Library/Application Support/Polaris/extension/chrome"
        );
    });

    it("says what the script said when it refused", () => {
        expect(lastSaid("polaris: fetching\r\npolaris: Node 20 or newer is required\r\n+----+\r\n")).toBe(
            "Node 20 or newer is required"
        );
        expect(lastSaid("\n\n")).toBeNull();
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
