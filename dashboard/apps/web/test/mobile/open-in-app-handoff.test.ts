// @vitest-environment jsdom

/**
 * The handoff to the app is decided once per document, whoever asks first - the
 * note in the app chrome or a lock screen about to raise a passkey prompt - so
 * the two always agree, and one load never asks the server twice.
 */

import { freshWebStorage } from "../helpers/memory-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const fetchMock = vi.fn();

beforeEach(() => {
    vi.resetModules();
    freshWebStorage();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function answer(body: unknown) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

describe("handing a page to the desktop app", () => {
    it("is decided once, and every caller hears the same answer", async () => {
        answer({ open: true, desktop: true });
        const { appHandoff } = await import("@/components/open-in-app");
        const [first, second] = await Promise.all([appHandoff(), appHandoff()]);
        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(await appHandoff()).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("is no when the account has not signed in to the app", async () => {
        answer({ open: true, desktop: false });
        const { appHandoff } = await import("@/components/open-in-app");
        expect(await appHandoff()).toBe(false);
    });

    it("is no when this tab already tried, without asking the server", async () => {
        window.sessionStorage.setItem("polaris.openInApp.tried", "1");
        const { appHandoff } = await import("@/components/open-in-app");
        expect(await appHandoff()).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is no when the server cannot be reached", async () => {
        fetchMock.mockRejectedValue(new Error("offline"));
        const { appHandoff } = await import("@/components/open-in-app");
        expect(await appHandoff()).toBe(false);
    });
});
