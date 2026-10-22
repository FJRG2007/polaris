// @vitest-environment jsdom

/**
 * A service's Dependencies panel: rows shaped like the table while it loads,
 * the findings of the latest lockfile scan in the shared vulnerability table,
 * and words for every other state - never checked, checking, a scan that did
 * not finish, a read that failed (with a retry). The findings are fixture data.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const action = vi.fn();

vi.mock("@/app/(app)/apps/deploy/dependency-actions", () => ({
    serviceDependenciesAction: (id: string) => action(id)
}));

import { DependenciesPanel } from "@/app/(app)/apps/deploy/dependencies-panel";

afterEach(() => {
    cleanup();
    action.mockReset();
});

const APP = "0190f7a2-5b1c-7d3e-8f00-1234567890ab";

function scan(state: string) {
    return {
        state,
        createdAt: "2026-10-22T10:00:00.000Z",
        finishedAt: state === "done" ? "2026-10-22T10:03:00.000Z" : null,
        commitSha: "abcdef0123456789",
        files: ["package-lock.json"]
    };
}

function draw() {
    return render(<DependenciesPanel applicationId={APP} />, { wrapper: MessagesWrapper });
}

describe("a service's Dependencies panel", () => {
    it("draws rows shaped like the table while it reads", () => {
        action.mockReturnValue(new Promise(() => undefined));
        const { container } = draw();
        expect(container.querySelectorAll("[data-skeleton-row]").length).toBeGreaterThan(0);
        expect(action).toHaveBeenCalledWith(APP);
    });

    it("lists the latest scan's findings, naming the lockfiles and the commit", async () => {
        action.mockResolvedValue({
            scan: scan("done"),
            findings: [
                {
                    id: "f1",
                    severity: "high",
                    title: "GHSA-fixt-ure0-0001",
                    location: "fixture-lib 1.2.3",
                    fixedIn: "1.2.4",
                    url: "https://github.com/advisories/GHSA-fixt-ure0-0001",
                    layer: null
                }
            ]
        });
        draw();
        expect(await screen.findByText("GHSA-fixt-ure0-0001")).toBeDefined();
        expect(screen.getByText("1.2.4")).toBeDefined();
        expect(screen.getByText(/Read from package-lock\.json/)).toBeDefined();
        expect(screen.getByText(/abcdef0/)).toBeDefined();
        expect(screen.queryByText("Layer")).toBeNull();
    });

    it("says when a clean scan found nothing", async () => {
        action.mockResolvedValue({ scan: scan("done"), findings: [] });
        draw();
        expect(
            await screen.findByText("No known vulnerabilities in its dependencies.")
        ).toBeDefined();
    });

    it("says what is going on before there are findings", async () => {
        action.mockResolvedValueOnce({ scan: null, findings: [] });
        draw();
        expect(await screen.findByText(/Not checked yet/)).toBeDefined();
        cleanup();
        action.mockResolvedValueOnce({ scan: scan("running"), findings: [] });
        draw();
        expect(await screen.findByText(/Checking the lockfiles/)).toBeDefined();
        cleanup();
        action.mockResolvedValueOnce({ scan: scan("failed"), findings: [] });
        draw();
        expect(await screen.findByText(/did not finish/)).toBeDefined();
    });

    it("offers to try again when the read fails", async () => {
        action.mockResolvedValueOnce({ error: "Could not load the dependencies" });
        action.mockResolvedValueOnce({ scan: scan("done"), findings: [] });
        draw();
        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
        await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
        expect(
            await screen.findByText("No known vulnerabilities in its dependencies.")
        ).toBeDefined();
    });
});
