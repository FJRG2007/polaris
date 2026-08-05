/**
 * How a name with nothing behind it is answered. The page itself is tested in
 * @polaris/core; what matters here is the status - which is what every client that is
 * not a person reads, and what the sweep jail counts - and that the guard says the page
 * came from it, since the control plane refuses to point the edge here otherwise.
 */

import { describe, expect, it } from "vitest";
import { sendVacant } from "../src/vacant.js";
import type { ServerResponse } from "node:http";
import { VACANT_DOWN_PATH, VACANT_HEADER, VACANT_HEADER_VALUE, VACANT_PATH } from "@polaris/core";

/** A ServerResponse stand-in that records what was written to it. */
function capture() {
    const written = { status: 0, headers: {} as Record<string, string>, body: "" };
    const res = {
        writeHead(status: number, headers: Record<string, string>) {
            written.status = status;
            written.headers = headers;
        },
        end(body: string) {
            written.body = body;
        }
    } as unknown as ServerResponse;
    return { res, written };
}

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("sendVacant", () => {
    it("answers a browser with the page, as a 404, for a name nothing claims", () => {
        const { res, written } = capture();

        sendVacant(res, { accept: HTML, host: "gone.plr.example.com", path: VACANT_PATH });

        expect(written.status).toBe(404);
        expect(written.headers["content-type"]).toContain("text/html");
        expect(written.body).toContain("There is nothing running here");
        expect(written.body).toContain("gone.plr.example.com");
    });

    it("answers a stopped app as a 502, saying so", () => {
        const { res, written } = capture();

        sendVacant(res, { accept: HTML, host: "app.plr.example.com", path: VACANT_DOWN_PATH });

        expect(written.status).toBe(502);
        expect(written.body).toContain("This app is not running");
    });

    it("answers anything that is not a browser with text", () => {
        const { res, written } = capture();

        sendVacant(res, { accept: "*/*", host: "gone.plr.example.com", path: VACANT_PATH });

        expect(written.status).toBe(404);
        expect(written.headers["content-type"]).toContain("text/plain");
        expect(written.body).toContain("NO_SERVICE_HERE");
        expect(written.body).not.toContain("<html");
    });

    it("marks the response as its own, which is what the edge is pointed here on", () => {
        const { res, written } = capture();

        sendVacant(res, { accept: HTML, path: VACANT_PATH });

        expect(written.headers[VACANT_HEADER]).toBe(VACANT_HEADER_VALUE);
    });

    it("is never cached, so a name stops being vacant the moment something is on it", () => {
        const { res, written } = capture();

        sendVacant(res, { accept: HTML, path: VACANT_PATH });

        expect(written.headers["cache-control"]).toBe("no-store");
    });
});
