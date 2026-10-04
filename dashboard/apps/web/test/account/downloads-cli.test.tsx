// @vitest-environment jsdom

/**
 * The command line on the downloads screen, and the marks on its pickers.
 *
 * The install line has to carry the address the page is open on - the one the
 * reader has just proven reaches this Polaris - and the right shell for the
 * system picked. And every system and browser in the pickers is shown with its
 * own official mark, which is what somebody scanning a list looks for first.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { PlatformSelect } from "@/components/platform-select";
import { cleanup, render, screen } from "@testing-library/react";
import { cliInstallLine, cliLoginLine } from "@/lib/cli/install-line";
import { detectPlatform, platformShell } from "@/lib/install-platform";
import { CliSection } from "@/app/(app)/account/downloads/cli-section";
import { ExtensionSteps } from "@/app/(app)/account/downloads/extension-steps";

afterEach(cleanup);

const SRC = `${join(__dirname, "..", "..", "src")}/`;

describe("the install line", () => {
    it("is the shell line everywhere but Windows, against this Polaris", () => {
        expect(cliInstallLine("linux", "https://polaris.example.com/")).toEqual({
            shell: "Terminal",
            command: "curl -fsSL https://polaris.example.com/cli/install.sh | sh"
        });
        expect(cliInstallLine("macos", "https://polaris.example.com").command).toBe(
            "curl -fsSL https://polaris.example.com/cli/install.sh | sh"
        );
        expect(cliInstallLine("windows", "https://polaris.example.com")).toEqual({
            shell: "PowerShell",
            command: "irm https://polaris.example.com/cli/install.ps1 | iex"
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
    it("shows the install and sign-in lines for the address the page is open on", () => {
        render(<CliSection />, { wrapper: MessagesWrapper });
        const origin = window.location.origin;
        expect(screen.getByText("Command line")).toBeTruthy();
        // The reader's own system is picked first - which one depends on where
        // this test runs, so the expected line is built the same way.
        const platform = detectPlatform(navigator.userAgent);
        expect(screen.getByText(cliInstallLine(platform, origin).command)).toBeTruthy();
        expect(screen.getByText(`plr login --url ${origin}`)).toBeTruthy();
        // Every line can be copied with one press.
        expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThanOrEqual(3);
    });

    it("says it in Spanish too", () => {
        const html = renderToStaticMarkup(withMessages(<CliSection />, "es-ES"));
        expect(html).toContain("Despliega, lee registros y reinicia tus apps");
        expect(html).toContain("No se instala en un equipo que ejecuta un servidor Polaris");
    });

    it("is on the downloads page, and the CLI is no longer listed as coming later", async () => {
        const page = await readFile(`${SRC}app/(app)/account/downloads/page.tsx`, "utf8");
        expect(page).toContain("<CliSection />");
        expect(page).not.toContain("downloads.later.cli");
    });
});

describe("the marks on the pickers", () => {
    it("draws each system's official mark beside its name", () => {
        const windows = renderToStaticMarkup(
            <PlatformSelect value="windows" onChange={() => undefined} label="System" />
        );
        expect(windows).toContain("Windows");
        expect(windows).toContain('fill="#0078D4"');
        const mac = renderToStaticMarkup(
            <PlatformSelect value="macos" onChange={() => undefined} label="System" />
        );
        expect(mac).toContain("macOS");
        expect(mac).toContain("<svg");
        const linux = renderToStaticMarkup(
            <PlatformSelect value="linux" onChange={() => undefined} label="System" />
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
