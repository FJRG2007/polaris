// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.hoisted(() => vi.fn());
vi.mock("@polaris/core/instance-fallback", async (original) => ({
    ...(await original<typeof import("@polaris/core/instance-fallback")>()),
    verifyAlternate: verify
}));

const { findLocalAddress, INSTANCE_KEY, isLocalOrigin } = await import("@/lib/local-address");

const here = window.location.origin;

function hold(addresses: string[]) {
    window.localStorage.setItem(
        INSTANCE_KEY,
        JSON.stringify({
            record: { id: "instance-1", publicKey: "k".repeat(43), addresses },
            at: Date.now()
        })
    );
}

const kept = new Map<string, string>();

beforeEach(() => {
    verify.mockReset();
    kept.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value)
    });
});

afterEach(() => vi.unstubAllGlobals());

describe("findLocalAddress", () => {
    it("offers nothing with nothing remembered, or something else stored", async () => {
        expect(await findLocalAddress()).toBeNull();
        window.localStorage.setItem(INSTANCE_KEY, "{broken");
        expect(await findLocalAddress()).toBeNull();
    });

    it("prefers a proven address and never challenges this one", async () => {
        hold([here, "https://polaris.local", "https://other.example.com"]);
        verify.mockImplementation(async (origin: string) =>
            origin.includes("other") ? { kind: "same" } : { kind: "unreachable", certificate: false }
        );
        expect(await findLocalAddress()).toBe("https://other.example.com");
        expect(verify).toHaveBeenCalledTimes(2);
    });

    it("offers a local address the browser could not ask", async () => {
        hold(["https://polaris.local"]);
        verify.mockResolvedValue({ kind: "unreachable", certificate: false });
        expect(await findLocalAddress()).toBe("https://polaris.local");
    });

    it("never offers one that answered with another key, or a silent public one", async () => {
        hold(["https://polaris.local"]);
        verify.mockResolvedValue({ kind: "different" });
        expect(await findLocalAddress()).toBeNull();
        hold(["https://public.example.com"]);
        verify.mockResolvedValue({ kind: "unreachable", certificate: false });
        expect(await findLocalAddress()).toBeNull();
    });
});

describe("isLocalOrigin", () => {
    it("knows a local name and private addresses", () => {
        expect(isLocalOrigin("https://polaris.local")).toBe(true);
        expect(isLocalOrigin("https://192.168.1.2")).toBe(true);
        expect(isLocalOrigin("https://172.20.0.1")).toBe(true);
        expect(isLocalOrigin("https://172.32.0.1")).toBe(false);
        expect(isLocalOrigin("https://example.com")).toBe(false);
    });
});
