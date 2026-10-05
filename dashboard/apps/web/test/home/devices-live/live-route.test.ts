/**
 * The live channel answers exactly who the devices list answers.
 *
 * Signed out is refused, somebody who reaches nothing of Places is refused, a
 * visitor lent one door is sent that door and never causes a read of the
 * house's accounts, and somebody who lives here keeps the devices read for as
 * long as the stream is open - and stops it when it closes.
 */

import { device } from "./fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

type Reach = { everything: boolean; cameras: Map<string, string>; devices: Map<string, string> };

let caller: unknown = { id: "user-1" };
let reach: Reach = { everything: true, cameras: new Map(), devices: new Map() };
const released: string[] = [];
const watched: string[] = [];

vi.mock("@/lib/api-session", () => ({
    apiUser: async () => caller
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1", ownerId: "owner", name: "Home" })
}));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    placesReach: async () => reach
}));
vi.mock("@polaris-app/places/src/lib/current-place", () => ({
    currentPlace: async () => ({ current: { id: "place-1" }, places: [] })
}));
vi.mock("@polaris-app/places/src/lib/device-watch", () => ({
    watchDevices: (id: string) => {
        watched.push(id);
        return () => released.push(id);
    }
}));

const live = await import("@polaris-app/places/src/lib/device-live");
const { GET } = await import("@polaris-app/places/src/routes/api/home/devices/live/route");

/** Open the stream and collect what it writes until `until` has been seen. */
async function open() {
    const controller = new AbortController();
    const response = await GET(
        new Request("http://polaris.test/api/home/devices/live", { signal: controller.signal })
    );
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    async function readUntil(fragment: string): Promise<string> {
        while (!text.includes(fragment)) {
            const chunk = await reader!.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value);
        }
        return text;
    }
    return { response, readUntil, close: () => controller.abort() };
}

afterEach(() => {
    caller = { id: "user-1" };
    reach = { everything: true, cameras: new Map(), devices: new Map() };
    watched.length = 0;
    released.length = 0;
});

describe("the devices live channel", () => {
    it("refuses somebody signed out", async () => {
        caller = new Response("Unauthorized", { status: 401 });
        expect((await GET(new Request("http://polaris.test/"))).status).toBe(401);
    });

    it("refuses somebody who reaches nothing of Places", async () => {
        reach = { everything: false, cameras: new Map(), devices: new Map() };
        expect((await GET(new Request("http://polaris.test/"))).status).toBe(403);
        expect(watched).toEqual([]);
    });

    it("pushes a change to a resident, and keeps the devices read while open", async () => {
        const stream = await open();
        expect(stream.response.headers.get("Content-Type")).toContain("text/event-stream");
        await stream.readUntil('"ready"');
        expect(watched).toEqual(["install-1"]);

        live.announceDevices("install-1", [device({ id: "lamp-live", state: "on" })]);
        const text = await stream.readUntil("lamp-live");
        expect(text).toContain('"kind":"devices"');

        stream.close();
        expect(released).toEqual(["install-1"]);
    });

    it("sends a visitor their door alone, and never reads the accounts for them", async () => {
        reach = { everything: false, cameras: new Map(), devices: new Map([["door-1", "g"]]) };
        const stream = await open();
        await stream.readUntil('"ready"');
        expect(watched).toEqual([]);

        live.announceDevices("install-1", [
            device({ id: "lamp-2", state: "on" }),
            device({ id: "door-1", kind: "lock", state: "locked" })
        ]);
        live.announceAccounts("install-1", []);
        const text = await stream.readUntil("door-1");
        expect(text).not.toContain("lamp-2");
        expect(text).not.toContain("accounts");
        stream.close();
    });

    it("ignores another install's devices", async () => {
        const stream = await open();
        await stream.readUntil('"ready"');
        live.announceDevices("install-other", [device({ id: "elsewhere" })]);
        live.announceDevices("install-1", [device({ id: "here-1" })]);
        const text = await stream.readUntil("here-1");
        expect(text).not.toContain("elsewhere");
        stream.close();
    });
});
