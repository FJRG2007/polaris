/**
 * A module installed from a file never updates itself, so it says when its
 * Polaris knows of a newer one: a warning on the connection's status, a line
 * in its settings, and two variables a button can show.
 *
 * What is pinned here is what would be silently wrong: reading the plugin's
 * release instead of the module's, a warning that hides a real failure, and a
 * notice nobody can act on.
 */

import { FIXED_VARIABLES } from "../src/mapping";
import { describe, expect, it, vi } from "vitest";
import { phaseStatus, phaseText } from "../src/status";
import { updateFor } from "../../streamdeck/src/update";
import { Connection, type Host } from "../src/connection";
import { PolarisClient } from "../../streamdeck/src/polaris";

const ADDRESS = "https://polaris.example.com";
const LATEST = { streamdeck: "9.9.9", companion: "0.2.0", downloadsPath: "/account/downloads" };

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
    });
}

describe("whether a newer module is out", () => {
    it("reads the module's release, not the plugin's", () => {
        expect(updateFor(LATEST, "0.1.0", ADDRESS, "companion")).toEqual({
            version: "0.2.0",
            url: "https://polaris.example.com/account/downloads"
        });
        expect(updateFor(LATEST, "0.2.0", ADDRESS, "companion")).toBeNull();
        expect(updateFor({ ...LATEST, companion: null }, "0.1.0", ADDRESS, "companion")).toBeNull();
    });

    it("says nothing without an address to send somebody to", () => {
        expect(updateFor(LATEST, "0.1.0", null, "companion")).toBeNull();
    });

    it("still answers for the plugin by default", () => {
        expect(updateFor(LATEST, "0.1.0.0", ADDRESS)?.version).toBe("9.9.9");
    });
});

describe("how it is shown", () => {
    const update = { version: "0.2.0", url: `${ADDRESS}/account/downloads` };

    it("is a warning on a healthy connection, with the page to get it from", () => {
        const [status, message] = phaseStatus({ phase: "online" }, "Ada", update);
        expect(status).toBe("UnknownWarning");
        expect(message).toContain("0.2.0");
        expect(message).toContain(update.url);
        expect(phaseText({ phase: "online" }, "Ada", update)).toMatch(
            /^Signed in as Ada\. .*0\.2\.0/
        );
    });

    it("never covers up a real failure", () => {
        expect(phaseStatus({ phase: "unauthorized" }, "Ada", update)[0]).toBe(
            "AuthenticationFailure"
        );
        expect(phaseStatus({ phase: "offline", message: "down" }, "Ada", update)[0]).toBe(
            "ConnectionFailure"
        );
    });

    it("is the ordinary status when this is the newest", () => {
        expect(phaseStatus({ phase: "online" }, "Ada", null)[0]).toBe("Ok");
    });

    it("has variables a button can show", () => {
        const ids = FIXED_VARIABLES.map((variable) => variable.id);
        expect(ids).toContain("update_version");
        expect(ids).toContain("update_url");
    });
});

describe("the connection", () => {
    it("keeps the newest releases its Polaris answered with the catalogue", async () => {
        const fetcher = vi.fn(async () => json({ actions: [], latest: LATEST }));
        const host: Host = {
            phase: () => undefined,
            catalogue: () => undefined,
            readings: () => undefined,
            save: () => undefined,
            log: () => undefined
        };
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, { address: ADDRESS, token: "plr_x" });
        expect(connection.latest).toEqual(LATEST);
        expect(connection.current.phase).toBe("online");
        await connection.signOut();
        expect(connection.latest).toBeNull();
        connection.stop();
    });

    it("reads an older Polaris, which sends no releases, as nothing known", async () => {
        const fetcher = vi.fn(async () => json({ actions: [] }));
        const host: Host = {
            phase: () => undefined,
            catalogue: () => undefined,
            readings: () => undefined,
            save: () => undefined,
            log: () => undefined
        };
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, { address: ADDRESS, token: "plr_x" });
        expect(connection.latest).toBeNull();
        connection.stop();
    });
});
