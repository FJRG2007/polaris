/**
 * The addresses the call server is allowed to hand out.
 *
 * This is asserted against the compose file rather than against code, because
 * the compose file is where it is decided - the call server is configured by one
 * block of YAML handed to it as an environment value, and there is no function
 * in between to test.
 *
 * The rule it holds is one this deployment learned the hard way. A machine
 * running containers has half a dozen bridge addresses; the call server was
 * offering every one of them beside the real address, and a note in the config
 * said they cost "a few wasted checks and nothing else". A call proved
 * otherwise: of two people joining, one settled on 172.18.0.1 - which nothing
 * outside a container can reach - and the other never connected at all and gave
 * up after fifteen seconds.
 *
 * They also decided which address was published as the public one. The server
 * asks STUN from every interface at once, keeps the first answer and discards
 * the rest, so the local address the public one is attached to is a race settled
 * anew on every restart. It landed on the real interface in August and on a
 * container bridge in September, which is what "it worked for days and then
 * stopped for no reason" actually was.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const COMPOSE = readFileSync(
    new URL("../../../../docker/docker-compose.yml", import.meta.url),
    "utf8"
);

/** The excluded ranges, as written in the call server's own configuration. */
const EXCLUDED = [...COMPOSE.matchAll(/^\s*-\s*(\d+\.\d+\.\d+\.\d+\/\d+)\s*$/gm)].map(
    (found) => found[1]!
);

/** An address as the number a mask is compared against. */
function asNumber(address: string): number {
    return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

/** Whether a block covers an address, which is the whole of what a CIDR means. */
function covers(block: string, address: string): boolean {
    const [network, bits] = block.split("/");
    const width = Number(bits);
    if (width === 0) return true;
    const mask = (0xffffffff << (32 - width)) >>> 0;
    return (asNumber(network!) & mask) >>> 0 === (asNumber(address) & mask) >>> 0;
}

const excluded = (address: string) => EXCLUDED.some((block) => covers(block, address));

describe("the addresses a call may be answered on", () => {
    it("excludes every address a container network hands out", () => {
        // docker0 is the first, and every network created for a project takes
        // the next free /16 upwards from it. Named ones could be listed by name;
        // a project's is `br-` and a hash, and there is nothing to write down -
        // which is why this is done by address.
        for (const bridge of [
            "172.17.0.1",
            "172.18.0.1",
            "172.19.0.1",
            "172.20.0.1",
            "172.21.0.1",
            "172.25.4.1",
            "172.31.255.1"
        ]) {
            expect([bridge, excluded(bridge)]).toEqual([bridge, true]);
        }
    });

    it("excludes libvirt's bridge and an address that means DHCP failed", () => {
        expect(excluded("192.168.122.1")).toBe(true);
        expect(excluded("169.254.13.9")).toBe(true);
    });

    it("leaves every address somebody might actually be called on", () => {
        // The cost of getting this wrong is the opposite failure and a worse
        // one: a house whose own network is hidden from the call server is a
        // house where two people in the same room have their call sent out to
        // the router and back, on a router that will usually not do it.
        for (const real of [
            "10.0.1.142",
            "192.168.0.10",
            "10.0.0.5",
            "10.42.7.1",
            // Docker never allocates from this one, so it is left alone: an
            // office LAN occasionally sits in it.
            "172.16.0.5",
            "198.51.100.186"
        ]) {
            expect([real, excluded(real)]).toEqual([real, false]);
        }
    });

    it("still offers the local address as well as the public one", () => {
        // Without this a call between two devices in the same house leaves it,
        // which is slower and, on a router that will not send a packet back to
        // the network it came from, does not work at all.
        expect(COMPOSE).toContain("advertise_internal_ip: true");
    });
});

describe("the one local address a call is offered", () => {
    // The livekit service's own start script, as compose hands it to the shell.
    const service = COMPOSE.slice(COMPOSE.search(/^ {2}livekit:/m));
    const script = service.slice(
        service.indexOf("    entrypoint:"),
        service.indexOf("    environment:")
    );
    const MARKER = "# includes: default-route address";

    it("asks the kernel for the default route's address and starts the server itself", () => {
        expect(script).toContain('ip "$$1" route get');
        expect(script).toContain("source_of -4 1.1.1.1");
        expect(script).toContain("exec /livekit-server");
    });

    it("escapes every dollar sign, so compose leaves the shell's variables alone", () => {
        // A single `$` is compose interpolation: `$src` would become an empty
        // string from .env and the address would never be written in.
        expect(script.replace(/\$\$/g, "")).not.toContain("$");
    });

    it("has exactly one place for the address, inside the ips block, which the script fills", () => {
        const lines = COMPOSE.split(/\r?\n/);
        const at = lines.findIndex((line) => line.trim() === MARKER);
        expect(lines.filter((line) => line.trim() === MARKER)).toHaveLength(1);
        expect(script).toContain(MARKER);
        // An include written there sits beside the exclusions, in rtc.ips.
        const indent = (line: string) => line.length - line.trimStart().length;
        const excludes = lines.findIndex(
            (line, index) => index > at && line.trim() === "excludes:"
        );
        const ips = lines.slice(0, at).findLastIndex((line) => line.trim() === "ips:");
        expect(indent(lines[at]!)).toBe(indent(lines[excludes]!));
        expect(indent(lines[ips]!)).toBeLessThan(indent(lines[at]!));
        expect(lines.slice(ips + 1, at).every((line) => line.trim().startsWith("#"))).toBe(true);
    });

    /** The script as the shell receives it, run with `ip` answering `routes`. */
    function start(routes: { v4: string; v6: string }): { config: string; log: string } {
        const body = script
            .split(/\r?\n/)
            .slice(script.split(/\r?\n/).findIndex((line) => line.trim() === "- |") + 1)
            .map((line) => line.replace(/^ {8}/, ""))
            .join("\n")
            .replace(/\$\$/g, "$")
            .replace("exec /livekit-server", "printf '%s\\n' \"$LIVEKIT_CONFIG\"");
        const ip = 'ip() { if [ "$1" = -4 ]; then printf \'%s\\n\' "$FAKE_V4"; else printf \'%s\\n\' "$FAKE_V6"; fi; }';
        const config = COMPOSE.slice(COMPOSE.indexOf("      LIVEKIT_CONFIG: |"))
            .split(/\r?\n/)
            .slice(1)
            .filter((line, index, all) => all.slice(0, index + 1).every((seen) => seen === "" || seen.startsWith("        ")))
            .map((line) => line.slice(8))
            .join("\n");
        const run = spawnSync("sh", ["-c", `${ip}\n${body}`], {
            encoding: "utf8",
            env: { ...process.env, LIVEKIT_CONFIG: config, FAKE_V4: routes.v4, FAKE_V6: routes.v6 }
        });
        expect(run.status).toBe(0);
        return { config: run.stdout, log: run.stderr };
    }

    const HAS_SH = spawnSync("sh", ["-c", "true"]).status === 0;
    const includesLine = (config: string) =>
        config.split("\n").find((line) => line.trim().startsWith("includes:")) ?? null;
    const markerIndent = (config: string) =>
        config.split("\n").find((line) => line.trim() === "excludes:")!.match(/^ */)![0];

    it.skipIf(!HAS_SH)(
        "writes the default route's IPv4 and IPv6 sources into rtc.ips.includes",
        () => {
            const { config } = start({
                v4: "1.1.1.1 via 192.168.1.1 dev br0 src 192.168.1.20 uid 0\n    cache",
                v6: "2606:4700:4700::1111 from :: via fe80::1 dev br0 proto ra src 2001:db8::20 metric 1024 pref medium"
            });
            expect(config).not.toContain(MARKER);
            expect(includesLine(config)).toBe(
                `${markerIndent(config)}includes: ["192.168.1.20/32", "2001:db8::20/128"]`
            );
        }
    );

    it.skipIf(!HAS_SH)(
        "narrows to the IPv4 address alone when there is no IPv6 route",
        () => {
            const { config } = start({
                v4: "1.1.1.1 via 10.0.0.1 dev wlan0 src 10.0.0.7 uid 0",
                v6: ""
            });
            expect(includesLine(config)).toBe(`${markerIndent(config)}includes: ["10.0.0.7/32"]`);
        }
    );

    it.skipIf(!HAS_SH)(
        "narrows nothing when the route goes through a tunnel or there is none",
        () => {
            for (const v4 of ["1.1.1.1 dev wg0 src 10.8.0.2 uid 0", ""]) {
                const { config, log } = start({ v4, v6: "" });
                expect(config).toContain(MARKER);
                expect(includesLine(config)).toBeNull();
                expect(log).toContain("no default route to narrow to");
            }
        }
    );
});
