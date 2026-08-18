/**
 * Whether a call reaches this machine from outside.
 *
 * The card this feeds is the only place in Polaris that answers "why can I call
 * my flatmate and not my mother". So what it must never do is guess: a port that
 * did not answer proves nothing, because a probe from this box leaves and comes
 * back through the operator's own router and plenty of them will not route their
 * public address inward. Only an answer counts, and once one arrives it stands.
 */

import { createServer, type Server } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

let endpoint: { url: string; shipped: boolean } | null = null;
vi.mock("@/lib/chat/call-server", () => ({ callServer: async () => endpoint }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => "192.168.1.50" }));

const settings: Record<string, string> = {};
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings[key] ?? null,
    setSetting: async (key: string, value: string) => {
        settings[key] = value;
    }
}));

/** The address the probe knocks on, and the port it finds there. */
let probeHost: string | null = "127.0.0.1";
vi.mock("@/lib/net/port-probe", async (importActual) => ({
    ...(await importActual<typeof import("@/lib/net/port-probe")>()),
    publicProbeHost: async () => probeHost
}));

const { CALL_TCP_PORT } = await import("@/lib/chat/call-ports");
const { forgetProbe, readCallPorts } = await import("@/lib/chat/call-reach");

/** Something answering on the port the probe will try. */
async function listenOnCallPort(): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(CALL_TCP_PORT, "127.0.0.1", resolve);
    });
    return server;
}

beforeEach(() => {
    endpoint = { url: "/livekit", shipped: true };
    probeHost = "127.0.0.1";
    for (const key of Object.keys(settings)) delete settings[key];
    // The knock is rate limited to one every thirty seconds per process, which
    // is right for a page left open and wrong for a suite where each case is a
    // different deployment.
    forgetProbe();
});

describe("the call ports", () => {
    it("lists the media ports and says which one can be checked", async () => {
        const reading = await readCallPorts();
        expect(reading.ports.map((entry) => `${entry.port}/${entry.protocol}`)).toEqual([
            "7882/udp",
            "7881/tcp"
        ]);
        // The media mux answers nothing an unsolicited packet can get out of it,
        // so reporting it as unconfirmed would put a warning on a port that is
        // very likely already open.
        expect(reading.ports.find((entry) => entry.protocol === "udp")?.probeable).toBe(false);
    });

    it("knocks on nothing while nothing is asked of it", async () => {
        const reading = await readCallPorts();
        expect(reading.confirmed).toBe(false);
        // A page must paint before anything waits out a timeout.
        expect(reading.cannotProbe).toBeNull();
    });

    it("confirms the port once something answers on it", async () => {
        const server = await listenOnCallPort();
        try {
            const reading = await readCallPorts(true);
            expect(reading.confirmed).toBe(true);
            expect(reading.confirmedAt).not.toBeNull();
        } finally {
            server.close();
        }
    });

    it("keeps what was proven after the answer stops", async () => {
        const server = await listenOnCallPort();
        try {
            await readCallPorts(true);
        } finally {
            server.close();
        }
        forgetProbe();
        // The forward did not disappear because the container restarted, and a
        // badge that flickers back to "not confirmed" sends somebody into their
        // router to fix something that is not broken.
        expect((await readCallPorts(true)).confirmed).toBe(true);
    });

    it("concludes nothing from silence", async () => {
        const reading = await readCallPorts(true);
        expect(reading.confirmed).toBe(false);
        expect(reading.cannotProbe).toBeNull();
    });

    it("says so when there is no public address to knock on", async () => {
        probeHost = null;
        // Behind carrier NAT the address is shared with other customers, so what
        // answers on it need not be this machine - and calls from outside will
        // not work at all, which is worth saying rather than probing around.
        expect((await readCallPorts(true)).cannotProbe).toMatch(/public address/);
    });

    it("says nothing about a call server somebody else runs", async () => {
        endpoint = { url: "wss://calls.example.com", shipped: false };
        // Its ports are on its machine behind its router. None of this advice
        // applies, and the card reads this to draw nothing at all.
        expect((await readCallPorts(true)).shipped).toBe(false);
    });

    it("reports the server being down rather than blaming the router", async () => {
        endpoint = null;
        const reading = await readCallPorts(true);
        expect(reading.running).toBe(false);
        expect(reading.confirmed).toBe(false);
    });
});
