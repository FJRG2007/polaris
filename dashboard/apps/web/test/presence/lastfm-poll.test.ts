/**
 * Asking Last.fm what people are listening to.
 *
 * What is pinned:
 * - nothing is asked without a key, and nobody with a Spotify link of their own
 *   is asked here (Spotify says it better: position, length, Listen along);
 * - only somebody here, with music sharing on, is asked - and at most once a
 *   window, whatever the pass rate;
 * - the song goes on the same card as a Spotify one, keyed so the card knows
 *   it came from Last.fm, and keeps its start while it is the same song;
 * - a 29 stops every request for a while, a refused key stops them for longer,
 *   and an unknown user is left alone rather than asked every pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    key: "key-1" as string | null,
    links: [] as { userId: string; label: string }[],
    spotify: [] as { userId: string }[],
    here: new Set<string>(),
    settings: new Map<string, Record<string, unknown>>(),
    activity: [] as {
        userId: string;
        source: string;
        key: string;
        startedAt: Date;
        expiresAt: Date;
    }[],
    playing: new Map<string, unknown>(),
    asked: [] as string[],
    fail: null as Error | null
}));

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => (fake.key ? { enabled: true, config: {} } : null),
    getIntegrationSecret: async () => fake.key
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findMany: async ({ where }: { where: { provider: string } }) =>
                where.provider === "lastfm" ? fake.links : fake.spotify
        },
        sessionState: {
            groupBy: async () => [...fake.here].map((userId) => ({ userId }))
        },
        userActivitySettings: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((id) => fake.settings.has(id))
                    .map((id) => ({ userId: id, ...fake.settings.get(id) }))
        },
        userActivity: {
            findUnique: async ({
                where
            }: {
                where: { userId_source: { userId: string; source: string } };
            }) =>
                fake.activity.find(
                    (row) =>
                        row.userId === where.userId_source.userId &&
                        row.source === where.userId_source.source
                ) ?? null,
            upsert: async ({ create }: { create: (typeof fake.activity)[number] }) => {
                fake.activity = fake.activity.filter(
                    (row) => !(row.userId === create.userId && row.source === create.source)
                );
                fake.activity.push(create);
            },
            deleteMany: async ({ where }: { where: { userId: string; source: string } }) => {
                const before = fake.activity.length;
                fake.activity = fake.activity.filter(
                    (row) => !(row.userId === where.userId && row.source === where.source)
                );
                return { count: before - fake.activity.length };
            }
        }
    }
}));

vi.mock("@/lib/connections/lastfm", async (original) => {
    const real = await original<typeof import("@/lib/connections/lastfm")>();
    return {
        ...real,
        readLastfmPlaying: async (_key: string, user: string) => {
            fake.asked.push(user);
            if (fake.fail) throw fake.fail;
            return fake.playing.get(user) ?? null;
        }
    };
});
vi.mock("@/lib/privacy-service", () => ({ allowedBy: async () => new Set() }));
vi.mock("@/lib/presence-activity/live", () => ({ announceActivity: async () => undefined }));

const poll = await import("@/lib/presence-activity/lastfm-poll");
const lastfm = await import("@/lib/connections/lastfm");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function song(name: string) {
    return {
        key: `lastfm:artist|${name}`,
        name,
        artists: "Artist",
        album: "Album",
        imageUrl: null,
        linkUrl: null
    };
}

beforeEach(() => {
    poll.resetLastfmSchedule();
    fake.key = "key-1";
    fake.links = [
        { userId: USER_A, label: "listener_a" },
        { userId: USER_B, label: "listener_b" }
    ];
    fake.spotify = [];
    fake.here = new Set([USER_A]);
    fake.settings.clear();
    fake.activity = [];
    fake.playing.clear();
    fake.asked = [];
    fake.fail = null;
});

describe("a pass", () => {
    it("asks nothing without a key", async () => {
        fake.key = null;
        expect(await poll.pollLastfm(0)).toEqual({
            asked: 0,
            skipped: "no Last.fm API key is connected"
        });
        expect(fake.asked).toEqual([]);
    });

    it("asks only somebody here with sharing on, and shows their song on the music card", async () => {
        fake.playing.set("listener_a", song("one"));
        expect((await poll.pollLastfm(0)).asked).toBe(1);
        expect(fake.asked).toEqual(["listener_a"]);
        expect(fake.activity).toMatchObject([
            { userId: USER_A, source: "spotify", key: "lastfm:artist|one" }
        ]);
    });

    it("leaves somebody with a Spotify link to the Spotify poll", async () => {
        fake.spotify = [{ userId: USER_A }];
        await poll.pollLastfm(0);
        expect(fake.asked).toEqual([]);
    });

    it("does not ask somebody who switched music sharing off", async () => {
        fake.settings.set(USER_A, {
            share: true,
            spotify: false,
            games: true,
            minecraft: true,
            hiddenGames: "[]",
            customGames: "[]",
            seenGames: "[]"
        });
        await poll.pollLastfm(0);
        expect(fake.asked).toEqual([]);
    });

    it("asks each person at most once a window, and keeps the start of the same song", async () => {
        fake.playing.set("listener_a", song("one"));
        await poll.pollLastfm(0);
        const started = fake.activity[0]!.startedAt;
        await poll.pollLastfm(15_000);
        expect(fake.asked).toHaveLength(1);
        await poll.pollLastfm(poll.LASTFM_WINDOW_MS);
        expect(fake.asked).toHaveLength(2);
        expect(fake.activity[0]!.startedAt).toEqual(started);
        fake.playing.set("listener_a", song("two"));
        await poll.pollLastfm(2 * poll.LASTFM_WINDOW_MS);
        expect(fake.activity[0]!.startedAt.getTime()).toBeGreaterThan(started.getTime());
    });

    it("takes the card down when nothing plays", async () => {
        fake.playing.set("listener_a", song("one"));
        await poll.pollLastfm(0);
        fake.playing.clear();
        await poll.pollLastfm(poll.LASTFM_WINDOW_MS);
        expect(fake.activity).toEqual([]);
    });

    it("stops everything on a 29, and on a refused key for longer", async () => {
        fake.here = new Set([USER_A, USER_B]);
        fake.fail = new lastfm.LastfmRateLimited();
        expect((await poll.pollLastfm(0)).asked).toBe(1);
        expect((await poll.pollLastfm(poll.LASTFM_WINDOW_MS)).skipped).toBe(
            "Last.fm asked for fewer requests"
        );
        poll.resetLastfmSchedule();
        fake.fail = new lastfm.LastfmKeyRefused();
        await poll.pollLastfm(0);
        expect((await poll.pollLastfm(5 * 60_000)).skipped).toBe("Last.fm refused the API key");
    });

    it("leaves an unknown username alone for a long while", async () => {
        fake.fail = new lastfm.LastfmUnknownUser();
        await poll.pollLastfm(0);
        await poll.pollLastfm(10 * poll.LASTFM_WINDOW_MS);
        expect(fake.asked).toEqual(["listener_a"]);
    });
});
