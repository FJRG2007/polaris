/**
 * Which guard listener the edge fetches the not-running page from.
 *
 * The forwardAuth listener when it serves the page, because the proxy listener reads
 * the error page's sub-request - which carries the route's signed origin - as app
 * traffic and dials the stopped app again. The proxy only for a guard too old to
 * serve it anywhere else, and nothing at all when neither does.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { VACANT_HEADER, VACANT_HEADER_VALUE } from "@polaris/core";

const AUTH = "http://polaris-edge-guard:8080";
const PROXY = "http://polaris-edge-guard:8081";

/** A fetch where only the listed bases answer with the page. */
function serving(...bases: string[]) {
    return vi.fn(async (url: string) => {
        const yes = bases.some((base) => url.startsWith(base));
        return new Response("", { headers: yes ? { [VACANT_HEADER]: VACANT_HEADER_VALUE } : {} });
    });
}

async function probe(now: number) {
    vi.resetModules();
    const { guardVacantUpstream } = await import("@/lib/deploy/router");
    return guardVacantUpstream(now);
}

afterEach(() => vi.unstubAllGlobals());

describe("the not-running page's upstream", () => {
    it("is the forwardAuth listener when the guard serves it there", async () => {
        vi.stubGlobal("fetch", serving(AUTH, PROXY));
        expect(await probe(1)).toBe(AUTH);
    });

    it("is the proxy for a guard that serves it only there", async () => {
        vi.stubGlobal("fetch", serving(PROXY));
        expect(await probe(1)).toBe(PROXY);
    });

    it("is nothing when no listener serves it", async () => {
        vi.stubGlobal("fetch", serving());
        expect(await probe(1)).toBeNull();
    });
});
