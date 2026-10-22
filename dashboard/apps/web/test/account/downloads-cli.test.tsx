// @vitest-environment jsdom

/**
 * The command line on the downloads screen, and the marks on its pickers.
 *
 * The install line is the official one from the repository's releases, the
 * same on every Polaris, in the right shell for the system picked; only the
 * sign-in line carries this Polaris's address. And every system and browser in the pickers is shown with its
 * own official mark, which is what somebody scanning a list looks for first.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { PlatformSelect } from "@/components/platform-select";
import { cleanup, render, screen } from "@testing-library/react";
import { cliInstallLine, cliLoginLine } from "@/lib/cli/install-line";
import { detectPlatform, platformShell } from "@/lib/install-platform";
import { CliSection } from "@/app/(app)/account/downloads/cli-section";
import { ExtensionSteps } from "@/app/(app)/account/downloads/extension-steps";

afterEach(cleanup);

/** What the picker reports a choice to; these tests only read what it draws. */
const picked = vi.fn();

const SRC = `${join(__dirname, "..", "..", "src")}/`;

const REPO = "example/polaris";
const SCRIPTS = `https://raw.githubusercontent.com/${REPO}/main/dashboard/packages/cli/scripts`;

describe("the install line", () => {
    it("is the repository's own script, the shell one everywhere but Windows", () => {
        expect(cliInstallLine("linux", REPO)).toEqual({
            shell: "Terminal",
            command: `curl -fsSL ${SCRIPTS}/install.sh | sh`
        });
        expect(cliInstallLine("macos", REPO).command).toBe(`curl -fsSL ${SCRIPTS}/install.sh | sh`);
        expect(cliInstallLine("windows", REPO)).toEqual({
            shell: "PowerShell",
            command: `irm ${SCRIPTS}/install.ps1 | iex`
        });
        expect(cliLoginLine("http://polaris.local/")).toBe("plr login --url http://polaris.local");
    });

    it("puts the reader's own system first", () => {
        expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
        expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
        expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
        expect(detectPlatform("")).toBe("linux");
        expect(platformShell("macos")).toBe("unix");
    });
});

describe("the CLI card", () => {
    it("shows both official install lines, the reader's system first, then signs in to this Polaris", () => {
        render(<CliSection repo={REPO} serverUrl="https://polaris.example.com/" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Command line")).toBeTruthy();
        // A row per shell, so a line for another machine is never hidden.
        const unix = cliInstallLine("linux", REPO).command;
        const windows = cliInstallLine("windows", REPO).command;
        expect(screen.getByText(unix)).toBeTruthy();
        expect(screen.getByText(windows)).toBeTruthy();
        expect(screen.getByText("Terminal")).toBeTruthy();
        expect(screen.getByText("PowerShell")).toBeTruthy();
        expect(screen.getByText("macOS and Linux")).toBeTruthy();
        // The reader's own system is first - which one depends on where this
        // test runs, so the expected order is worked out the same way.
        const first = detectPlatform(navigator.userAgent) === "windows" ? windows : unix;
        const lines = [...document.querySelectorAll("code")].map((node) => node.textContent);
        expect(lines[0]).toBe(first);
        expect(screen.getByText("Install")).toBeTruthy();
        expect(screen.getByText("Sign in")).toBeTruthy();
        expect(screen.getByText("Try")).toBeTruthy();
        expect(screen.getByText("plr login --url https://polaris.example.com")).toBeTruthy();
        // The drawing at the foot of the card shows it too, hidden from readers.
        expect(screen.getByText("plr projects", { selector: "code" })).toBeTruthy();
        // Every line can be copied with one press.
        expect(screen.getAllByRole("button", { name: /copy/i })).toHaveLength(4);
    });

    it("signs in to the address the page is open on when none is configured", () => {
        render(<CliSection repo={REPO} serverUrl={null} />, { wrapper: MessagesWrapper });
        expect(screen.getByText(`plr login --url ${window.location.origin}`)).toBeTruthy();
    });

    it("draws the install line on the server, before anything is read in the browser", () => {
        const html = renderToStaticMarkup(
            withMessages(<CliSection repo={REPO} serverUrl="https://polaris.example.com" />)
        );
        expect(html).toContain(`curl -fsSL ${SCRIPTS}/install.sh | sh`);
        expect(html).toContain(`irm ${SCRIPTS}/install.ps1 | iex`);
        expect(html).toContain("plr login --url https://polaris.example.com");
        expect(html).not.toContain("/cli/install");
    });

    it("says it in Spanish too", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <CliSection repo={REPO} serverUrl="https://polaris.example.com" />,
                "es-ES"
            )
        );
        expect(html).toContain("Despliega, lee registros y reinicia tus apps");
        expect(html).toContain("No se instala en un equipo que ejecuta un servidor Polaris");
    });

    it("is on the downloads page, and the CLI is no longer listed as coming later", async () => {
        const page = await readFile(`${SRC}app/(app)/account/downloads/page.tsx`, "utf8");
        expect(page).toContain("<CliSection repo={repo} serverUrl={serverUrl} />");
        expect(page).not.toContain("downloads.later.cli");
    });
});

describe("the marks on the pickers", () => {
    it("draws each system's official mark beside its name", () => {
        const windows = renderToStaticMarkup(
            <PlatformSelect value="windows" onChange={picked} label="System" />
        );
        expect(windows).toContain("Windows");
        expect(windows).toContain('fill="#0078D4"');
        const mac = renderToStaticMarkup(
            <PlatformSelect value="macos" onChange={picked} label="System" />
        );
        expect(mac).toContain("macOS");
        expect(mac).toContain("<svg");
        const linux = renderToStaticMarkup(
            <PlatformSelect value="linux" onChange={picked} label="System" />
        );
        expect(linux).toContain("Linux");
        expect(linux).toContain("<svg");
        // Apple's and Tux's marks follow the text colour, so they read on a
        // dark surface as well as a light one.
        expect(mac).toContain('fill="currentColor"');
        expect(linux).toContain('fill="currentColor"');
    });

    it("draws the browser's own mark in the browser picker", () => {
        const html = renderToStaticMarkup(withMessages(<ExtensionSteps />));
        // Chrome is the starting choice, in its brand blue.
        expect(html).toContain('fill="#4285F4"');
    });
});
