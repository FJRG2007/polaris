/**
 * Name lookups with the internet gone. The resolver below never answers an
 * outside name until told to - the hanging `getaddrinfo` of a dead line - and the
 * local names a dashboard calls itself and its neighbours by must still be
 * answered at once, while outside ones fail fast once the first has failed.
 */

import { describe, expect, it } from "vitest";
import { Breaker } from "@/lib/offline/breaker";
import { createOutboundLookup, isLocalName, parseHosts, PROBE_NAME } from "@/lib/offline/outbound-lookup";

type Address = { address: string; family: number };
type Pending = { hostname: string; done: (error: NodeJS.ErrnoException | null, addresses: Address[]) => void };

function offlineResolver() {
    const pending: Pending[] = [];
    const resolve = (hostname: string, _options: unknown, done: Pending["done"]) => {
        pending.push({ hostname, done });
    };
    const failAll = (code = "EAI_AGAIN") => {
        for (const entry of pending.splice(0)) {
            entry.done(Object.assign(new Error(`getaddrinfo ${code}`), { code }), []);
        }
    };
    const answerAll = (address = "203.0.113.7") => {
        for (const entry of pending.splice(0)) entry.done(null, [{ address, family: 4 }]);
    };
    return { pending, resolve, failAll, answerAll };
}

function ask(lookup: (h: string, o: unknown, c?: unknown) => void, hostname: string, options: unknown = {}) {
    return new Promise<{ error: NodeJS.ErrnoException | null; address?: unknown; family?: number }>((done) =>
        lookup(hostname, options, (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) =>
            done({ error, address, family })
        )
    );
}

function setup() {
    let now = 0;
    const resolver = offlineResolver();
    const breaker = new Breaker({ now: () => now, firstRetryMs: 15_000, threshold: 3 });
    const hosts = parseHosts("127.0.0.1 localhost\n172.17.0.1 host.docker.internal # gateway\n");
    const made = createOutboundLookup({ resolve: resolver.resolve, hosts, breaker, now: () => now });
    return { ...made, resolver, advance: (ms: number) => (now += ms) };
}

describe("isLocalName", () => {
    it.each(["localhost", "polaris-hostd", "postgres", "10.0.0.2", "::1", "polaris.local", "nas.lan", "x.home.arpa"])(
        "treats %s as local",
        (name) => expect(isLocalName(name)).toBe(true)
    );
    it.each(["api.github.com", "oauth2.googleapis.com"])("treats %s as outside", (name) =>
        expect(isLocalName(name)).toBe(false)
    );
});

describe("createOutboundLookup", () => {
    it("answers localhost and /etc/hosts names while every outside lookup hangs", async () => {
        const { lookup, resolver } = setup();
        // Fill what would be the thread pool with lookups that never come back.
        for (let i = 0; i < 8; i++) lookup(`hang${i}.example.com`, {}, () => undefined);
        expect(resolver.pending).toHaveLength(8);

        const started = performance.now();
        const [self, gateway, both] = await Promise.all([
            ask(lookup, "localhost"),
            ask(lookup, "host.docker.internal", { all: true }),
            ask(lookup, "localhost", { all: true })
        ]);
        expect(performance.now() - started).toBeLessThan(50);
        expect(self).toMatchObject({ error: null, address: "127.0.0.1", family: 4 });
        expect(gateway.address).toEqual([{ address: "172.17.0.1", family: 4 }]);
        expect(both.address).toEqual([
            { address: "127.0.0.1", family: 4 },
            { address: "::1", family: 6 }
        ]);
        // None of them reached the resolver.
        expect(resolver.pending).toHaveLength(8);
    });

    it("honours a numeric family the way dns.lookup does", async () => {
        const { lookup } = setup();
        expect(await ask(lookup, "localhost", 6)).toMatchObject({ address: "::1", family: 6 });
    });

    it("opens on the first EAI_AGAIN and fails every outside lookup fast after it", async () => {
        const { lookup, resolver, breaker } = setup();
        const first = ask(lookup, "oauth2.googleapis.com");
        resolver.failAll();
        expect((await first).error?.code).toBe("EAI_AGAIN");
        expect(breaker.isOpen).toBe(true);

        const fast = await ask(lookup, "api.github.com");
        expect(fast.error?.code).toBe("EAI_AGAIN");
        expect(fast.error?.syscall).toBe("getaddrinfo");
        expect(resolver.pending).toHaveLength(0);
        // Local names are untouched by it.
        expect((await ask(lookup, "localhost")).error).toBeNull();
    });

    it("probes after the window and recovers by itself", async () => {
        const { lookup, resolver, breaker, advance } = setup();
        const first = ask(lookup, PROBE_NAME);
        resolver.failAll();
        await first;
        advance(15_000);

        const probe = ask(lookup, PROBE_NAME);
        expect(resolver.pending).toHaveLength(1);
        // Everybody else is still refused while the probe is out.
        expect((await ask(lookup, "example.org")).error?.code).toBe("EAI_AGAIN");
        resolver.answerAll();
        expect((await probe).error).toBeNull();
        expect(breaker.isOpen).toBe(false);

        const after = ask(lookup, "example.org");
        resolver.answerAll();
        expect((await after).address).toBe("203.0.113.7");
    });

    it("asks once for the same name and serves it from the cache after", async () => {
        const { lookup, resolver } = setup();
        const both = Promise.all([ask(lookup, "example.org"), ask(lookup, "example.org")]);
        expect(resolver.pending).toHaveLength(1);
        resolver.answerAll();
        expect((await both).map((entry) => entry.address)).toEqual(["203.0.113.7", "203.0.113.7"]);
        expect((await ask(lookup, "example.org")).address).toBe("203.0.113.7");
        expect(resolver.pending).toHaveLength(0);
    });

    it("forgets a missing name quickly and never opens on it", async () => {
        const { lookup, resolver, breaker, advance } = setup();
        const missing = ask(lookup, "nope.example.org");
        resolver.failAll("ENOTFOUND");
        expect((await missing).error?.code).toBe("ENOTFOUND");
        expect(breaker.isOpen).toBe(false);
        expect((await ask(lookup, "nope.example.org")).error?.code).toBe("ENOTFOUND");
        expect(resolver.pending).toHaveLength(0);
        advance(5_000);
        lookup("nope.example.org", {}, () => undefined);
        expect(resolver.pending).toHaveLength(1);
    });
});
