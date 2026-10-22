// @vitest-environment jsdom

/**
 * An alert's link opens the scan it is about - never a page that shows
 * nothing. A scan that is gone says so; the bare page (old alerts, the nav)
 * shows the newest serious scan, folded; the findings open on the advisories
 * the alert announced, critical first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const focus = vi.fn();
const findings = vi.fn();
const rescan = vi.fn();

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => "en-US" } }
}));
vi.mock("@polaris-app/security-scans/src/actions/security", () => ({
    focusAction: (input: unknown) => focus(input),
    findingsAction: (input: unknown) => findings(input),
    scanImageAction: (input: unknown) => rescan(input),
    scanServerImageAction: async () => ({ ok: true })
}));

import { securityCatalogs } from "@polaris-app/security-scans/messages";
import { pickServer } from "@polaris-app/security-scans/src/screens/security-view";
import { FocusCard, verdictLine } from "@polaris-app/security-scans/src/screens/focus-card";

const t = securityCatalogs.translator("en-US", "security");
const SCAN = "01a1639f-0000-7000-8000-000000000002";
const TARGET = "019f811e-0000-7000-8000-000000000001";

const SCANNED = {
    id: SCAN,
    targetId: TARGET,
    serverName: "lirio",
    serverLocal: true,
    kind: "image",
    subject: "appImage",
    name: "Network filter DNS server",
    applicationId: "a1",
    appHref: "/apps/dns-blocker",
    appGone: false,
    imageId: null,
    imageRef: "spx01/blocky:v0.26",
    source: null,
    state: "done",
    error: null,
    summary: { critical: 1, high: 1, medium: 1, low: 0, total: 3 },
    sbom: false,
    createdAt: new Date("2026-10-22T10:00:00Z"),
    finishedAt: new Date("2026-10-22T10:05:00Z")
};
const FINDINGS = [
    {
        id: "f1",
        severity: "high",
        title: "GO-2026-1",
        location: "stdlib go1.27.1",
        fixedIn: "1.27.2",
        url: null,
        layer: null
    },
    {
        id: "f2",
        severity: "critical",
        title: "GO-2026-6612",
        location: "stdlib go1.27.1",
        fixedIn: "1.27.2",
        url: null,
        layer: null
    },
    {
        id: "f3",
        severity: "medium",
        title: "CVE-2020-1",
        location: "zlib 1.2",
        fixedIn: "1.3",
        url: null,
        layer: null
    }
];

afterEach(() => {
    cleanup();
    focus.mockReset();
    findings.mockReset();
    rescan.mockReset();
});

function show(landing: { target: string | null; scan: string | null; ids: string[] }) {
    const onTarget = vi.fn();
    render(
        <FocusCard
            t={t}
            landing={landing}
            onTarget={onTarget}
            onClose={() => undefined}
            submit={async (work) => void (await work())}
        />
    );
    return onTarget;
}

describe("FocusCard", () => {
    it("opens the alert's scan: its app by today's name, its server, the verdict and the next step", async () => {
        focus.mockResolvedValue({ ok: true, data: SCANNED });
        findings.mockResolvedValue({ ok: true, data: FINDINGS });
        const onTarget = show({ target: TARGET, scan: SCAN, ids: ["GO-2026-6612", "GO-2026-1"] });
        expect(focus).toHaveBeenCalledWith({ scanId: SCAN });
        expect(await screen.findByText("Network filter DNS server")).toBeTruthy();
        expect(onTarget).toHaveBeenCalledWith(TARGET);
        expect(
            await screen.findByText(
                "3 issues (Critical 1, High 1, Medium 1). All of them are fixed in a newer version."
            )
        ).toBeTruthy();
        expect(
            screen.getByText(
                "Update Network filter DNS server to its newest version, then scan again."
            )
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open app" }).getAttribute("href")).toBe(
            "/apps/dns-blocker"
        );
        // Only the announced advisories, the critical one first.
        await waitFor(() => expect(document.querySelectorAll("tr[data-new]").length).toBe(2));
        const rows = [...document.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
        expect(rows[0]).toContain("GO-2026-6612");
        expect(rows.join(" ")).not.toContain("CVE-2020-1");
        expect(screen.getAllByText(t("focus.newBadge")).length).toBe(2);
        // The rest of the scan is one switch away.
        fireEvent.click(screen.getByRole("switch", { name: t("focus.onlyNew") }));
        await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(3));
    });

    it("follows the scan it queued after Scan again, until it finishes", async () => {
        const QUEUED = "01a1639f-0000-7000-8000-000000000009";
        focus.mockImplementation(async ({ scanId }: { scanId: string }) => ({
            ok: true,
            data:
                scanId === QUEUED
                    ? { ...SCANNED, id: QUEUED, state: "queued", finishedAt: null }
                    : SCANNED
        }));
        findings.mockResolvedValue({ ok: true, data: FINDINGS });
        rescan.mockResolvedValue({ ok: true, data: QUEUED });
        show({ target: TARGET, scan: SCAN, ids: [] });
        fireEvent.click(await screen.findByRole("button", { name: t("focus.rescan") }));
        expect(await screen.findByText(t("focus.running"))).toBeTruthy();
        expect(focus).toHaveBeenLastCalledWith({ scanId: QUEUED });
        expect(
            (screen.getByRole("button", { name: t("focus.rescan") }) as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it("says the scan is gone instead of drawing nothing", async () => {
        focus.mockResolvedValue({ ok: true, data: null });
        show({ target: TARGET, scan: SCAN, ids: [] });
        expect(await screen.findByText(t("focus.gone"))).toBeTruthy();
    });

    it("offers a retry when the scan cannot be read", async () => {
        focus.mockResolvedValue({ ok: false, error: "failed" });
        show({ target: null, scan: SCAN, ids: [] });
        expect(await screen.findByText(t("focus.loadFailed"))).toBeTruthy();
        expect(screen.getByRole("button", { name: t("tryAgain") })).toBeTruthy();
    });

    it("on the bare page shows the newest serious scan, folded, and nothing when there is none", async () => {
        focus.mockResolvedValue({ ok: true, data: SCANNED });
        show({ target: null, scan: null, ids: [] });
        expect(focus).toHaveBeenCalledWith({ scanId: null });
        expect(await screen.findByText(t("focus.attention"))).toBeTruthy();
        expect(screen.getByRole("button", { name: t("focus.showFindings") })).toBeTruthy();
        expect(findings).not.toHaveBeenCalled();
        cleanup();
        focus.mockResolvedValue({ ok: true, data: null });
        show({ target: null, scan: null, ids: [] });
        await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
        expect(screen.queryByText(t("focus.gone"))).toBeNull();
    });
});

describe("verdictLine", () => {
    it("reads a clean scan as no known issues", () => {
        expect(verdictLine(t, { total: 0, parts: [], fixable: 0 })).toBe("No known issues.");
    });
});

describe("pickServer", () => {
    const servers = [{ id: "a" }, { id: "b" }];
    it("keeps a linked server, even before the list arrives", () => {
        expect(pickServer(null, "b")).toBe("b");
        expect(pickServer(servers, "b")).toBe("b");
    });
    it("falls back to the first server when the linked one is gone", () => {
        expect(pickServer(servers, "gone")).toBe("a");
        expect(pickServer([], "gone")).toBeNull();
        expect(pickServer(null, null)).toBeNull();
    });
});
