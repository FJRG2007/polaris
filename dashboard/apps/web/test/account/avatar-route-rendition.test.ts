/**
 * The avatar route answers the desktop app's notice - which asks only for PNG
 * and JPEG - with a PNG of a WebP face, under its own tag, and a browser with
 * the photo as stored.
 */

import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

let webp: Buffer = Buffer.alloc(0);

vi.mock("@/lib/session", () => ({ resolveSession: async () => ({ id: "ada", isAdmin: false }) }));
vi.mock("@/lib/chat/meeting-seat", () => ({ resolveGuestSeat: async () => null }));
vi.mock("@/lib/chat/meetings", () => ({ inCallTogether: async () => false }));
vi.mock("@/lib/privacy-service", () => ({ maySee: async () => true }));
vi.mock("@/lib/profile-service", () => ({ profilesArePublic: async () => false }));
vi.mock("@/lib/avatar-service", () => ({
    resolveAvatar: async () => ({
        certain: true,
        picture: { etag: '"face"', mime: "image/webp", load: async () => webp }
    })
}));

const { GET } = await import("@/app/api/avatar/[userId]/route");

function ask(headers: Record<string, string>): Promise<Response> {
    return GET(new Request("http://polaris.test/api/avatar/grace", { headers }), {
        params: Promise.resolve({ userId: "grace" })
    });
}

beforeAll(async () => {
    webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c85028" } })
        .webp()
        .toBuffer();
});

describe("the avatar route and a reader that draws only PNG and JPEG", () => {
    it("serves a browser the WebP as stored", async () => {
        const answer = await ask({ accept: "image/avif,image/webp,*/*;q=0.8" });
        expect(answer.headers.get("Content-Type")).toBe("image/webp");
        expect(answer.headers.get("ETag")).toBe('"face"');
        expect(answer.headers.get("Vary")).toBe("Accept");
    });

    it("serves the desktop notice a PNG under a tag of its own", async () => {
        const answer = await ask({ accept: "image/png, image/jpeg" });
        expect(answer.status).toBe(200);
        expect(answer.headers.get("Content-Type")).toBe("image/png");
        expect(answer.headers.get("ETag")).toBe('"face-png"');
        const meta = await sharp(Buffer.from(await answer.arrayBuffer())).metadata();
        expect(meta.format).toBe("png");
    });

    it("answers the PNG's own tag with a 304", async () => {
        const answer = await ask({ accept: "image/png, image/jpeg", "if-none-match": '"face-png"' });
        expect(answer.status).toBe(304);
    });

    it("does not answer the stored photo's tag as the PNG's", async () => {
        const answer = await ask({ accept: "image/png, image/jpeg", "if-none-match": '"face"' });
        expect(answer.status).toBe(200);
    });
});
