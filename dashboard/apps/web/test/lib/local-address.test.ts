// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.hoisted(() => vi.fn());
vi.mock("@polaris/core/instance-fallback", async (original) => ({
    ...(await original<typeof import("@polaris/core/instance-fallback")>()),
    verifyAlternate: verify
}));

const { findLocalAddress, INSTANCE_KEY, isLocalOrigin, offerHref, onLocalCertificate } =
    await import("@/lib/local-address");

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
        hold([here, "https://lan-192-168-1-2.example.com", "https://other.example.com"]);
        verify.mockImplementation(async (origin: string) =>
            origin.includes("other")
                ? { kind: "same" }
                : { kind: "unreachable", certificate: false }
        );
        expect(await findLocalAddress()).toEqual({
            origin: "https://other.example.com",
            proven: true
        });
        expect(verify).toHaveBeenCalledTimes(2);
    });

    it("offers a local-certificate address without ever asking it", async () => {
        hold(["https://polaris.local", "https://192.168.1.2"]);
        verify.mockResolvedValue({ kind: "same" });
        expect(await findLocalAddress()).toEqual({
            origin: "https://polaris.local",
            proven: false
        });
        expect(verify).not.toHaveBeenCalled();
    });

    it("prefers the proven LAN name to another proven address", async () => {
        hold(["https://other.example.com", "https://lan-192-168-1-2.example.com", "https://polaris.local"]);
        verify.mockResolvedValue({ kind: "same" });
        expect(await findLocalAddress()).toEqual({ origin: "https://lan-192-168-1-2.example.com", proven: true });
        expect(verify).toHaveBeenCalledTimes(2);
    });

    it("falls back to the local address when the LAN name does not answer", async () => {
        hold(["https://lan-192-168-1-2.example.com", "https://polaris.local"]);
        verify.mockResolvedValue({ kind: "unreachable", certificate: false });
        expect(await findLocalAddress()).toEqual({
            origin: "https://polaris.local",
            proven: false
        });
    });

    it("never offers one that answered with another key, or a silent public one", async () => {
        hold(["https://lan-192-168-1-2.example.com"]);
        verify.mockResolvedValue({ kind: "different" });
        expect(await findLocalAddress()).toBeNull();
        hold(["https://public.example.com"]);
        verify.mockResolvedValue({ kind: "unreachable", certificate: false });
        expect(await findLocalAddress()).toBeNull();
    });
});

describe("offerHref", () => {
    it("carries the current address only to a proven one", () => {
        window.history.replaceState(null, "", "/s/share-token?key=value");
        const origin = "https://polaris.local";
        expect(offerHref({ origin, proven: true })).toBe(`${origin}/s/share-token?key=value`);
        expect(offerHref({ origin, proven: false })).toBe(origin);
    });
});

describe("isLocalOrigin", () => {
    it("knows a local name and private addresses", () => {
        expect(isLocalOrigin("https://polaris.local")).toBe(true);
        expect(isLocalOrigin("https://192.168.1.2")).toBe(true);
        expect(isLocalOrigin("https://172.20.0.1")).toBe(true);
        expect(isLocalOrigin("https://172.32.0.1")).toBe(false);
        expect(isLocalOrigin("https://example.com")).toBe(false);
        expect(isLocalOrigin("https://lan-192-168-1-2.example.com")).toBe(true);
    });

    it("keeps only the local-CA names off the fetch list", () => {
        expect(onLocalCertificate("https://polaris.local")).toBe(true);
        expect(onLocalCertificate("https://192.168.1.2")).toBe(true);
        expect(onLocalCertificate("https://lan-192-168-1-2.example.com")).toBe(false);
        expect(onLocalCertificate("https://lan.example.com")).toBe(false);
    });
});
