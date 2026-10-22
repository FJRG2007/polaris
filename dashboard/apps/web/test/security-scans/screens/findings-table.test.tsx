// @vitest-environment jsdom
/**
 * The per-image findings table: rows, severity chips, sorting, the filters,
 * the advisory link, copying a package name, and its loading, empty and failed
 * states. Every row below is fixture data.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
    arrangeFindings,
    FindingsTable,
    splitPackage,
    type ImageFinding
} from "@polaris-app/security-scans/src/screens/findings-table";

const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as never;

const FIXTURE: ImageFinding[] = [
    {
        id: "fixture-1",
        severity: "medium",
        title: "CVE-0000-0001",
        location: "fixture-libz 1.0.0",
        fixedIn: null,
        url: null,
        layer: null
    },
    {
        id: "fixture-2",
        severity: "critical",
        title: "CVE-0000-0002",
        location: "fixture-node 22.0.0",
        fixedIn: "22.0.1",
        url: "https://nvd.nist.gov/vuln/detail/CVE-0000-0002",
        layer: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    {
        id: "fixture-3",
        severity: "high",
        title: "GHSA-fixt-ure0-0003",
        location: "fixture-left-pad 0.0.1",
        fixedIn: "0.0.2",
        url: "https://github.com/advisories/GHSA-fixt-ure0-0003",
        layer: null
    }
];

afterEach(cleanup);

const rowIds = () =>
    screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]!.textContent?.split("fixture")[0]);

describe("findings table", () => {
    it("lists the worst first, with chips and the advisory link", () => {
        render(<FindingsTable t={t} findings={FIXTURE} />);
        expect(rowIds()).toEqual(["CVE-0000-0002", "GHSA-fixt-ure0-0003", "CVE-0000-0001"]);
        const link = screen.getByRole("link", { name: /CVE-0000-0002/ });
        expect(link.getAttribute("href")).toBe("https://nvd.nist.gov/vuln/detail/CVE-0000-0002");
        expect(link.getAttribute("rel")).toContain("noopener");
        expect(screen.getAllByText("images.severity.critical").length).toBeGreaterThan(0);
    });

    it("sorts by a column and flips on a second press", () => {
        render(<FindingsTable t={t} findings={FIXTURE} />);
        fireEvent.click(screen.getByRole("button", { name: "findings.package" }));
        expect(rowIds()).toEqual(["GHSA-fixt-ure0-0003", "CVE-0000-0001", "CVE-0000-0002"]);
        fireEvent.click(screen.getByRole("button", { name: "findings.package" }));
        expect(rowIds()).toEqual(["CVE-0000-0002", "CVE-0000-0001", "GHSA-fixt-ure0-0003"]);
    });

    it("filters by severity and by having a fix", () => {
        render(<FindingsTable t={t} findings={FIXTURE} />);
        fireEvent.click(screen.getByRole("button", { name: /images.severity.medium 1/ }));
        expect(rowIds()).toEqual(["CVE-0000-0001"]);
        fireEvent.click(screen.getByRole("switch"));
        expect(screen.getByText("findings.noMatch")).toBeTruthy();
    });

    it("copies a package name", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(<FindingsTable t={t} findings={FIXTURE.slice(1, 2)} />);
        fireEvent.click(screen.getAllByRole("button", { name: /fixture-node/ })[0]!);
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("fixture-node"));
    });

    it("draws skeleton rows while loading, and says when there is nothing or it failed", () => {
        const { container, rerender } = render(<FindingsTable t={t} findings={null} />);
        expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(5);
        rerender(<FindingsTable t={t} findings={[]} />);
        expect(screen.getByText("findings.none")).toBeTruthy();
        const retry = vi.fn();
        rerender(<FindingsTable t={t} findings={null} failed onRetry={retry} />);
        fireEvent.click(screen.getByRole("button", { name: "tryAgain" }));
        expect(retry).toHaveBeenCalled();
    });

    it("arranges without the screen", () => {
        expect(splitPackage("fixture-node 22.0.0")).toEqual({ name: "fixture-node", version: "22.0.0" });
        const fixed = arrangeFindings(FIXTURE, {
            severities: new Set(),
            fixedOnly: true,
            sort: "severity",
            descending: false
        });
        expect(fixed.map((f) => f.id)).toEqual(["fixture-2", "fixture-3"]);
    });
});
