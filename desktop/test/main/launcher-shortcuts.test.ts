/**
 * The launcher lists the programs of the Start menu and leaves out what an
 * installer drops beside them: its uninstaller and links to its documents and
 * web pages. Electron, the file system and the stores are stand-ins.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openPath: vi.fn(), openExternal: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/main/launcher-stores", () => ({ storeApps: vi.fn(async () => []), isPackagedAppId: () => true, isVettedLaunchUri: () => true }));

const { isProgramShortcut } = await import("../../src/main/launcher-apps");

describe("Start menu shortcuts", () => {
    it("leaves out uninstallers, documents and web pages, named as installers name them", () => {
        for (const label of [
            "Uninstall",
            "Uninstall Telegram",
            "Uninstall3uTools",
            "Git Release Notes",
            "Git FAQs (Frequently Asked Questions)",
            "Node.js documentation",
            "Node.js website",
            "Strawberry Perl README",
            "Python 3.14 Manuals",
            "User manual (PDF, English)",
            "License (English)",
            "Inno Setup Revision History",
            "Inno Setup Example Scripts",
            "Steam Support Center"
        ]) expect(isProgramShortcut(label), label).toBe(false);
    });

    it("keeps programs, including ones whose names merely contain those words", () => {
        for (const label of ["Telegram", "Inno Setup Compiler", "Visual Studio Installer", "Fortnite", "Phasmophobia", "Documents", "Manually Tracked", "Licensed Tool"]) {
            expect(isProgramShortcut(label), label).toBe(true);
        }
    });
});
