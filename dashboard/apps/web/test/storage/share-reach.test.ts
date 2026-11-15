/**
 * A NAS share that does not answer is told apart: the device is there with its
 * file sharing refusing, or nothing answers at that address. Asked of real
 * sockets on the loopback, and of an address reserved for documentation that
 * nothing answers on.
 */

import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagnoseShare, knock, mountSourceHost, sharingPort } from "@/lib/storage/share-reach";
import { volumeBodyKey } from "@/lib/notifications/volume-events";
import en from "../../messages/en-US/notices.json";
import es from "../../messages/es-ES/notices.json";

let server: Server;
let openPort = 0;
let closedPort = 0;

async function listen(): Promise<Server> {
    const next = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => next.listen(0, "127.0.0.1", resolve));
    return next;
}

beforeAll(async () => {
    server = await listen();
    openPort = (server.address() as { port: number }).port;
    const spare = await listen();
    closedPort = (spare.address() as { port: number }).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("why a share does not answer", () => {
    it("is nothing to report when the file-sharing port answers", async () => {
        expect(await diagnoseShare("127.0.0.1", openPort, 500)).toBeNull();
    });

    it("is file sharing off when the device refuses that port", async () => {
        expect(await knock("127.0.0.1", closedPort, 500)).toBe("refused");
        expect(await diagnoseShare("127.0.0.1", closedPort, 500)).toBe("sharing-off");
    });

    it("is the host being down when nothing answers at the address", async () => {
        expect(await diagnoseShare("192.0.2.1", 445, 300)).toBe("host-down");
    }, 10_000);
});

describe("where a share is", () => {
    it("reads the host out of SMB and NFS sources", () => {
        expect(mountSourceHost("smb", "//nas.local/media")).toBe("nas.local");
        expect(mountSourceHost("smb", "\\\\10.0.0.5\\share")).toBe("10.0.0.5");
        expect(mountSourceHost("nfs", "10.0.0.5:/export/data")).toBe("10.0.0.5");
        expect(mountSourceHost("nfs", "[fd00::5]:/export")).toBe("fd00::5");
        expect(mountSourceHost("webdav", "https://x")).toBeNull();
        expect(sharingPort("smb")).toBe(445);
        expect(sharingPort("nfs")).toBe(2049);
    });
});

describe("the notice for each cause", () => {
    it("names a body that exists in both languages", () => {
        for (const cause of ["sharing-off", "host-down", null] as const) {
            const key = volumeBodyKey("unreachable", cause).split(".")[1]!;
            expect((en.volume as Record<string, string>)[key]).toBeTruthy();
            expect((es.volume as Record<string, string>)[key]).toBeTruthy();
        }
        expect(volumeBodyKey("detached", "host-down")).toBe("volume.detachedBody");
        expect(en.volume.unreachableSharingOffBody).toMatch(/File sharing is off on the NAS or it is restarting/);
    });
});
