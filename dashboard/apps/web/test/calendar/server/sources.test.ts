/**
 * Linking outside calendars: every kind is checked before anything is stored
 * - a CalDAV server by discovery, a feed by one fetch, a linked account by the
 * access it was granted - and each refusal is a sentence the person can act on,
 * a private address included.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import { createFakeCalDav } from "../sync/fixtures/fake-caldav";
import * as sources from "@polaris-app/calendar/src/lib/sources";

const CLOUD = "https://cloud.example.test";

function feed(): string {
    return engine.serializeItem(
        engine.eventItem(world.event({ uid: "holiday-1", summary: "National day", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }))
    );
}

describe("calendar sources", () => {
    let alice: ReturnType<typeof addUser>;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
    });

    function cloud() {
        const server = createFakeCalDav({
            origins: [CLOUD],
            username: "alice",
            password: "app-password",
            wellKnown: "/remote.php/dav/",
            principal: "/remote.php/dav/principals/users/alice/",
            home: "/remote.php/dav/calendars/alice/"
        });
        server.addCalendar({ path: "/remote.php/dav/calendars/alice/personal/", name: "Personal", color: "#0082C9FF", components: ["VEVENT"] });
        fake.fetchHandler = (url, init) => server.fetcher(url, init);
        return server;
    }

    it("refuses a CalDAV server that refuses the password, and stores nothing", async () => {
        cloud();
        await expect(sources.addCalDav(alice, { url: CLOUD, username: "alice", password: "wrong" })).rejects.toThrow(world.en("sources.refusedCredentials"));
        expect(db.rows("calendarSource")).toEqual([]);
        expect(db.rows("calendar")).toEqual([]);
    });

    it("links a CalDAV server that answers, with the password sealed, and pulls its calendars", async () => {
        cloud();
        const id = await sources.addCalDav(alice, { url: CLOUD, username: "alice", password: "app-password" });
        const row = db.byId("calendarSource", id)!;
        expect(row).toMatchObject({ kind: "caldav", username: "alice", label: "alice (cloud.example.test)", secretKeyId: "fake-key" });
        expect(Buffer.from(row.encryptedSecret as Uint8Array).toString("utf8")).toBe("app-password");
        await world.settle();
        expect(db.rows("calendar").map((calendar) => calendar.name)).toEqual(["Personal"]);
    });

    it("checks a feed before storing it", async () => {
        fake.fetchHandler = async () => new Response("<html>not a calendar</html>", { status: 200 });
        await expect(
            sources.addFeed(alice, { url: "https://feeds.example.test/holidays.ics", name: "Holidays", color: "#2ca02c", refreshMinutes: 60 })
        ).rejects.toThrow(world.en("sources.notACalendar"));
        expect(db.rows("calendarSource")).toEqual([]);

        fake.fetchHandler = async () => new Response(feed(), { status: 200, headers: { "Content-Type": "text/calendar" } });
        const id = await sources.addFeed(alice, { url: "webcal://feeds.example.test/holidays.ics", name: "Holidays", color: "#2ca02c", refreshMinutes: 60 });
        expect(db.byId("calendarSource", id)).toMatchObject({ kind: "ics", label: "Holidays", refreshMinutes: 60 });
        const calendar = db.rows("calendar").find((row) => row.sourceId === id)!;
        expect(calendar).toMatchObject({ readOnly: true, kind: "remote", name: "Holidays" });
        await world.settle();
        expect(db.rows("calendarObject").map((row) => row.summary)).toEqual(["National day"]);
        expect(db.rows("calendar").filter((row) => row.sourceId === id).map((row) => [row.id, row.name, row.color])).toEqual([[calendar.id, "Holidays", "#2ca02c"]]);
    });

    it("seals a feed's address, keeps only its host and tail in the clear, and never answers it whole", async () => {
        const secret = "https://feeds.example.test/private/0123456789abcdef/basic.ics?token=s3cr3tvalue";
        fake.fetchHandler = async () => new Response(feed(), { status: 200 });
        const id = await sources.addFeed(alice, { url: secret.replace("https://", "webcal://"), name: "Private", color: "#2ca02c", refreshMinutes: 60 });
        const row = db.byId("calendarSource", id)!;
        expect(Buffer.from(row.encryptedSecret as Uint8Array).toString("utf8")).toBe(secret);
        expect(row.url).toBe("https://feeds.example.test/...alue");
        expect(db.rows("calendar").find((calendar) => calendar.sourceId === id)?.remoteId).toBe("feed");
        await world.settle();
        expect(fake.fetches.map((request) => request.url)).toEqual([secret, secret]);
        const [listed] = await sources.listSources(alice);
        expect(JSON.stringify(listed)).not.toContain("s3cr3t");
        expect(JSON.stringify(listed)).not.toContain("0123456789abcdef");
        expect(listed?.url).toBe("https://feeds.example.test/...alue");
    });

    it("seals a feed subscribed before addresses were, keeping its calendar", async () => {
        const url = "https://feeds.example.test/private/legacy-token/basic.ics";
        const id = db.insert("calendarSource", { userId: alice.id, kind: "ics", label: "Old", url }).id as string;
        const calendarId = db.insert("calendar", { ownerId: alice.id, sourceId: id, kind: "remote", remoteId: url, name: "Old", readOnly: true }).id as string;
        const [listed] = await sources.listSources(alice);
        expect(listed?.url).toBe("https://feeds.example.test/....ics");
        const row = db.byId("calendarSource", id)!;
        expect(Buffer.from(row.encryptedSecret as Uint8Array).toString("utf8")).toBe(url);
        expect(row.url).not.toContain("legacy-token");
        expect(db.byId("calendar", calendarId)?.remoteId).toBe("feed");
        expect(await sources.subscribedAmong(alice, [url, "https://feeds.example.test/other.ics"])).toEqual([url]);
    });

    it("replaces a feed's address once the new one answers, and keeps the old one when it does not", async () => {
        fake.fetchHandler = async () => new Response(feed(), { status: 200, headers: { ETag: "\"v1\"" } });
        const id = await sources.addFeed(alice, { url: "https://feeds.example.test/old.ics", name: "Feed", color: "#2ca02c", refreshMinutes: 60 });
        await vi.waitFor(() => expect(db.byId("calendarSource", id)?.lastSyncAt).toBeInstanceOf(Date));
        const calendar = db.rows("calendar").find((row) => row.sourceId === id)!;
        expect(calendar.syncToken).toBe("\"v1\"");

        fake.fetchHandler = async () => new Response("<html>no</html>", { status: 200 });
        await expect(sources.updateSource(alice, id, { url: "https://feeds.example.test/wrong.ics" })).rejects.toThrow(world.en("sources.notACalendar"));
        expect(Buffer.from(db.byId("calendarSource", id)?.encryptedSecret as Uint8Array).toString("utf8")).toBe("https://feeds.example.test/old.ics");

        fake.fetchHandler = async () => new Response(feed(), { status: 200 });
        const view = await sources.updateSource(alice, id, { url: "https://feeds.example.test/new.ics" });
        expect(view).toMatchObject({ id, status: "ok", url: "https://feeds.example.test/....ics" });
        expect(Buffer.from(db.byId("calendarSource", id)?.encryptedSecret as Uint8Array).toString("utf8")).toBe("https://feeds.example.test/new.ics");
        expect(db.byId("calendar", String(calendar.id))?.syncToken).toBe("");
        await vi.waitFor(() => expect(fake.fetches.at(-1)?.url).toBe("https://feeds.example.test/new.ics"));
        await world.settle();
        expect(db.rows("calendar").filter((row) => row.sourceId === id).map((row) => row.id)).toEqual([calendar.id]);
    });

    it("refuses a linked account that was not granted calendars, and one that is not theirs", async () => {
        fake.links.push({ id: "018f2b7a-0000-7000-8000-0000000000a1", provider: "google", label: "alice@gmail.example", grantsCalendar: false });
        await expect(sources.addLinkedAccount(alice, "018f2b7a-0000-7000-8000-0000000000a1")).rejects.toThrow(world.en("sources.linkNeedsCalendar"));
        await expect(sources.addLinkedAccount(alice, "018f2b7a-0000-7000-8000-0000000000ff")).rejects.toThrow(world.en("sources.linkNotFound"));
        expect(db.rows("calendarSource")).toEqual([]);
    });

    it("links an account granted calendars once, however many times it is added", async () => {
        fake.links.push({ id: "018f2b7a-0000-7000-8000-0000000000a2", provider: "microsoft", label: "alice@outlook.example", grantsCalendar: true });
        const first = await sources.addLinkedAccount(alice, "018f2b7a-0000-7000-8000-0000000000a2");
        const second = await sources.addLinkedAccount(alice, "018f2b7a-0000-7000-8000-0000000000a2");
        expect(second).toBe(first);
        expect(db.rows("calendarSource")).toHaveLength(1);
        expect(db.byId("calendarSource", first)).toMatchObject({ kind: "microsoft", connectionId: "018f2b7a-0000-7000-8000-0000000000a2" });
        await world.settle();
    });

    it("refuses an address on a private network to somebody who does not administer Polaris", async () => {
        fake.fetchHandler = async () => new Response(feed(), { status: 200 });
        await expect(
            sources.addFeed(alice, { url: "http://192.168.1.20/calendar.ics", name: "LAN", color: "#2ca02c", refreshMinutes: 60 })
        ).rejects.toThrow(world.en("sources.privateAddress"));
        await expect(sources.addCalDav(alice, { url: "http://10.0.0.5/dav", username: "alice", password: "pw" })).rejects.toThrow(
            world.en("sources.privateAddress")
        );
        expect(db.rows("calendarSource")).toEqual([]);
        expect(fake.fetches.every((request) => request.allowPrivate === false)).toBe(true);
    });

    it("lets an administrator reach their own network", async () => {
        const admin = addUser({ name: "Root", email: "root@example.test", isAdmin: true });
        fake.fetchHandler = async () => new Response(feed(), { status: 200 });
        const id = await sources.addFeed(admin, { url: "http://192.168.1.20/calendar.ics", name: "LAN", color: "#2ca02c", refreshMinutes: 60 });
        expect(Buffer.from(db.byId("calendarSource", id)?.encryptedSecret as Uint8Array).toString("utf8")).toBe("http://192.168.1.20/calendar.ics");
        expect(fake.fetches[0]?.allowPrivate).toBe(true);
        await world.settle();
    });

    it("only lets the owner refresh, change or remove a source", async () => {
        const bob = addUser({ name: "Bob", email: "bob@example.test" });
        const id = db.insert("calendarSource", { userId: alice.id, kind: "ics", label: "Feed", url: "https://feeds.example.test/a.ics" }).id as string;
        await expect(sources.removeSource(bob, id)).rejects.toThrow(world.en("sources.notFound"));
        await expect(sources.updateSource(bob, id, { refreshMinutes: 60 })).rejects.toThrow(world.en("sources.notFound"));
        await sources.updateSource(alice, id, { refreshMinutes: 120 });
        expect(db.byId("calendarSource", id)?.refreshMinutes).toBe(120);
        await sources.removeSource(alice, id);
        expect(db.byId("calendarSource", id)).toBeUndefined();
    });
});
