import { describe, expect, it } from "vitest";
import { originPattern } from "@/lib/integrity";

// The checker itself is shared and tested in packages/core/test/integrity-checker.test.ts.
describe("page code check", () => {
    it("registers on the server's host, any port", () => {
        expect(originPattern("https://polaris.example:8443")).toBe("https://polaris.example/*");
        expect(originPattern("ftp://x")).toBeNull();
    });
});
