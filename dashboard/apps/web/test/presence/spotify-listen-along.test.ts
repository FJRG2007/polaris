/**
 * Asking Spotify what people are playing, and listening along.
 *
 * What is pinned:
 * - only an account that is here with sharing on - or is in a listen-along - is
 *   asked about, and one that stops being wanted has its card taken down;
 * - a playing track is asked about again when it is due to end, at most thirty
 *   seconds on (ten while hosting); nothing playing backs off to five minutes;
 * - one 429 stops the whole pass until Spotify's own Retry-After;
 * - starting a listen-along goes through the presence rule, so a card the
 *   listener may not see refuses exactly like an empty one, and says what to do
 *   when they have linked nothing or have no Premium;
 * - a host's next song is put on every listener, a pause pauses them, and a host
 *   who stops being visible to a listener ends that listener's session - paused
 *   or not, and a pause that outlasts its bound or a host who unlinks ends it too;
 * - only Spotify refusing the listener ends it: a blip is tried again;
 * - a song's position is worked out when it was read, not when the pass began;
 * - a listener is only taken to have taken their Spotify back after two
 *   sightings of something else, apart by the grace, so the moment between two
 *   songs does not end it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Along = {
    listenerId: string;
    hostId: string;
    trackId: string;
    syncedAt: Date;
    startedAt: Date;
};

const fake = vi.hoisted(() => ({
    links: [] as { id: string; userId: string }[],
    here: new Set<string>(),
    settings: new Map<string, Record<string, unknown>>(),
    along: [] as Along[],
    activity: [] as { userId: string; source: string; key: string; expiresAt: Date }[],
    playing: new Map<string, unknown>(),
    visible: new Map<string, { key: string; startedAt: string } | null>(),
    plays: [] as { token: string; uri: string; position: number }[],
    pauses: [] as string[],
    refuse: new Set<string>(),
    blip: new Set<string>(),
    refreshRefused: new Set<string>(),
    slow: 0,
    rateLimited: false,
    asked: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userConnection: {
            findMany: async () => fake.links,
            findFirst: async ({ where }: { where: { userId: string } }) =>
                fake.links.find((link) => link.userId === where.userId) ?? null
        },
        sessionState: {
            findMany: async () => [...fake.here].map((userId) => ({ userId }))
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
            upsert: async ({
                create
            }: {
                create: { userId: string; source: string; key: string; expiresAt: Date };
            }) => {
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
        },
        spotifyListenAlong: {
            findMany: async ({ where }: { where?: { hostId?: string } } = {}) =>
                fake.along
                    .filter((row) => !where?.hostId || row.hostId === where.hostId)
                    .map((row) => ({ ...row, listener: { isAdmin: false } })),
            findUnique: async ({ where }: { where: { listenerId: string } }) =>
                fake.along.find((row) => row.listenerId === where.listenerId) ?? null,
            upsert: async ({ create }: { create: Along }) => {
                fake.along = fake.along.filter((row) => row.listenerId !== create.listenerId);
                fake.along.push({ startedAt: new Date(), ...create });
            },
            update: async ({
                where,
                data
            }: {
                where: { listenerId: string };
                data: Partial<Along>;
            }) => {
                const row = fake.along.find((entry) => entry.listenerId === where.listenerId);
                if (row) Object.assign(row, data);
            },
            deleteMany: async ({ where }: { where: { listenerId: string } }) => {
                fake.along = fake.along.filter((row) => row.listenerId !== where.listenerId);
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@/lib/connections/store", () => ({
    readCredential: async (id: string) => ({ accessToken: `token-${id}` }),
    updateCredential: async () => undefined
}));
vi.mock("@/lib/connections/spotify", async (original) => {
    const real = await original<typeof import("@/lib/connections/spotify")>();
    return {
        ...real,
        getSpotifyOAuthClient: async () => ({ clientId: "c", clientSecret: "s" }),
        spotifyAccessToken: async (_client: unknown, credential: { accessToken: string }) => {
            if (fake.refreshRefused.has(credential.accessToken))
                throw new real.SpotifyUnauthorized();
            if (fake.blip.has(credential.accessToken)) throw new Error("Spotify timed out");
            return { accessToken: credential.accessToken, refreshed: null };
        },
        readSpotifyPlaying: async (token: string) => {
            fake.asked.push(token);
            if (fake.slow) await new Promise((resolve) => setTimeout(resolve, fake.slow));
            if (fake.rateLimited) throw new real.SpotifyRateLimited(20_000);
            return fake.playing.get(token) ?? null;
        },
        spotifyPlay: async (token: string, uri: string, position: number) => {
            if (fake.refuse.has(token))
                throw new real.SpotifyPlayerRefusal(
                    "premium",
                    "Listening along needs Spotify Premium."
                );
            fake.plays.push({ token, uri, position });
        },
        spotifyPause: async (token: string) => {
            fake.pauses.push(token);
        }
    };
});
vi.mock("@/lib/presence-service", () => ({
    presenceFor: async (_viewer: unknown, ids: string[]) =>
        new Map(
            ids.map((id) => {
                const seen = fake.visible.get(id);
                return [
                    id,
                    {
                        status: seen ? "online" : "offline",
                        note: "",
                        inCall: null,
                        activity: seen ? [{ source: "spotify", ...seen }] : []
                    }
                ];
            })
        )
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, _field: string, ids: string[]) =>
        new Set(ids.filter((id) => fake.visible.has(id)))
}));
vi.mock("@/lib/presence-activity/live", () => ({ announceActivity: async () => undefined }));

const poll = await import("@/lib/presence-activity/spotify-poll");
const along = await import("@/lib/presence-activity/listen-along");

function song(id: string, progressMs = 10_000, durationMs = 200_000) {
    return {
        id,
        uri: `spotify:track:${id}`,
        name: id,
        artists: "Ana",
        album: "Album",
        imageUrl: null,
        linkUrl: null,
        durationMs,
        progressMs
    };
}

const ANA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
    poll.resetSpotifySchedule();
    fake.links = [
        { id: "ana-link", userId: ANA },
        { id: "bob-link", userId: BOB }
    ];
    fake.here = new Set([ANA]);
    fake.settings.clear();
    fake.along = [];
    fake.activity = [];
    fake.playing.clear();
    fake.visible.clear();
    fake.plays = [];
    fake.pauses = [];
    fake.refuse.clear();
    fake.blip.clear();
    fake.refreshRefused.clear();
    fake.slow = 0;
    fake.rateLimited = false;
    fake.asked = [];
});

describe("when an account is asked about again", () => {
    it("is when its track ends, at most thirty seconds on, ten while hosting", () => {
        expect(poll.nextPlayingCheck(song("a", 0, 200_000), false)).toBe(30_000);
        expect(poll.nextPlayingCheck(song("a", 0, 200_000), true)).toBe(10_000);
        expect(poll.nextPlayingCheck(song("a", 190_000, 200_000), false)).toBe(11_500);
        expect(poll.nextPlayingCheck(song("a", 199_900, 200_000), false)).toBe(5_000);
    });

    it("backs off from a minute to five while nothing plays", () => {
        expect([1, 2, 3, 4, 9].map(poll.nextIdleCheck)).toEqual([
            60_000, 120_000, 240_000, 300_000, 300_000
        ]);
    });
});

describe("a pass", () => {
    it("asks only about somebody here with sharing on, and shows their song", async () => {
        fake.playing.set("token-ana-link", song("s1"));
        await poll.pollSpotify(1_000_000);
        expect(fake.asked).toEqual(["token-ana-link"]);
        expect(fake.activity).toEqual([
            expect.objectContaining({ userId: ANA, source: "spotify", key: "s1" })
        ]);
    });

    it("does not ask about somebody who switched Spotify off", async () => {
        fake.settings.set(ANA, {
            share: true,
            spotify: false,
            games: true,
            minecraft: true,
            hiddenGames: "[]",
            customGames: "[]",
            seenGames: "[]"
        });
        await poll.pollSpotify(1_000_000);
        expect(fake.asked).toEqual([]);
    });

    it("waits for the schedule, and takes the card down when they leave", async () => {
        fake.playing.set("token-ana-link", song("s1"));
        await poll.pollSpotify(1_000_000);
        await poll.pollSpotify(1_010_000);
        expect(fake.asked).toHaveLength(1);
        fake.here.clear();
        await poll.pollSpotify(1_040_000);
        expect(fake.activity).toEqual([]);
    });

    it("dates a song from when it was read, not from when the pass began", async () => {
        fake.here = new Set([ANA, BOB]);
        fake.playing.set("token-bob-link", song("s1", 10_000));
        fake.slow = 60;
        await poll.pollSpotify(1_000_000);
        const bob = fake.activity.find((row) => row.userId === BOB) as unknown as
            | { startedAt: Date }
            | undefined;
        expect(bob?.startedAt.getTime()).toBeGreaterThanOrEqual(1_000_000 - 10_000 + 100);
    });

    it("waits out a refresh that timed out rather than shelving the link", async () => {
        fake.blip.add("token-ana-link");
        await poll.pollSpotify(1_000_000);
        fake.blip.clear();
        await poll.pollSpotify(1_000_000 + 5 * 60_000);
        expect(fake.asked).toEqual(["token-ana-link"]);
    });

    it("ends following a host who unlinked Spotify", async () => {
        fake.links = [{ id: "bob-link", userId: BOB }];
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        await poll.pollSpotify(1_000_000);
        expect(fake.along).toEqual([]);
    });

    it("stops everything on a 429 until Spotify's own wait is over", async () => {
        fake.here = new Set([ANA, BOB]);
        fake.rateLimited = true;
        await poll.pollSpotify(1_000_000);
        expect(fake.asked).toHaveLength(1);
        expect((await poll.pollSpotify(1_010_000)).skipped).toMatch(/fewer requests/);
        fake.rateLimited = false;
        await poll.pollSpotify(1_021_000);
        expect(fake.asked).toHaveLength(3);
    });
});

describe("listening along", () => {
    const listener = { id: BOB, isAdmin: false };

    it("starts where the host is, through the presence rule", async () => {
        fake.visible.set(ANA, { key: "s1", startedAt: new Date(1_000_000 - 42_000).toISOString() });
        await along.startListenAlong(listener, ANA, 1_000_000);
        expect(fake.plays).toEqual([
            { token: "token-bob-link", uri: "spotify:track:s1", position: 42_000 }
        ]);
        expect(await along.listenAlongOf(BOB)).toBe(ANA);
    });

    it("refuses a card the listener may not see exactly like an empty one", async () => {
        await expect(along.startListenAlong(listener, ANA)).rejects.toThrow(
            /not playing anything you can see/
        );
        await expect(along.startListenAlong(listener, BOB)).rejects.toThrow(/your own/);
    });

    it("says to link Spotify, and says Premium, where those are what is missing", async () => {
        fake.visible.set(ANA, { key: "s1", startedAt: new Date().toISOString() });
        fake.links = [{ id: "ana-link", userId: ANA }];
        await expect(along.startListenAlong(listener, ANA)).rejects.toMatchObject({ kind: "link" });
        fake.links.push({ id: "bob-link", userId: BOB });
        fake.refuse.add("token-bob-link");
        await expect(along.startListenAlong(listener, ANA)).rejects.toThrow(/Premium/);
        expect(fake.along).toEqual([]);
    });

    it("puts the host's next song on the listener, and pauses them with the host", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        fake.visible.set(ANA, { key: "s2", startedAt: new Date().toISOString() });
        await along.followHost(ANA, song("s2", 1_500), true, 100_000);
        expect(fake.plays).toEqual([
            { token: "token-bob-link", uri: "spotify:track:s2", position: 1_500 }
        ]);
        expect(fake.along[0]?.trackId).toBe("s2");

        await along.followHost(ANA, null, true, 110_000);
        expect(fake.pauses).toEqual(["token-bob-link"]);
        expect(fake.along[0]?.trackId).toBe("");
    });

    it("ends with a paused host who is no longer visible, or paused too long", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        await along.followHost(ANA, null, true, 100_000);
        expect(fake.along).toEqual([]);
        expect(fake.pauses).toEqual([]);

        fake.visible.set(ANA, { key: "s1", startedAt: new Date().toISOString() });
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "",
                syncedAt: new Date(100_000),
                startedAt: new Date(0)
            }
        ];
        await along.followHost(ANA, null, true, 100_000 + 14 * 60_000);
        expect(fake.along).toHaveLength(1);
        await along.followHost(ANA, null, true, 100_000 + 15 * 60_000);
        expect(fake.along).toEqual([]);
    });

    it("keeps following through a blip, and ends when Spotify refuses the listener", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        fake.visible.set(ANA, { key: "s2", startedAt: new Date().toISOString() });
        fake.blip.add("token-bob-link");
        await along.followHost(ANA, song("s2"), true, 100_000);
        expect(fake.along).toHaveLength(1);
        fake.blip.clear();
        fake.refreshRefused.add("token-bob-link");
        await along.followHost(ANA, song("s2"), true, 110_000);
        expect(fake.along).toEqual([]);
    });

    it("leaves a listener already on the right song alone", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        fake.visible.set(ANA, { key: "s1", startedAt: new Date().toISOString() });
        await along.followHost(ANA, song("s1"), false, 100_000);
        expect(fake.plays).toEqual([]);
    });

    it("ends when the host is no longer somebody the listener may see listening", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        await along.followHost(ANA, song("s2"), true, 100_000);
        expect(fake.along).toEqual([]);
        expect(fake.plays).toEqual([]);
    });

    it("ends only after the listener is seen on something else twice, apart", async () => {
        fake.along = [
            {
                listenerId: BOB,
                hostId: ANA,
                trackId: "s1",
                syncedAt: new Date(0),
                startedAt: new Date(0)
            }
        ];
        await along.noticeListener(BOB, song("other"), 100_000);
        expect(fake.along).toHaveLength(1);
        await along.noticeListener(BOB, song("s1"), 110_000);
        await along.noticeListener(BOB, song("other"), 130_000);
        expect(fake.along).toHaveLength(1);
        await along.noticeListener(BOB, song("other"), 151_000);
        expect(fake.along).toEqual([]);
    });
});
