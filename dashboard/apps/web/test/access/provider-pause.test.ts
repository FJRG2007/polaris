/**
 * A paid provider that stops answering is stopped, not asked again on every pass.
 * The case behind this: an account out of credits answered 402 to every address
 * on every firewall pass, every thirty seconds, for a week.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let settings = new Map<string, string>();
const recorded: { provider: string; reason: string; kind: string }[] = [];
const cleared: string[] = [];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@/lib/connections/attention", () => ({
    recordConnectionFailure: async (provider: string, reason: string, kind: string) => {
        recorded.push({ provider, reason, kind });
        return true;
    },
    clearConnectionFailure: async (provider: string) => {
        cleared.push(provider);
        return true;
    }
}));

const { ProviderPaused, clearProviderPause, pauseReasonFor, providerPaused, whileServing } =
    await import("@/lib/integrations/provider-pause");

/** A failure the way axios reports one. */
const httpFailure = (status: number) => Object.assign(new Error("failed"), { response: { status } });

beforeEach(() => {
    settings = new Map();
    recorded.length = 0;
    cleared.length = 0;
    vi.useRealTimers();
});

describe("asking a paid provider", () => {
    it("sends one request and then none while the account is out of credits", async () => {
        const ask = vi.fn().mockRejectedValue(httpFailure(402));
        await expect(whileServing("dymo", "Dymo API", ask)).rejects.toThrow("failed");
        for (let pass = 0; pass < 100; pass += 1) {
            await expect(whileServing("dymo", "Dymo API", ask)).rejects.toBeInstanceOf(
                ProviderPaused
            );
        }
        expect(ask).toHaveBeenCalledTimes(1);
        expect(await providerPaused("dymo")).toBe(true);
    });

    it("tells the operator what stopped it", async () => {
        await whileServing("dymo", "Dymo API", () => Promise.reject(httpFailure(402))).catch(
            () => undefined
        );
        expect(recorded).toEqual([
            { provider: "dymo", reason: "credits", kind: "out-of-service" }
        ]);
    });

    it("does not raise an alert for something that passes on its own", async () => {
        await whileServing("dymo", "Dymo API", () => Promise.reject(httpFailure(503))).catch(
            () => undefined
        );
        expect(recorded).toEqual([]);
        expect(await providerPaused("dymo")).toBe(true);
    });

    it("pauses on an answer it could not read, which was also paid for", async () => {
        await whileServing("dymo", "Dymo API", () => Promise.reject(new Error("parse"))).catch(
            () => undefined
        );
        expect(await providerPaused("dymo")).toBe(true);
    });

    it("tries again by itself after the hour and clears the alert when it answers", async () => {
        vi.useFakeTimers();
        await whileServing("dymo", "Dymo API", () => Promise.reject(httpFailure(402))).catch(
            () => undefined
        );
        vi.advanceTimersByTime(61 * 60 * 1000);
        await expect(whileServing("dymo", "Dymo API", async () => "answer")).resolves.toBe(
            "answer"
        );
        expect(await providerPaused("dymo")).toBe(false);
        expect(cleared).toEqual(["dymo"]);
    });

    it("costs one request an hour for as long as the credits stay out", async () => {
        vi.useFakeTimers();
        const ask = vi.fn().mockRejectedValue(httpFailure(402));
        for (let tick = 0; tick < 2 * 24 * 60 * 2; tick += 1) {
            await whileServing("dymo", "Dymo API", ask).catch(() => undefined);
            vi.advanceTimersByTime(30_000);
        }
        expect(ask.mock.calls.length).toBeLessThanOrEqual(48);
    });

    it("keeps one provider's pause from another", async () => {
        await whileServing("dymo", "Dymo API", () => Promise.reject(httpFailure(402))).catch(
            () => undefined
        );
        expect(await providerPaused("criminalip")).toBe(false);
    });

    it("asks at once after the operator saved", async () => {
        await whileServing("dymo", "Dymo API", () => Promise.reject(httpFailure(402))).catch(
            () => undefined
        );
        await clearProviderPause("dymo");
        expect(await providerPaused("dymo")).toBe(false);
    });
});

describe("reading a failure", () => {
    it.each([
        [402, "credits"],
        [401, "key"],
        [403, "key"],
        [429, "busy"],
        [500, "unavailable"]
    ])("takes %i for %s", (status, reason) => {
        expect(pauseReasonFor(httpFailure(status))).toBe(reason);
    });

    it("reads the status Criminal IP's own error carries", () => {
        expect(pauseReasonFor(Object.assign(new Error("no"), { status: 402 }))).toBe("credits");
    });
});
