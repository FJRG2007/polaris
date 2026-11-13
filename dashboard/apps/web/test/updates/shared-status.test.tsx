// @vitest-environment jsdom

/**
 * The badge in the top bar and the Updates screen agree. The badge said an
 * update was waiting while the screen it links to said nothing until Check was
 * pressed: each asked on its own clock, and the server answers from a cache it
 * refreshes in the background, so the first answer after a quiet spell is the
 * old one. Pinned: every answer lands in one shared place, the newest wins, and
 * an answer older than the server's cache is asked again within seconds.
 */

import { withMessages } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/lib/update-service";
import * as shared from "@/lib/update-status-shared";

const { UpdateIndicator } = await import("@/components/update-indicator");

function status(phase: UpdateStatus["phase"], checkedAt: number): UpdateStatus {
    return {
        phase,
        source: "image",
        current: "aaaaaaa",
        latest: phase === "available" ? "bbbbbbb" : "aaaaaaa",
        behindBy: phase === "available" ? 1 : 0,
        upToDate: phase === "up-to-date",
        buildingCount: null,
        publishedAt: null,
        checks: null,
        checksUrl: null,
        url: "https://example.invalid/commits",
        checkedAt: new Date(checkedAt).toISOString()
    } as UpdateStatus;
}

beforeEach(() => {
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
    shared.resetSharedUpdateStatus();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("the shared update status", () => {
    it("keeps the newest answer and tells everybody listening", () => {
        const heard: string[] = [];
        shared.onUpdateStatus((next) => heard.push(next.phase));
        shared.noteUpdateStatus(status("available", 2_000));
        shared.noteUpdateStatus(status("up-to-date", 1_000));
        expect(shared.latestUpdateStatus()?.phase).toBe("available");
        expect(heard).toEqual(["available"]);
    });

    it("calls an answer older than the server's cache stale", () => {
        const now = Date.now();
        expect(shared.isStale(status("up-to-date", now - 11 * 60_000), now)).toBe(true);
        expect(shared.isStale(status("up-to-date", now - 60_000), now)).toBe(false);
    });
});

describe("the badge", () => {
    it("asks again for the fresh answer after a stale one, and shows it", async () => {
        const now = Date.now();
        const answers = [status("up-to-date", now - 30 * 60_000), status("available", now)];
        const fetcher = vi.fn(async () => Response.json(answers.shift()));
        vi.stubGlobal("fetch", fetcher);
        render(withMessages(<UpdateIndicator />));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.queryByRole("link")).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(shared.STALE_RETRY_MS);
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("link").getAttribute("href")).toBe("/admin/updates");
    });

    it("follows what the Updates screen heard", async () => {
        const now = Date.now();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(status("available", now)))
        );
        render(withMessages(<UpdateIndicator />));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByRole("link")).toBeTruthy();
        // The screen installed it and checked again: the badge goes with it.
        act(() => shared.noteUpdateStatus(status("up-to-date", now + 1_000)));
        expect(screen.queryByRole("link")).toBeNull();
    });
});
