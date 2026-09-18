/**
 * An app reads its services off a proxy, so what an unknown name does is the
 * whole of the error reporting here: a service the dashboard does not offer has
 * to say so, and a key a runtime reaches for on its own - `await` on an area,
 * `JSON.stringify` on one - must not be reported as a missing service.
 */

import { describe, expect, it } from "vitest";
import { hostProxy, lookup, provide } from "../src/registry";

interface Area {
    readonly [name: string]: unknown;
}

const services = { greetings: { hello: () => "hello" } };

describe("the services an app reads", () => {
    it("hands back what the dashboard provided", () => {
        provide("client", services);
        const proxy = hostProxy<{ greetings: Area }>("client", () => undefined);
        expect((proxy.greetings.hello as () => string)()).toBe("hello");
    });

    it("refuses a name the dashboard does not offer, inherited ones included", () => {
        expect(() => lookup(services, "client", "greetings", "goodbye")).toThrow(
            /no client service "greetings.goodbye"/
        );
        expect(() => lookup(services, "client", "greetings", "toString")).toThrow(
            /no client service "greetings.toString"/
        );
        expect(() => lookup(services, "client", "greetings", "hasOwnProperty")).toThrow(
            /no client service "greetings.hasOwnProperty"/
        );
    });

    it("lets an area be awaited and serialised rather than failing", async () => {
        provide("client", services);
        const proxy = hostProxy<{ greetings: Area }>("client", () => {
            throw new Error("asked too early");
        });
        await expect(Promise.resolve(proxy.greetings)).resolves.toBeTruthy();
        expect(JSON.stringify({ area: proxy.greetings })).toBe('{"area":{}}');
    });

    it("says nothing was provided yet in the side's own words", () => {
        const proxy = hostProxy<{ greetings: Area }>("server", (area, name) => {
            throw new Error(`asked for "${area}.${name}" too early`);
        });
        expect(() => proxy.greetings.hello).toThrow(/asked for "greetings.hello" too early/);
    });
});

describe("the server services an app takes before the dashboard provides them", () => {
    const slot = Symbol.for("polaris.app-host.server");
    const unprovide = () => delete (globalThis as Record<symbol, unknown>)[slot];

    it("can be taken at a module's top level and called once provided", async () => {
        unprovide();
        const { host, provideAppHost } = await import("../src/index");
        const area = (host as unknown as Record<string, Record<string, unknown>>).greetings;
        const hello = area?.hello as () => string;
        provideAppHost({ greetings: { hello: () => "hello" } } as never);
        expect(hello()).toBe("hello");
    });

    it("says so when one is called before then", async () => {
        unprovide();
        const { host } = await import("../src/index");
        const area = (host as unknown as Record<string, Record<string, unknown>>).greetings;
        const hello = area?.hello as () => string;
        expect(() => hello()).toThrow(/called "greetings.hello" before the dashboard provided/);
    });
});
