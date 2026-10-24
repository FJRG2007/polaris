/**
 * The route the voice arrives on: signed out is refused, somebody without
 * `home.control` is refused, a malformed camera or talk is refused, a body past
 * a second of audio is refused, and a talk that is over answers 409 so the
 * screen stops sending.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CAMERA = "11111111-1111-4111-8111-111111111111";
const TALK = "33333333-3333-4333-8333-333333333333";

let caller: unknown = { id: "user-1" };
let mayControl = true;
const feedTalk = vi.fn((..._args: unknown[]) => true);

vi.mock("@polaris/app-host", async (original) => {
    const real = await original<typeof import("@polaris/app-host")>();
    const host = real.host as unknown as Record<string, unknown>;
    return {
        ...real,
        host: new Proxy(host, {
            get(target, key) {
                if (key === "apiSession") return { apiUser: async () => caller };
                if (key === "session")
                    return {
                        sessionCan: async (_user: unknown, permission: string) =>
                            permission === "home.control" && mayControl
                    };
                return Reflect.get(target, key);
            }
        })
    };
});
vi.mock("@polaris-app/places/src/lib/talk", () => ({
    feedTalk: (...args: unknown[]) => feedTalk(...args)
}));

const { POST } = await import("@polaris-app/places/src/routes/api/home/cameras/[id]/talk/route");
const { HomeError } = await import("@polaris-app/places/src/lib/home-error");

function post(body: Uint8Array, camera = CAMERA, talk: string | null = TALK): Promise<Response> {
    const query = talk ? `?talk=${talk}` : "";
    const url = `http://polaris.invalid/api/home/cameras/${camera}/talk${query}`;
    return POST(new Request(url, { method: "POST", body: body.slice().buffer }), {
        params: Promise.resolve({ id: camera })
    });
}

beforeEach(() => {
    caller = { id: "user-1" };
    mayControl = true;
    feedTalk.mockReset();
    feedTalk.mockImplementation(() => true);
});

describe("the talk route", () => {
    it("feeds the caller's own talk and answers 204", async () => {
        const response = await post(new Uint8Array(4000));
        expect(response.status).toBe(204);
        expect(feedTalk).toHaveBeenCalledWith(CAMERA, "user-1", TALK, expect.any(Uint8Array));
        expect((feedTalk.mock.calls[0]![3] as Uint8Array).byteLength).toBe(4000);
    });

    it("refuses somebody signed out", async () => {
        caller = new Response("Unauthorized", { status: 401 });
        expect((await post(new Uint8Array(2))).status).toBe(401);
        expect(feedTalk).not.toHaveBeenCalled();
    });

    it("refuses somebody without home.control", async () => {
        mayControl = false;
        expect((await post(new Uint8Array(2))).status).toBe(403);
        expect(feedTalk).not.toHaveBeenCalled();
    });

    it("refuses a malformed camera or a missing talk", async () => {
        expect((await post(new Uint8Array(2), "nope")).status).toBe(400);
        expect((await post(new Uint8Array(2), CAMERA, null)).status).toBe(400);
        expect(feedTalk).not.toHaveBeenCalled();
    });

    it("refuses more than a second of audio at once", async () => {
        expect((await post(new Uint8Array(16_002))).status).toBe(413);
        expect(feedTalk).not.toHaveBeenCalled();
    });

    it("answers 409 for a talk that is over, and 429 for one fed too fast", async () => {
        feedTalk.mockImplementation(() => {
            throw new HomeError("This talk has ended");
        });
        expect((await post(new Uint8Array(2))).status).toBe(409);
        feedTalk.mockImplementation(() => false);
        expect((await post(new Uint8Array(2))).status).toBe(429);
    });
});
