/**
 * The address asked for on the first run: what it is normalized to, and the
 * sentence each wrong shape is refused with.
 */

import { describe, expect, it } from "vitest";
import { normalizeServerInput, readServerAddress, serverAddressSchema } from "@/shared/server-address";

function refusal(input: string): string | undefined {
    const parsed = serverAddressSchema.safeParse(input);
    return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

describe("normalizeServerInput", () => {
    it("trims, and reads a bare host as https", () => {
        expect(normalizeServerInput("  polaris.example.com  ")).toBe("https://polaris.example.com");
        expect(normalizeServerInput("localhost:3000")).toBe("https://localhost:3000");
    });

    it("keeps a scheme that was typed", () => {
        expect(normalizeServerInput("http://polaris.local")).toBe("http://polaris.local");
        expect(normalizeServerInput("HTTPS://Polaris.Example.com")).toBe("HTTPS://Polaris.Example.com");
    });

    it("leaves an empty field empty", () => {
        expect(normalizeServerInput("   ")).toBe("");
    });
});

describe("serverAddressSchema", () => {
    it("stores the origin: lowercase, no trailing slash, no default port", () => {
        expect(serverAddressSchema.parse("https://Polaris.Example.COM/")).toBe("https://polaris.example.com");
        expect(serverAddressSchema.parse("https://polaris.example.com:443")).toBe("https://polaris.example.com");
        expect(serverAddressSchema.parse("http://polaris.local:80")).toBe("http://polaris.local");
        expect(serverAddressSchema.parse("polaris.example.com:8443")).toBe("https://polaris.example.com:8443");
        expect(serverAddressSchema.parse("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
    });

    it("asks for an address when there is none", () => {
        expect(refusal("")).toBe("Enter the address of your Polaris.");
        expect(refusal("   ")).toBe("Enter the address of your Polaris.");
    });

    it("refuses schemes other than http and https", () => {
        expect(refusal("ftp://polaris.example.com")).toMatch(/starts with https:\/\//);
        expect(refusal("file:///etc/passwd")).toMatch(/starts with https:\/\//);
        expect(refusal("javascript://alert(1)")).toMatch(/starts with https:\/\//);
    });

    it("refuses what is not an address", () => {
        expect(refusal("https://")).toMatch(/not an address/);
        expect(refusal("polaris example com")).toMatch(/not an address/);
    });

    it("refuses credentials in the address", () => {
        expect(refusal("https://admin:secret@polaris.example.com")).toMatch(/user name and password/);
    });

    it("refuses a path, a query or a fragment, and says which address to use", () => {
        expect(refusal("https://polaris.example.com/home")).toBe(
            "Only the address, without a path: https://polaris.example.com"
        );
        expect(refusal("https://polaris.example.com/?tab=1")).toMatch(/without a path/);
        expect(refusal("https://polaris.example.com/#top")).toMatch(/without a path/);
    });
});

describe("readServerAddress", () => {
    it("reads back a stored origin, and nothing else", () => {
        expect(readServerAddress("https://polaris.example.com")).toBe("https://polaris.example.com");
        expect(readServerAddress("https://polaris.example.com/home")).toBeNull();
        expect(readServerAddress(42)).toBeNull();
        expect(readServerAddress(null)).toBeNull();
    });
});
