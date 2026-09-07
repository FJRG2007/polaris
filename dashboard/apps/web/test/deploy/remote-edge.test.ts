/**
 * Handing a connected server its routes.
 *
 * Polaris is a control plane and not a data path: a domain on a remote server
 * resolves to that server, and that server's own Traefik serves it. So an app in a
 * data centre goes on answering while the control plane at the end of somebody's
 * home broadband is off, unreachable, or being updated - and everything here
 * exists to keep that true.
 *
 * Two properties, and both of them are about what happens when something goes
 * wrong halfway.
 *
 * **The write is atomic.** One file is how every domain on that server is reached.
 * Written in place, an interrupted write leaves it empty, and an empty routing file
 * is an edge answering `404 page not found` for services that are all running
 * perfectly - the exact outage the local edge learned this lesson from.
 *
 * **The pushed route outranks the container's own label.** Both declare the same
 * hostname; Traefik ranks by rule length unless told otherwise, so without a
 * number they tie, and a tie is settled by a line in a log nobody reads.
 */

import { describe, expect, it } from "vitest";
import { renderDynamicConfig, type AppRoute } from "@/lib/deploy/router";
import { remoteClearScript, remoteWriteScript } from "@/lib/deploy/router-remote";

const DIR = "/var/lib/polaris/traefik/dynamic";
const FILE = `${DIR}/polaris-apps.yml`;

function route(overrides: Partial<AppRoute> = {}): AppRoute {
    return {
        id: "abc",
        hostname: "app.example.com",
        certResolver: "le",
        dialHost: "shop-web-1f2e",
        dialPort: 3000,
        ...overrides
    };
}

describe("putting a config on a server", () => {
    const script = remoteWriteScript("http: {}\n", "nonce1");

    it("stops at the first thing that fails", () => {
        expect(script.startsWith("set -e")).toBe(true);
    });

    it("makes the directory, for a server prepared before it existed", () => {
        // Quoted only where a character would otherwise mean something to a
        // shell, which a plain path does not - see `quoteArg`.
        expect(script).toContain(`mkdir -p ${DIR}`);
    });

    it("never writes the file the edge is reading", () => {
        // The whole point. Everything lands beside it and is renamed over it.
        expect(script).not.toContain(`> ${FILE}`);
        expect(script).toContain(`mv -f ${DIR}/.polaris-apps.yml.nonce1 ${FILE}`);
    });

    it("carries the bytes as base64, whatever is in them", () => {
        // Traefik rules are full of backticks, and a rule is a sentence a shell
        // would happily rewrite on the way. Nothing here is interpolated into a
        // command: the payload is one opaque argument.
        const yaml = 'http:\n  routers:\n    r:\n      rule: "Host(`a.example.com`)"\n';
        const written = remoteWriteScript(yaml, "n2");
        const encoded = /printf %s '?([A-Za-z0-9+/=]+)'?/.exec(written)?.[1] ?? "";
        expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(yaml);
        expect(written).not.toContain("Host(`a.example.com`)");
    });

    it("gives each write its own temporary name", () => {
        // Two syncs racing must not share a scratch file: one finishing mid-write
        // of the other would rename half a config over the live one.
        expect(remoteWriteScript("a", "one")).not.toBe(remoteWriteScript("a", "two"));
        expect(remoteWriteScript("a")).not.toBe(remoteWriteScript("a"));
    });
});

describe("taking it back off", () => {
    it("removes only the file Polaris owns", () => {
        // Everything else in that directory belongs to whoever put it there.
        expect(remoteClearScript()).toBe(`rm -f ${FILE}`);
    });
});

describe("how a pushed route ranks", () => {
    it("says its rank out loud when one is asked for", () => {
        const config = renderDynamicConfig([route()], { routePriority: 100 });
        // Both the https router and the http redirect: a tie on either is a tie.
        expect(config.match(/priority: 100/g)?.length).toBe(2);
    });

    it("leaves the local edge exactly as it was", () => {
        // Nothing on this machine has a second route declaring the same hostname,
        // and re-ranking every route there would be a change to a live edge for no
        // reason at all.
        expect(renderDynamicConfig([route()])).not.toContain("priority: 100");
    });

    it("ranks a plain-http route too", () => {
        const config = renderDynamicConfig([route({ certResolver: "none" })], { routePriority: 100 });
        expect(config).toContain("priority: 100");
    });

    it("still dials the service it was given", () => {
        const config = renderDynamicConfig([route()], { routePriority: 100 });
        // By container name on the proxy network, which is what the edge on that
        // server can actually resolve - never a published port on a host it has no
        // reliable name for.
        expect(config).toContain('url: "http://shop-web-1f2e:3000"');
    });
});
