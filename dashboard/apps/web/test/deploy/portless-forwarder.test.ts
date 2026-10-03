/**
 * Which services get the port-80 forwarder beside them.
 *
 * A Minecraft server on private networking was given one: socat on port 80
 * sending to 25565, which speaks Minecraft and nothing else. It shares the
 * server's network namespace, so every restart of the server killed it, and
 * beside a server that was crash-looping it restarted every few seconds - for a
 * port nothing would ever call. The forwarder is for web services.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { findApp } from "@/lib/apps/catalog";
import { describe, expect, it } from "vitest";
import { speaksHttp } from "@/lib/deploy/portless";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("a service that speaks HTTP", () => {
    it("is one built from a repository or deployed from an image, as before", () => {
        expect(speaksHttp({}, undefined)).toBe(true);
        expect(speaksHttp({ hostProtocol: "tcp" }, undefined)).toBe(true);
    });

    it("is a catalogue app that declares HTTP", () => {
        expect(speaksHttp({}, "http")).toBe(true);
    });
});

describe("a service that does not", () => {
    it("is a game server: it is reached by typing an address, on a port of its own", () => {
        // How every game server is installed (`install-service.ts`).
        expect(speaksHttp({ hostPort: 25565, hostProtocol: "tcp" }, undefined)).toBe(false);
        expect(speaksHttp({ hostPort: 19132, hostProtocol: "udp" }, undefined)).toBe(false);
    });

    it("is one whose main port is UDP", () => {
        expect(speaksHttp({ hostProtocol: "udp" }, undefined)).toBe(false);
    });

    it("is a catalogue app that declares TCP or UDP", () => {
        expect(speaksHttp({}, "tcp")).toBe(false);
        expect(speaksHttp({}, "udp")).toBe(false);
    });

    it("includes the Minecraft server the catalogue installs", () => {
        const minecraft = findApp("minecraft");
        expect(minecraft?.template?.ports?.[0]?.protocol).toBe("tcp");
        expect(speaksHttp({}, minecraft?.template?.ports?.[0]?.protocol)).toBe(false);
    });
});

describe("where the deploy asks", () => {
    it("only plans a forwarder for a service that speaks HTTP", async () => {
        const deploy = await readFile(`${SRC}lib/deploy-service.ts`, "utf8");
        expect(deploy).toContain("speaksHttp(source, await declaredProtocol(app.id, source))");
        expect(deploy).toContain("...(forwards ? { forwardPort: containerPort } : {})");
        expect(deploy).not.toContain(
            '...(app.target.runtime === "compose" ? { forwardPort: containerPort } : {})'
        );
    });
});
