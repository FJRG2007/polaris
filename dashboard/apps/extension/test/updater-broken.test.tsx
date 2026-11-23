// @vitest-environment jsdom

/**
 * What the popup says when the install script's updater has stopped
 * (BUG-0022): the reason in words and the updater's own detail under it, with
 * the update by hand beside it. It never asks for a command to be run.
 */

import { UpdaterBroken } from "../src/entrypoints/popup/updater-broken";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

describe("automatic updates that stopped", () => {
    it("says why, with the updater's own detail", () => {
        render(<UpdaterBroken trouble={{ reason: "digest", detail: "extension-v0.1.281", at: 0 }} />);
        expect(screen.getByText(/Automatic updates are not working: the download did not match/)).toBeTruthy();
        expect(screen.getByText("extension-v0.1.281")).toBeTruthy();
    });

    it("names when an updater that went quiet last ran", () => {
        const at = Date.UTC(2026, 10, 23, 12);
        render(<UpdaterBroken trouble={{ reason: "stopped", detail: null, at }} />);
        const when = new Date(at).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(screen.getByText(new RegExp(`has not run since ${when}`))).toBeTruthy();
    });

    it("shows the update by hand it is given, and no command line or copy button", () => {
        const { container } = render(
            <UpdaterBroken trouble={{ reason: "task", detail: null, at: 0 }}>
                <a href="https://example.test/download">Download</a>
            </UpdaterBroken>
        );
        expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
        expect(container.textContent).not.toMatch(/irm |curl |\| *iex|\| *sh|install line/i);
    });
});
