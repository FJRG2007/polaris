// @vitest-environment jsdom

/**
 * What the Diagnostics screen shows while it waits and once it knows.
 *
 * Every check row paints at once with its name and its own placeholder; each
 * fills as its own answer lands, so one slow probe holds only its row. The
 * bundle card lists the files and the settings that ride along - values for
 * the safe ones, names only for the rest - and downloads it, saying why when
 * the download is refused.
 */

import type { ReactElement } from "react";
import { MessagesWrapper } from "../setup/i18n";
import type { CheckId, CheckResult } from "@/lib/diagnostics/checks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render as draw, screen, waitFor, within } from "@testing-library/react";

const runFixAction = vi.fn();
const runSpeedTestAction = vi.fn();
vi.mock("@/app/(app)/admin/diagnostics/actions", () => ({ runFixAction, runSpeedTestAction }));

const { DiagnosticsView } = await import("@/app/(app)/admin/diagnostics/diagnostics-view");

const render = (ui: ReactElement) => draw(ui, { wrapper: MessagesWrapper });

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const IDS: CheckId[] = ["database", "disk", "edge"];

const RESULTS: Record<string, CheckResult> = {
    database: { id: "database", status: "pass", code: "ok", facts: { ms: 4 }, fix: null, ms: 4 },
    disk: {
        id: "disk",
        status: "warn",
        code: "low",
        facts: { freeGb: 8, percent: 92 },
        fix: { kind: "action", action: "freeSpace" },
        ms: 2
    },
    edge: {
        id: "edge",
        status: "fail",
        code: "empty",
        facts: { files: "polaris-apps.yml" },
        fix: { kind: "action", action: "republishRoutes" },
        ms: 1
    }
};

const PREVIEW = {
    files: ["manifest.json", "diagnosis.json", "errors.json", "config.json", "speed-test.json"],
    config: { values: { POLARIS_IMAGE_TAG: "2026.10.1" }, withheld: ["POLARIS_SESSION_SECRET"] }
};

/** Each check's answer is held until the test releases it. */
let release: Record<string, () => void>;

beforeEach(() => {
    release = {};
    vi.stubGlobal(
        "fetch",
        vi.fn((input: string) => {
            const url = new URL(input, "http://localhost");
            if (url.pathname.endsWith("/bundle")) return Promise.resolve(Response.json(PREVIEW));
            const id = url.searchParams.get("id")!;
            return new Promise<Response>((resolve) => {
                release[id] = () => resolve(Response.json(RESULTS[id]));
            });
        })
    );
});

const rowOf = (title: string) => screen.getByText(title).closest("li")!;
const pulsing = (element: Element) => element.querySelectorAll(".animate-pulse").length;

describe("the Diagnostics screen", () => {
    it("paints every check with its own placeholder, then fills each as it answers", async () => {
        render(<DiagnosticsView checks={IDS} initialSpeed={null} />);
        for (const title of ["Database server", "Disk space", "Routing"]) {
            expect(pulsing(rowOf(title))).toBeGreaterThan(0);
        }
        // The page around the checks is not held: the other cards are there.
        expect(screen.getByText("Speed test")).toBeTruthy();
        expect(screen.getByText("Support bundle")).toBeTruthy();

        await waitFor(() => expect(release.database).toBeDefined());
        await act(async () => release.database());
        await waitFor(() => expect(pulsing(rowOf("Database server"))).toBe(0));
        expect(within(rowOf("Database server")).getByText("Answering in 4 ms.")).toBeTruthy();
        expect(within(rowOf("Database server")).getByText("OK")).toBeTruthy();
        // The others still wait on their own.
        expect(pulsing(rowOf("Disk space"))).toBeGreaterThan(0);

        await act(async () => {
            release.disk();
            release.edge();
        });
        await waitFor(() => expect(within(rowOf("Routing")).getByText("Problem")).toBeTruthy());
        expect(
            within(rowOf("Disk space")).getByText("Running low: 8 GB free, 92% used.")
        ).toBeTruthy();
        expect(
            within(rowOf("Disk space")).getByRole("button", { name: "Free up space" })
        ).toBeTruthy();
        expect(
            within(rowOf("Routing")).getByRole("button", { name: "Republish routes" })
        ).toBeTruthy();
        expect(screen.getByText("1 problem, 1 warning")).toBeTruthy();
    });

    it("previews the bundle: its files, safe values in full, the rest by name", async () => {
        render(<DiagnosticsView checks={IDS} initialSpeed={null} />);
        for (const name of PREVIEW.files) expect(screen.getByText(name)).toBeTruthy();
        await waitFor(() => expect(screen.getByText("POLARIS_IMAGE_TAG")).toBeTruthy());
        expect(screen.getByText("2026.10.1")).toBeTruthy();
        expect(screen.getByText("Included by name only")).toBeTruthy();
        expect(screen.getByText("POLARIS_SESSION_SECRET")).toBeTruthy();
    });

    it("downloads the bundle as a file, and says why when it is refused", async () => {
        const createObjectURL = vi.fn(() => "blob:bundle");
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
        const click = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => undefined);
        const fetched = vi.mocked(fetch);
        render(<DiagnosticsView checks={IDS} initialSpeed={null} />);
        const button = screen.getByRole("button", { name: /Download bundle/ });

        fetched.mockResolvedValueOnce(
            new Response("zip", {
                headers: {
                    "Content-Disposition": 'attachment; filename="polaris-support-2026-10-15.zip"'
                }
            })
        );
        await act(async () => button.click());
        await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
        expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
            "polaris-support-2026-10-15.zip"
        );
        expect(createObjectURL).toHaveBeenCalledTimes(1);

        fetched.mockResolvedValueOnce(
            Response.json(
                { error: "rate limited" },
                { status: 429, headers: { "Retry-After": "61" } }
            )
        );
        await act(async () => button.click());
        await waitFor(() =>
            expect(screen.getByText("Limit reached. Try again in 2 minutes.")).toBeTruthy()
        );

        fetched.mockResolvedValueOnce(new Response("", { status: 500 }));
        await act(async () => button.click());
        await waitFor(() =>
            expect(screen.getByText("The bundle could not be built. Try again.")).toBeTruthy()
        );
        expect(click).toHaveBeenCalledTimes(1);
        click.mockRestore();
    });

    it("shows the last speed result at once, and says when the limit is reached", async () => {
        runSpeedTestAction.mockResolvedValueOnce({
            ok: false,
            reason: "limited",
            retryAfterMs: 5 * 60_000
        });
        render(
            <DiagnosticsView
                checks={IDS}
                initialSpeed={{
                    downloadMbps: 412.5,
                    uploadMbps: 88,
                    latencyMs: 12,
                    at: new Date().toISOString()
                }}
            />
        );
        expect(screen.getByText("412.5 Mbps")).toBeTruthy();
        expect(screen.getByText("12 ms")).toBeTruthy();
        await act(async () => screen.getByRole("button", { name: "Run speed test" }).click());
        await waitFor(() =>
            expect(screen.getByText("Limit reached. Try again in 5 minutes.")).toBeTruthy()
        );
    });
});
