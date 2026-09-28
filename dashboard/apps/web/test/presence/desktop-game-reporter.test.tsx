// @vitest-environment jsdom
/**
 * The page inside the desktop app passing on the game the app sees.
 *
 * What is pinned: in a browser, or an app older than game detection, nothing is
 * sent; inside the app the account's own games are handed over first, what is
 * running already is reported only from the window the app says is the
 * reporter, and every event the app raises is sent on as it came.
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { method: string; body: unknown }[] = [];

beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        sent.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return {
            ok: true,
            json: async () => (method === "GET" ? { customGames: [{ executable: "mine.exe", name: "Mine" }] } : {})
        } as Response;
    });
});

afterEach(() => {
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
    vi.unstubAllGlobals();
});

const { DesktopGameReporter } = await import("@/components/desktop-game-reporter");

function desktop(reporter: boolean) {
    let listener: ((game: unknown) => void) | null = null;
    const setCustomGames = vi.fn(async () => true);
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "0.2.0",
        platform: "win32",
        notify: async () => true,
        closeNotice: async () => undefined,
        pickFolder: async () => null,
        pushLocal: async () => ({ ok: true }),
        openWindow: async () => ({ ok: true }),
        gameActivity: async () => ({
            game: { key: "celeste.exe", name: "Celeste", startedAt: "2026-09-28T10:00:00.000Z" },
            reporter
        }),
        onGameActivity: (heard: (game: unknown) => void) => {
            listener = heard;
            return () => {
                listener = null;
            };
        },
        setCustomGames
    };
    return { emit: (game: unknown) => listener?.(game), setCustomGames };
}

describe("reporting the game on this computer", () => {
    it("sends nothing in a browser", async () => {
        render(<DesktopGameReporter />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sent).toEqual([]);
    });

    it("hands the app this account's games and reports what is running", async () => {
        const app = desktop(true);
        render(<DesktopGameReporter />);
        await waitFor(() => expect(app.setCustomGames).toHaveBeenCalledWith([{ executable: "mine.exe", name: "Mine" }]));
        await waitFor(() =>
            expect(sent.filter((entry) => entry.method === "POST")).toEqual([
                {
                    method: "POST",
                    body: { game: { key: "celeste.exe", name: "Celeste", startedAt: "2026-09-28T10:00:00.000Z" } }
                }
            ])
        );
        app.emit(null);
        await waitFor(() => expect(sent.at(-1)).toEqual({ method: "POST", body: { game: null } }));
    });

    it("does not report what is running from a window that is not the reporter", async () => {
        desktop(false);
        render(<DesktopGameReporter />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sent.filter((entry) => entry.method === "POST")).toEqual([]);
    });
});
