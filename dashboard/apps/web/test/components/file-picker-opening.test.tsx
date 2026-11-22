// @vitest-environment jsdom

/**
 * The file picker opens on Upload, from every screen.
 *
 * Most of what is attached comes straight off the device, so the shared dialog
 * decides where it opens and no screen gets to choose another tab: a caller
 * that could pass one is a caller that drifts back to Recent.
 */

import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FilePickerDialog, openingTab } from "@/components/file-picker/file-picker-dialog";
import { MessagesWrapper } from "../setup/i18n";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function stubDrive(): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ sources: [], entries: [] }), {
            headers: { "content-type": "application/json" }
        }))
    );
}

/** Every source file under a folder, skipping dependencies and build output. */
function sourcesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
        else if (/\.tsx?$/.test(name)) found.push(path);
    }
    return found;
}

describe("where the file picker opens", () => {
    it("opens on Upload", () => {
        stubDrive();
        render(<FilePickerDialog onPick={() => {}} onClose={() => {}} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("button", { name: "Upload" }).getAttribute("aria-current")).toBe("page");
    });

    it("opens on recent files only where there is no Upload tab", () => {
        expect(openingTab(false)).toBe("upload");
        expect(openingTab(true)).toBe("recent");
    });

    it("is never told to open somewhere else by a screen", () => {
        const apps = join(__dirname, "..", "..", "..");
        const offenders = readdirSync(apps)
            .map((app) => join(apps, app, "src"))
            .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
            .flatMap(sourcesUnder)
            .filter((file) => /<FilePickerDialog\b(?:(?!\/>)[\s\S]){0,800}?\binitialTab\b/.test(readFileSync(file, "utf8")));
        expect(offenders).toEqual([]);
    });
});
