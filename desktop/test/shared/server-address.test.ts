/**
 * The address asked for on the first run: what it is normalized to, and the
 * sentence each wrong shape is refused with.
 */

import { describe, expect, it } from "vitest";
import {
    normalizeServerInput,
    readServerAddress,
    serverAddressSchema
} from "@/shared/server-address";

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
        expect(normalizeServerInput("HTTPS://Polaris.Example.com")).toBe(
            "HTTPS://Polaris.Example.com"
        );
    });

    it("leaves an empty field empty", () => {
        expect(normalizeServerInput("   ")).toBe("");
    });
});

describe("serverAddressSchema", () => {
    it("stores the origin: lowercase, no trailing slash, no default port", () => {
        expect(serverAddressSchema.parse("https://Polaris.Example.COM/")).toBe(
            "https://polaris.example.com"
        );
        expect(serverAddressSchema.parse("https://polaris.example.com:443")).toBe(
            "https://polaris.example.com"
        );
        expect(serverAddressSchema.parse("http://polaris.local:80")).toBe("http://polaris.local");
        expect(serverAddressSchema.parse("polaris.example.com:8443")).toBe(
            "https://polaris.example.com:8443"
        );
        expect(serverAddressSchema.parse("http://192.168.1.20:3000")).toBe(
            "http://192.168.1.20:3000"
        );
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

    it("takes http:// for a host on this network", () => {
        for (const address of [
            "http://localhost:3000",
            "http://polaris",
            "http://polaris.local",
            "http://polaris.lan",
            "http://nas.home.arpa",
            "http://polaris.internal",
            "http://app.localhost",
            "http://127.0.0.1",
            "http://10.0.0.5",
            "http://172.16.0.1",
            "http://172.31.255.255",
            "http://192.168.1.20:3000",
            "http://169.254.10.1",
            "http://100.101.102.103",
            "http://[::1]:3000",
            "http://[fd12:3456::1]",
            "http://[fe80::1]"
        ]) {
            expect(refusal(address), address).toBeUndefined();
        }
    });

    it("refuses http:// for a host on the internet, and says https:// is needed", () => {
        for (const address of [
            "http://polaris.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.128.0.1",
            "http://192.169.0.1",
            "http://[2001:db8::1]",
            "http://[fd::1]",
            "http://local.example.com",
            "http://0x0a000001.example.com"
        ]) {
            expect(refusal(address), address).toBe(
                "An address on the internet needs https://. http:// works only on your own network."
            );
        }
        expect(serverAddressSchema.parse("https://polaris.example.com")).toBe(
            "https://polaris.example.com"
        );
    });

    it("refuses what is not an address", () => {
        expect(refusal("https://")).toMatch(/not an address/);
        expect(refusal("polaris example com")).toMatch(/not an address/);
    });

    it("refuses credentials in the address", () => {
        expect(refusal("https://admin:secret@polaris.example.com")).toMatch(
            /user name and password/
        );
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
        expect(readServerAddress("https://polaris.example.com")).toBe(
            "https://polaris.example.com"
        );
        expect(readServerAddress("https://polaris.example.com/home")).toBeNull();
        expect(readServerAddress("http://polaris.example.com")).toBeNull();
        expect(readServerAddress(42)).toBeNull();
        expect(readServerAddress(null)).toBeNull();
    });
});
