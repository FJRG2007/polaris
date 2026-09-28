/**
 * An attachment is served from Polaris's own origin with whatever type the
 * uploader's browser claimed. An SVG is an image that can carry script, so one
 * opened in a tab must render with no power to run it - otherwise any member who
 * can attach a file can act with the session of whoever opens it.
 */

import { describe, expect, it, vi } from "vitest";
import { untrustedFileHeaders } from "@/lib/mime";

vi.mock("@/lib/api-session", () => ({
    apiPermission: vi.fn(async () => ({ id: "u1", isAdmin: false }))
}));
vi.mock("@/lib/tasks/access", () => ({
    requireTask: vi.fn(async () => ({ spaceId: "s1" })),
    TaskAccessError: class TaskAccessError extends Error {}
}));
vi.mock("@/lib/tasks/attachment-service", () => ({
    attachmentTaskId: vi.fn(async () => "t1"),
    readAttachment: vi.fn(async () => ({
        name: "logo.svg",
        mime: "image/svg+xml",
        size: 60,
        body: new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').body
    }))
}));

const { GET } = await import("../../src/app/api/tasks/attachments/[attachmentId]/route");

describe("an attachment opened in a tab", () => {
    it("is sandboxed and never sniffed, so an SVG cannot run script here", async () => {
        const response = await GET(new Request("http://polaris.test/api/tasks/attachments/a1"), {
            params: Promise.resolve({ attachmentId: "a1" })
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toBe("sandbox");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });
});

describe("the headers for bytes somebody else wrote", () => {
    it("sandbox every type that can render as a document", () => {
        for (const type of ["image/svg+xml", "text/html; charset=utf-8", "application/xml", "image/png", "video/mp4"]) {
            expect(untrustedFileHeaders(type)["content-security-policy"]).toBe("sandbox");
            expect(untrustedFileHeaders(type)["x-content-type-options"]).toBe("nosniff");
        }
    });

    it("leave PDF unsandboxed, since a browser refuses to draw one under a sandbox", () => {
        expect(untrustedFileHeaders("application/pdf")["content-security-policy"]).toBeUndefined();
        expect(untrustedFileHeaders("Application/PDF")["x-content-type-options"]).toBe("nosniff");
    });
});
