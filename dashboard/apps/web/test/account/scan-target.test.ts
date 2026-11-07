import { describe, expect, it } from "vitest";
import { scanTarget } from "@/lib/scan-target";

describe("scanTarget", () => {
    it("opens the sign-in decision for the sign-in screen's QR", () => {
        expect(scanTarget("https://polaris.example/account/scan?code=ABCD-1234")).toBe(
            "/account/scan?code=ABCD-1234"
        );
    });

    it("opens the TV approval page for a Polaris TV link QR", () => {
        expect(scanTarget("https://polaris.example/account/tv?code=BCDF2345")).toBe(
            "/account/tv?code=BCDF2345"
        );
        expect(scanTarget("http://192.168.1.20:3000/account/tv/?code=BCDF2345")).toBe(
            "/account/tv?code=BCDF2345"
        );
    });

    it("keeps only the path, never the origin the QR names", () => {
        expect(scanTarget("https://elsewhere.example/account/tv?code=BCDF2345")).toBe(
            "/account/tv?code=BCDF2345"
        );
        expect(scanTarget("https://elsewhere.example/phish?code=BCDF2345")).toBe(
            "/account/scan?code=BCDF2345"
        );
    });

    it("treats a bare code as a sign-in code", () => {
        expect(scanTarget("  bcdf-2345 ")).toBe("/account/scan?code=bcdf-2345");
    });

    it("refuses what holds no code", () => {
        expect(scanTarget("https://polaris.example/account/tv")).toBeNull();
        expect(scanTarget("hello world")).toBeNull();
        expect(scanTarget("")).toBeNull();
    });
});
