/**
 * A picked file comes back as bytes the picker's own fetch() reads, never as a
 * page. The address can be anybody's, so an HTML file served from this origin
 * would run as whoever opened the link; it has to arrive as a sandboxed download.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "user-1", isAdmin: false }) }));
vi.mock("@/lib/attachments/from-elsewhere", () => ({
    AttachRefused: class extends Error {},
    fileFromAddress: async () => ({
        name: "page.html",
        type: "text/html",
        bytes: new TextEncoder().encode("<script>alert(document.domain)</script>")
    }),
    fileFromDrive: async () => null
}));

const route = await import("../../src/app/api/attachments/fetch/route");

describe("a fetched attachment", () => {
    it("is a sandboxed download, not a page on this origin", async () => {
        const answer = await route.GET(
            new Request(
                "https://polaris.test/api/attachments/fetch?url=https%3A%2F%2Fexample.com%2Fpage.html"
            )
        );
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-disposition")).toBe("attachment");
        expect(answer.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        // The picker still learns the name and the type it stages the file as.
        expect(answer.headers.get("x-polaris-filename")).toBe("page.html");
        expect(answer.headers.get("content-type")).toBe("text/html");
    });
});
