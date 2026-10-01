/**
 * The CalDAV client against in-memory servers shaped like Nextcloud, iCloud
 * and a bare server with no sync-collection.
 *
 * What matters here is what a real account would hit: discovery from a bare
 * host, changes and deletions arriving through a sync token, a forgotten token
 * or a server without sync still giving the exact change set, and a write that
 * lost a race answering as a conflict instead of overwriting.
 */

import { describe, expect, it } from "vitest";
import {
    SyncAuthError,
    SyncConflictError,
    SyncRefusedError,
    SyncUnreachableError,
    createCalDavProvider,
    discoverCalDav,
    type PullState
} from "@polaris-app/calendar/src/lib/sync";
import { sameSite, send } from "@polaris-app/calendar/src/lib/sync/http";
import { createFakeCalDav, vevent } from "./fixtures/fake-caldav";

const NEXTCLOUD = "https://cloud.example.test";

function nextcloud(extra: Partial<Parameters<typeof createFakeCalDav>[0]> = {}) {
    const server = createFakeCalDav({
        origins: [NEXTCLOUD],
        username: "alice",
        password: "app-password",
        wellKnown: "/remote.php/dav/",
        principal: "/remote.php/dav/principals/users/alice/",
        home: "/remote.php/dav/calendars/alice/",
        ...extra
    });
    const personal = server.addCalendar({
        path: "/remote.php/dav/calendars/alice/personal/",
        name: "Personal",
        color: "#0082C9FF",
        components: ["VEVENT", "VTODO"]
    });
    const shared = server.addCalendar({
        path: "/remote.php/dav/calendars/alice/team_shared_by_bob/",
        name: "Team",
        color: "#FF2968",
        readOnly: true,
        components: ["VEVENT"]
    });
    return { server, personal, shared };
}

const state = (
    remoteId: string,
    syncToken = "",
    ctag = "",
    known: Map<string, string> = new Map()
): PullState => ({ remoteId, syncToken, ctag, known });

describe("discoverCalDav", () => {
    it("finds a Nextcloud account from its bare host through .well-known", async () => {
        const { server } = nextcloud();
        const found = await discoverCalDav({
            url: "cloud.example.test",
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        expect(server.requests[0]!.url).toBe(`${NEXTCLOUD}/.well-known/caldav`);
        expect(found.principalUrl).toBe(`${NEXTCLOUD}/remote.php/dav/principals/users/alice/`);
        expect(found.homeUrl).toBe(`${NEXTCLOUD}/remote.php/dav/calendars/alice/`);
        expect(found.calendars).toEqual([
            {
                remoteId: `${NEXTCLOUD}/remote.php/dav/calendars/alice/personal/`,
                name: "Personal",
                color: "#0082c9",
                description: "",
                timezone: null,
                readOnly: false,
                components: ["VEVENT", "VTODO"]
            },
            {
                remoteId: `${NEXTCLOUD}/remote.php/dav/calendars/alice/team_shared_by_bob/`,
                name: "Team",
                color: "#ff2968",
                description: "",
                timezone: null,
                readOnly: true,
                components: ["VEVENT"]
            }
        ]);
    });

    it("follows an iCloud-style principal on another host, with DAV: as the default namespace", async () => {
        const server = createFakeCalDav({
            origins: ["https://caldav.icloud.com", "https://p42-caldav.icloud.com"],
            username: "someone@example.test",
            password: "abcd-efgh-ijkl-mnop",
            davPrefix: "",
            wellKnown: null,
            principal: "https://p42-caldav.icloud.com/123456/principal/",
            home: "https://p42-caldav.icloud.com/123456/calendars/"
        });
        server.addCalendar({
            path: "/123456/calendars/home/",
            name: "Home",
            color: "#1BADF8FF",
            components: ["VEVENT"]
        });
        const found = await discoverCalDav({
            url: "https://caldav.icloud.com",
            username: "someone@example.test",
            password: "abcd-efgh-ijkl-mnop",
            fetcher: server.fetcher
        });
        expect(found.homeUrl).toBe("https://p42-caldav.icloud.com/123456/calendars/");
        expect(found.calendars.map((c) => [c.remoteId, c.color])).toEqual([
            ["https://p42-caldav.icloud.com/123456/calendars/home/", "#1badf8"]
        ]);
    });

    it("fails instead of reading the address as the home when the principal does not answer", async () => {
        const { server } = nextcloud();
        const fetcher = async (url: string, init: RequestInit & { timeoutMs?: number }) =>
            url.endsWith("/principals/users/alice/")
                ? new Response("busy", { status: 503 })
                : server.fetcher(url, init);
        await expect(
            discoverCalDav({ url: NEXTCLOUD, username: "alice", password: "app-password", fetcher })
        ).rejects.toBeInstanceOf(SyncUnreachableError);
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher
        });
        await expect(provider.listCalendars()).rejects.toBeInstanceOf(SyncUnreachableError);
    });

    it("does not send the password to a principal the server names on another host", async () => {
        const server = createFakeCalDav({
            origins: ["https://dav.example.co.uk", "https://another.co.uk"],
            username: "alice",
            password: "app-password",
            wellKnown: null,
            principal: "https://another.co.uk/principal/",
            home: "https://another.co.uk/calendars/"
        });
        await expect(
            discoverCalDav({
                url: "https://dav.example.co.uk/dav/",
                username: "alice",
                password: "app-password",
                fetcher: server.fetcher
            })
        ).rejects.toBeInstanceOf(SyncRefusedError);
        expect(server.requests.filter((r) => r.url.startsWith("https://another.co.uk"))).toEqual(
            []
        );
    });

    it("reports a refused password as an auth error", async () => {
        const { server } = nextcloud();
        await expect(
            discoverCalDav({
                url: NEXTCLOUD,
                username: "alice",
                password: "wrong",
                fetcher: server.fetcher
            })
        ).rejects.toBeInstanceOf(SyncAuthError);
    });

    it("never sends the password in an error message", async () => {
        const { server } = nextcloud();
        const error = await discoverCalDav({
            url: NEXTCLOUD,
            username: "alice",
            password: "s3cret-value",
            fetcher: server.fetcher
        }).catch((e: Error) => e);
        expect(String(error)).not.toContain("s3cret-value");
    });
});

describe("redirects", () => {
    it("refuses a downgrade from https to http", async () => {
        const fetcher = async (url: string) =>
            url.startsWith("https:")
                ? new Response(null, {
                      status: 301,
                      headers: { Location: "http://cloud.example.test/dav/" }
                  })
                : new Response("ok");
        await expect(
            send(fetcher, "https://cloud.example.test/.well-known/caldav")
        ).rejects.toBeInstanceOf(SyncRefusedError);
    });

    it("drops credentials when a redirect leaves the origin, keeps them for an iCloud partition", async () => {
        const seen: Record<string, string | undefined> = {};
        const fetcher = async (url: string, init: RequestInit) => {
            seen[new URL(url).host] = (init.headers as Record<string, string>).Authorization;
            if (url.startsWith("https://caldav.icloud.com"))
                return new Response(null, {
                    status: 307,
                    headers: { Location: "https://p1-caldav.icloud.com/x" }
                });
            if (url.startsWith("https://p1-caldav.icloud.com"))
                return new Response(null, {
                    status: 307,
                    headers: { Location: "https://elsewhere.example.net/y" }
                });
            return new Response("ok");
        };
        await send(fetcher, "https://caldav.icloud.com/", {
            headers: { Authorization: "Basic abc" }
        });
        expect(seen["caldav.icloud.com"]).toBe("Basic abc");
        expect(seen["p1-caldav.icloud.com"]).toBe("Basic abc");
        expect(seen["elsewhere.example.net"]).toBeUndefined();
    });

    it("drops credentials on a redirect to a sibling registrable domain, keeps them under the host", async () => {
        const seen: Record<string, string | undefined> = {};
        const fetcher = async (url: string, init: RequestInit) => {
            seen[new URL(url).host] = (init.headers as Record<string, string>).Authorization;
            if (url.startsWith("https://example.co.uk"))
                return new Response(null, {
                    status: 302,
                    headers: { Location: "https://dav.example.co.uk/x" }
                });
            if (url.startsWith("https://dav.example.co.uk"))
                return new Response(null, {
                    status: 302,
                    headers: { Location: "https://another.co.uk/y" }
                });
            return new Response("ok");
        };
        await send(fetcher, "https://example.co.uk/", { headers: { Authorization: "Basic abc" } });
        expect(seen["dav.example.co.uk"]).toBe("Basic abc");
        expect(seen["another.co.uk"]).toBeUndefined();
        expect(
            sameSite(new URL("https://mail.example.com/"), new URL("https://dav.example.com/"))
        ).toBe(false);
        expect(sameSite(new URL("https://example.com/"), new URL("http://dav.example.com/"))).toBe(
            false
        );
    });

    it("passes a refused address through as itself, not as an unreachable server", async () => {
        class RefusedAddressError extends Error {
            constructor() {
                super("That address cannot be reached from here.");
                this.name = "RefusedAddressError";
            }
        }
        const fetcher = async () => {
            throw new RefusedAddressError();
        };
        await expect(send(fetcher, "https://inside.example.test/")).rejects.toBeInstanceOf(
            RefusedAddressError
        );
    });

    it("stops after five redirects", async () => {
        let n = 0;
        const fetcher = async () =>
            new Response(null, { status: 302, headers: { Location: `/hop${++n}` } });
        await expect(send(fetcher, "https://loop.example.test/")).rejects.toThrow(
            /Too many redirects/
        );
        expect(n).toBe(6);
    });
});

describe("createCalDavProvider pull", () => {
    it("pulls everything first, then only changes and deletions through the sync token", async () => {
        const { server, personal } = nextcloud({ davPrefix: "x" });
        server.write(personal, "a.ics", vevent("a", "A"));
        server.write(personal, "b.ics", vevent("b", "B"));
        server.write(personal, "c.ics", vevent("c", "C"));
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const remoteId = `${NEXTCLOUD}${personal.path}`;

        const first = await provider.pull(state(remoteId));
        expect(first.changed.map((o) => o.href).sort()).toEqual([
            `${remoteId}a.ics`,
            `${remoteId}b.ics`,
            `${remoteId}c.ics`
        ]);
        expect(first.changed.find((o) => o.href.endsWith("a.ics"))!.ics).toContain("SUMMARY:A");
        expect(first.removed).toEqual([]);
        expect(first.syncToken).toMatch(/\/sync\/\d+$/);
        const known = new Map(first.changed.map((o) => [o.href, o.etag]));

        server.write(personal, "a.ics", vevent("a", "A changed"));
        server.write(personal, "d.ics", vevent("d", "D"));
        server.erase(personal, "b.ics");
        const before = server.requests.length;
        const second = await provider.pull(state(remoteId, first.syncToken, first.ctag, known));
        const methods = server.requests
            .slice(before)
            .map((r) => `${r.method} ${r.headers.depth ?? ""}`.trim());
        expect(methods).toEqual(["PROPFIND 0", "REPORT 0", "REPORT 1"]);
        expect(second.changed.map((o) => o.href).sort()).toEqual([
            `${remoteId}a.ics`,
            `${remoteId}d.ics`
        ]);
        expect(second.changed.find((o) => o.href.endsWith("a.ics"))!.ics).toContain(
            "SUMMARY:A changed"
        );
        expect(second.removed).toEqual([`${remoteId}b.ics`]);
        expect(second.full).toBe(false);

        const third = await provider.pull(state(remoteId, second.syncToken, second.ctag, known));
        expect(third.changed).toEqual([]);
        expect(third.removed).toEqual([]);
    });

    it("falls back to an etag diff when the server rejects the token", async () => {
        const { server, personal } = nextcloud();
        server.write(personal, "a.ics", vevent("a", "A"));
        const keep = server.write(personal, "b.ics", vevent("b", "B"));
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const remoteId = `${NEXTCLOUD}${personal.path}`;
        server.write(personal, "a.ics", vevent("a", "A2"));
        const known = new Map([
            [`${remoteId}a.ics`, '"stale"'],
            [`${remoteId}b.ics`, keep],
            [`${remoteId}gone.ics`, '"old"']
        ]);
        const result = await provider.pull(
            state(remoteId, "http://example.invalid/sync/9999", "", known)
        );
        expect(result.changed.map((o) => o.href)).toEqual([`${remoteId}a.ics`]);
        expect(result.removed).toEqual([`${remoteId}gone.ics`]);
        expect(result.syncToken).toMatch(/\/sync\/\d+$/);
    });

    it("uses ctag and etags, and GETs each body, on a server without sync-collection or multiget", async () => {
        const { server, personal } = nextcloud({ supportsSync: false, supportsMultiget: false });
        server.write(personal, "a.ics", vevent("a", "A"));
        server.write(personal, "b.ics", vevent("b", "B"));
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const remoteId = `${NEXTCLOUD}${personal.path}`;

        const first = await provider.pull(state(remoteId));
        expect(first.changed).toHaveLength(2);
        expect(first.syncToken).toBe("");
        expect(first.ctag).not.toBe("");
        const known = new Map(first.changed.map((o) => [o.href, o.etag]));

        const before = server.requests.length;
        const idle = await provider.pull(state(remoteId, "", first.ctag, known));
        expect(idle.changed).toEqual([]);
        expect(server.requests.length - before).toBe(1);

        server.write(personal, "b.ics", vevent("b", "B2"));
        server.erase(personal, "a.ics");
        const next = await provider.pull(state(remoteId, "", first.ctag, known));
        expect(next.changed.map((o) => [o.href, o.ics.includes("SUMMARY:B2")])).toEqual([
            [`${remoteId}b.ics`, true]
        ]);
        expect(next.removed).toEqual([`${remoteId}a.ics`]);
        expect(server.requests.some((r) => r.method === "GET" && r.url.endsWith("b.ics"))).toBe(
            true
        );
    });
});

describe("createCalDavProvider members listed without an etag", () => {
    it("keeps and reads a member whose getetag the listing answers 404, removing only the ones not listed", async () => {
        const { server, personal } = nextcloud({ supportsSync: false });
        server.write(personal, "a.ics", vevent("a", "A"));
        const keep = server.write(personal, "b.ics", vevent("b", "B"));
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const remoteId = `${NEXTCLOUD}${personal.path}`;
        server.withoutEtag.add("a.ics");
        const known = new Map([
            [`${remoteId}a.ics`, keep],
            [`${remoteId}b.ics`, keep],
            [`${remoteId}gone.ics`, '"old"']
        ]);
        const result = await provider.pull(state(remoteId, "", "", known));
        expect(result.removed).toEqual([`${remoteId}gone.ics`]);
        expect(result.changed.map((o) => o.href)).toEqual([`${remoteId}a.ics`]);
        expect(result.changed[0]!.ics).toContain("SUMMARY:A");
    });

    it("reads a member a sync report names without an etag instead of skipping it", async () => {
        const { server, personal } = nextcloud();
        server.write(personal, "a.ics", vevent("a", "A"));
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const remoteId = `${NEXTCLOUD}${personal.path}`;
        const first = await provider.pull(state(remoteId));
        const known = new Map(first.changed.map((o) => [o.href, o.etag]));
        server.write(personal, "a.ics", vevent("a", "A changed"));
        const fetcher = server.fetcher;
        const stripped = async (url: string, init: RequestInit & { timeoutMs?: number }) => {
            const answer = await fetcher(url, init);
            if (
                (init.method ?? "GET").toUpperCase() !== "REPORT" ||
                !String(init.body).includes("sync-collection")
            )
                return answer;
            const text = (await answer.text()).replace(/<d:getetag>[^<]*<\/d:getetag>/g, "");
            return new Response(text, { status: answer.status, headers: answer.headers });
        };
        const stripping = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: stripped
        });
        const next = await stripping.pull(state(remoteId, first.syncToken, first.ctag, known));
        expect(next.removed).toEqual([]);
        expect(next.changed.map((o) => [o.href, o.ics.includes("SUMMARY:A changed")])).toEqual([
            [`${remoteId}a.ics`, true]
        ]);
    });
});

describe("createCalDavProvider writes", () => {
    it("creates with If-None-Match: *, updates with If-Match, and answers 412 as a conflict", async () => {
        const { server, personal } = nextcloud();
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const target = { remoteId: `${NEXTCLOUD}${personal.path}` };

        const created = await provider.put(target, {
            href: null,
            etag: null,
            ics: vevent("new@x", "New"),
            uid: "new@x"
        });
        expect(created.href).toBe(`${NEXTCLOUD}${personal.path}new%40x.ics`);
        expect(server.requests.at(-1)!.headers["if-none-match"]).toBe("*");
        expect(personal.objects.get("new@x.ics")!.etag).toBe(created.etag);

        await expect(
            provider.put(target, {
                href: null,
                etag: null,
                ics: vevent("new@x", "Again"),
                uid: "new@x"
            })
        ).rejects.toBeInstanceOf(SyncConflictError);

        server.write(personal, "new@x.ics", vevent("new@x", "Changed on the phone"));
        await expect(
            provider.put(target, {
                href: created.href,
                etag: created.etag,
                ics: vevent("new@x", "Mine"),
                uid: "new@x"
            })
        ).rejects.toBeInstanceOf(SyncConflictError);
        expect(personal.objects.get("new@x.ics")!.ics).toContain("Changed on the phone");

        const current = personal.objects.get("new@x.ics")!.etag;
        const updated = await provider.put(target, {
            href: created.href,
            etag: current,
            ics: vevent("new@x", "Mine"),
            uid: "new@x"
        });
        expect(server.requests.at(-1)!.headers["if-match"]).toBe(current);
        expect(updated.etag).not.toBe(current);

        await expect(
            provider.remove(target, { href: created.href, etag: current })
        ).rejects.toBeInstanceOf(SyncConflictError);
        await provider.remove(target, { href: created.href, etag: updated.etag });
        expect(personal.objects.has("new@x.ics")).toBe(false);
    });

    it("asks for the etag when the PUT response carries none", async () => {
        const { server, personal } = nextcloud({ etagOnPut: false });
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        const created = await provider.put(
            { remoteId: `${NEXTCLOUD}${personal.path}` },
            { href: null, etag: null, ics: vevent("e", "E"), uid: "e" }
        );
        expect(server.requests.at(-1)!.method).toBe("PROPFIND");
        expect(created.etag).toBe(personal.objects.get("e.ics")!.etag);
    });

    it("lists calendars from the server URL alone", async () => {
        const { server } = nextcloud();
        const provider = createCalDavProvider({
            serverUrl: NEXTCLOUD,
            username: "alice",
            password: "app-password",
            fetcher: server.fetcher
        });
        expect((await provider.listCalendars()).map((c) => c.name)).toEqual(["Personal", "Team"]);
    });
});
