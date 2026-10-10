/**
 * Playing a sound, on the server.
 *
 * A press is only a request. Every fact is read again - the seat, the space's
 * and the conversation's switches, the denials, the person's own microphone,
 * the sound and the cooldown - and a refusal sends nothing to the room. What
 * the room receives is built from the database row, never from the request.
 *
 * The call server, the rate limiter and the database are stand-ins here; no
 * real call is exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "0193b0f0-0000-7000-8000-0000000000aa";
const OTHER_SPACE = "0193b0f0-0000-7000-8000-0000000000ab";
const ORG = "0193b0f0-0000-7000-8000-0000000000ac";
const MEETING = "0193b0f0-0000-7000-8000-0000000000e1";
const SEAT = "0193b0f0-0000-7000-8000-0000000000f1";
const ADA = "0193b0f0-0000-7000-8000-0000000000a1";
const OWNER = "0193b0f0-0000-7000-8000-0000000000a9";
const BEN = "0193b0f0-0000-7000-8000-0000000000b2";
const PUBLIC_CHANNEL = "0193b0f0-0000-7000-8000-0000000000d1";
const PRIVATE_CHANNEL = "0193b0f0-0000-7000-8000-0000000000d2";
const SOUND = "0193b0f0-0000-7000-8000-0000000000c1";
const FOREIGN_SOUND = "0193b0f0-0000-7000-8000-0000000000c2";

interface State {
    participant: {
        userId: string | null;
        admission: string;
        muted: boolean;
        deafened: boolean;
        serverMuted: boolean;
        serverDeafened: boolean;
        meeting: {
            endedAt: Date | null;
            channel: {
                soundboard: boolean;
                space: {
                    id: string;
                    orgId: string | null;
                    soundboard: boolean;
                    soundboardExternal: boolean;
                } | null;
            } | null;
        };
    } | null;
    denials: { kind: string; subject: string }[];
    access: Record<string, "owner" | "admin" | "member" | null>;
    /** Somebody else's standing in SPACE, by account. */
    people: Record<string, "admin" | "member">;
    /** Somebody else's standing in SPACE handed to them through a grant. */
    granted: Record<string, "admin" | "member">;
    orgRole: string | null;
    /** Somebody else's role in ORG, by account. */
    heldRoles: Record<string, string>;
    channels: { id: string; private: boolean; members: string[] }[];
    allowed: boolean;
    reachable: boolean;
}

let state: State;
let sent: { meetingId: string; payload: unknown; topic: string }[] = [];
let denialWrites: unknown[] = [];
let counted = 0;
let standingBatches = 0;
let refunded = 0;
let channelWrites: unknown[] = [];

function reset(): void {
    state = {
        participant: {
            userId: ADA,
            admission: "admitted",
            muted: false,
            deafened: false,
            serverMuted: false,
            serverDeafened: false,
            meeting: {
                endedAt: null,
                channel: {
                    soundboard: true,
                    space: { id: SPACE, orgId: ORG, soundboard: true, soundboardExternal: true }
                }
            }
        },
        denials: [],
        access: { [SPACE]: "member", [OTHER_SPACE]: "member" },
        people: { [BEN]: "member" },
        granted: {},
        orgRole: "sales",
        heldRoles: {},
        channels: [
            { id: PUBLIC_CHANNEL, private: false, members: [] },
            { id: PRIVATE_CHANNEL, private: true, members: [] }
        ],
        allowed: true,
        reachable: true
    };
    sent = [];
    denialWrites = [];
    counted = 0;
    standingBatches = 0;
    refunded = 0;
    channelWrites = [];
}

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_DB_PROVIDER: "postgresql", POLARIS_AUTH_SECRET: "test-secret-not-real" })
}));

vi.mock("@/lib/chat/call-server", () => ({
    sendToRoom: async (meetingId: string, payload: unknown, topic: string) => {
        if (!state.reachable) return false;
        sent.push({ meetingId, payload, topic });
        return true;
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => {
        counted += 1;
        return state.allowed ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: 2_100 };
    },
    resetRateLimit: async () => {
        refunded += 1;
    }
}));

vi.mock("@/lib/access/grants", () => ({ grantedSubjects: async () => new Map() }));

/** One person's standing, as the real rule would read it from the state. */
function standingOf(userId: string, spaceId: string): "owner" | "admin" | "member" | null {
    if (userId === OWNER) return "owner";
    if (userId !== ADA) {
        if (spaceId !== SPACE) return null;
        return state.people[userId] ?? state.granted[userId] ?? null;
    }
    return state.access[spaceId] ?? null;
}

vi.mock("@/lib/chat/access", async (importActual) => {
    const actual = await importActual<typeof import("@/lib/chat/access")>();
    return {
        ...actual,
        spaceAccess: async (actor: { id: string }, spaceId: string) => standingOf(actor.id, spaceId),
        spaceStandings: async (spaceId: string, userIds: readonly string[]) => {
            standingBatches += 1;
            return new Map(userIds.map((id) => [id, standingOf(id, spaceId)]));
        },
        spaceAdminIds: async (spaceId: string) =>
            [ADA, ...Object.keys(state.people), ...Object.keys(state.granted)].filter(
                (id) => standingOf(id, spaceId) === "admin"
            ),
        channelAccess: async (actor: { id: string }, channelId: string) => {
            const channel = state.channels.find((one) => one.id === channelId);
            if (!channel || (channel.private && !channel.members.includes(actor.id))) return null;
            return { channelId, spaceId: SPACE };
        },
        reachableSpaceIds: async () => new Set(Object.keys(state.access)),
        requireSpace: async (actor: { id: string }, spaceId: string, minimum = "member") => {
            const role = actor.id === OWNER ? "owner" : (state.access[spaceId] ?? null);
            if (!role) throw new actual.ChatAccessError({ key: "errors.notInSpace" });
            if (minimum === "admin" && role === "member") {
                throw new actual.ChatAccessError({ key: "errors.spaceAdminOnly" });
            }
            return role;
        }
    };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: { findFirst: async () => state.participant },
        chatSoundboardDenial: {
            findMany: async () => state.denials,
            upsert: async (args: unknown) => {
                denialWrites.push(args);
                return {};
            },
            deleteMany: async (args: unknown) => {
                denialWrites.push(args);
                return { count: 1 };
            }
        },
        organization: { findUnique: async () => ({ ownerId: OWNER }) },
        organizationMember: {
            findUnique: async () => (state.orgRole ? { role: state.orgRole } : null),
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in.flatMap((userId) => {
                    const role = userId === ADA ? state.orgRole : state.heldRoles[userId];
                    return role ? [{ userId, role }] : [];
                })
        },
        chatSpace: {
            findUnique: async () => ({
                id: SPACE,
                name: "Space",
                orgId: ORG,
                ownerId: OWNER,
                soundboard: true,
                soundboardExternal: true
            })
        },
        chatSpaceMember: {
            findMany: async ({ where }: { where: { role?: string } }) =>
                Object.entries(state.people)
                    .filter(([, role]) => !where.role || role === where.role)
                    .map(([userId, role]) => ({ userId, role }))
        },
        chatChannel: {
            findMany: async ({ where }: { where: { OR: unknown[] } }) => {
                expect(where.OR).toContainEqual({ private: false });
                expect(where.OR).toContainEqual({ members: { some: { userId: ADA } } });
                return state.channels
                    .filter((one) => !one.private || one.members.includes(ADA))
                    .map((one) => ({ id: one.id, name: one.id, kind: "text", soundboard: true }));
            },
            update: async (args: unknown) => {
                channelWrites.push(args);
                return {};
            }
        },
        orgRole: { findMany: async () => [] },
        user: { findMany: async () => [] },
        chatSpaceSound: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                if (where.id === SOUND)
                    return { id: SOUND, spaceId: SPACE, name: "Drum", emoji: "", volume: 0.4 };
                if (where.id === FOREIGN_SOUND)
                    return { id: FOREIGN_SOUND, spaceId: OTHER_SPACE, name: "Far", emoji: "", volume: 1 };
                return null;
            },
            findMany: async () => []
        }
    }
}));

const { playSound, setSoundDenial, setChannelSoundboard, spaceSoundboard } = await import(
    "@/lib/chat/soundboard-service"
);
const { ChatAccessError } = await import("@/lib/chat/access");

const seat = { meetingId: MEETING, participantId: SEAT, admission: "admitted" } as never;

/** The catalog key a refusal names, or null when the play went through. */
async function refusalOf(ref: string): Promise<string | null> {
    try {
        await playSound(seat, ref);
        return null;
    } catch (caught) {
        if (caught instanceof ChatAccessError) return caught.text.key;
        throw caught;
    }
}

beforeEach(reset);

describe("a play that is allowed", () => {
    it("reaches the room from the server, built from the row rather than the request", async () => {
        expect(await refusalOf(SOUND)).toBeNull();
        expect(sent).toHaveLength(1);
        const [message] = sent;
        expect(message!.meetingId).toBe(MEETING);
        expect(message!.topic).toBe("polaris.soundboard");
        expect(message!.payload).toMatchObject({
            kind: "sound",
            sound: SOUND,
            name: "Drum",
            volume: 0.4,
            from: SEAT,
            userId: ADA
        });
        expect((message!.payload as { url: string }).url).toMatch(
            new RegExp(`^/api/chat/sounds/${SOUND}\\?m=${MEETING}&t=`)
        );
    });

    it("of a default carries no clip address, which every browser makes itself", async () => {
        expect(await refusalOf("default:applause")).toBeNull();
        expect(sent[0]!.payload).not.toHaveProperty("url");
    });
});

describe("a play that is refused sends nothing", () => {
    it.each([
        [
            "the space turned it off",
            () => {
                state.participant!.meeting.channel!.space!.soundboard = false;
            },
            "errors.soundboardSpaceOff"
        ],
        [
            "the conversation turned it off",
            () => {
                state.participant!.meeting.channel!.soundboard = false;
            },
            "errors.soundboardChannelOff"
        ],
        [
            "the person is denied",
            () => {
                state.denials = [{ kind: "user", subject: ADA }];
            },
            "errors.soundboardDenied"
        ],
        [
            "the space's member role is denied",
            () => {
                state.denials = [{ kind: "role", subject: "member" }];
            },
            "errors.soundboardDenied"
        ],
        [
            "their organization role is denied",
            () => {
                state.denials = [{ kind: "role", subject: "org:sales" }];
            },
            "errors.soundboardDenied"
        ],
        [
            "a moderator muted them",
            () => {
                state.participant!.serverMuted = true;
            },
            "errors.soundboardModerated"
        ],
        [
            "their own microphone is off",
            () => {
                state.participant!.muted = true;
            },
            "errors.soundboardMuted"
        ],
        [
            "they are a guest",
            () => {
                state.participant!.userId = null;
            },
            "errors.soundboardGuest"
        ],
        [
            "the call is a meeting of its own",
            () => {
                state.participant!.meeting.channel = null;
            },
            "errors.soundboardStandalone"
        ],
        [
            "they left the call",
            () => {
                state.participant = null;
            },
            "errors.notInCall"
        ],
        [
            "the call ended",
            () => {
                state.participant!.meeting.endedAt = new Date();
            },
            "errors.notInCall"
        ],
        [
            "they are still in the lobby",
            () => {
                state.participant!.admission = "waiting";
            },
            "errors.notInCall"
        ],
        [
            "they played one a moment ago",
            () => {
                state.allowed = false;
            },
            "errors.soundboardCooldown"
        ],
        [
            "the call server did not answer",
            () => {
                state.reachable = false;
            },
            "errors.soundboardUnreachable"
        ]
    ])("when %s", async (_why, arrange, key) => {
        arrange();
        expect(await refusalOf(SOUND)).toBe(key);
        expect(sent).toHaveLength(0);
    });

    it("for the owner, no denial applies", async () => {
        state.access[SPACE] = "owner";
        state.denials = [{ kind: "role", subject: "member" }];
        expect(await refusalOf(SOUND)).toBeNull();
    });

    it("for a sound that does not exist, or a reference typed by hand", async () => {
        expect(await refusalOf("0193b0f0-0000-7000-8000-0000000000ff")).toBe("errors.soundGone");
        expect(await refusalOf("default:nope")).toBe("errors.soundGone");
        expect(sent).toHaveLength(0);
    });

    it("for a sound of a space the player does not reach, answered as if it did not exist", async () => {
        state.access[OTHER_SPACE] = null;
        expect(await refusalOf(FOREIGN_SOUND)).toBe("errors.soundGone");
    });

    it("for another space's sound when this space keeps to its own", async () => {
        state.participant!.meeting.channel!.space!.soundboardExternal = false;
        expect(await refusalOf(FOREIGN_SOUND)).toBe("errors.soundboardExternal");
        expect(await refusalOf(SOUND)).toBeNull();
    });

    it("but a refusal costs nobody their cooldown: it is counted only once allowed", async () => {
        state.participant!.muted = true;
        await refusalOf(SOUND);
        expect(counted).toBe(0);
    });

    it("and a call server that did not answer gives the cooldown back", async () => {
        state.reachable = false;
        expect(await refusalOf(SOUND)).toBe("errors.soundboardUnreachable");
        expect(refunded).toBe(1);
    });
});

describe("a play of the call's own space's sound", () => {
    it("goes through for somebody brought into the call without reaching the space", async () => {
        state.access[SPACE] = null;
        expect(await refusalOf(SOUND)).toBeNull();
        expect(sent).toHaveLength(1);
    });
});

describe("denying the soundboard", () => {
    it("is refused to somebody who does not run the space", async () => {
        await expect(
            setSoundDenial({ id: ADA }, {
                spaceId: SPACE,
                denial: { kind: "role", subject: "member" },
                denied: true
            })
        ).rejects.toMatchObject({ text: { key: "errors.spaceAdminOnly" } });
        expect(denialWrites).toHaveLength(0);
    });

    it("is refused for the owner, on whom it would do nothing", async () => {
        state.access[SPACE] = "admin";
        await expect(
            setSoundDenial({ id: ADA }, {
                spaceId: SPACE,
                denial: { kind: "user", subject: OWNER },
                denied: true
            })
        ).rejects.toMatchObject({ text: { key: "errors.soundboardOwner" } });
        expect(denialWrites).toHaveLength(0);
    });

    it("is written for an administrator, and lifted the same way", async () => {
        state.access[SPACE] = "admin";
        const denial = { kind: "user" as const, subject: "0193b0f0-0000-7000-8000-0000000000b2" };
        await setSoundDenial({ id: ADA }, { spaceId: SPACE, denial, denied: true });
        await setSoundDenial({ id: ADA }, { spaceId: SPACE, denial, denied: false });
        expect(denialWrites).toHaveLength(2);
    });

    it.each([
        ["themselves", { kind: "user" as const, subject: ADA }],
        ["the administrators' role", { kind: "role" as const, subject: "admin" }],
        ["an organization role they hold", { kind: "role" as const, subject: "org:sales" }],
        ["another administrator", { kind: "user" as const, subject: BEN }]
    ])("is the owner's alone when an administrator would change it for %s", async (_who, denial) => {
        state.access[SPACE] = "admin";
        state.people[BEN] = "admin";
        for (const denied of [true, false]) {
            await expect(
                setSoundDenial({ id: ADA }, { spaceId: SPACE, denial, denied })
            ).rejects.toMatchObject({ text: { key: "errors.soundboardDenialOwnerOnly" } });
        }
        expect(denialWrites).toHaveLength(0);
    });

    it("lets an administrator deny every member, which leaves the administrators", async () => {
        state.access[SPACE] = "admin";
        await setSoundDenial({ id: ADA }, {
            spaceId: SPACE,
            denial: { kind: "role", subject: "member" },
            denied: true
        });
        await setSoundDenial({ id: ADA }, {
            spaceId: SPACE,
            denial: { kind: "user", subject: BEN },
            denied: true
        });
        expect(denialWrites).toHaveLength(2);
    });

    it("leaves an organization role another administrator holds to the owner", async () => {
        state.access[SPACE] = "admin";
        state.people[BEN] = "admin";
        state.heldRoles[BEN] = "support";
        const denial = { kind: "role" as const, subject: "org:support" };
        for (const denied of [true, false]) {
            await expect(
                setSoundDenial({ id: ADA }, { spaceId: SPACE, denial, denied })
            ).rejects.toMatchObject({ text: { key: "errors.soundboardDenialOwnerOnly" } });
        }
        await setSoundDenial({ id: OWNER }, { spaceId: SPACE, denial, denied: true });
        expect(denialWrites).toHaveLength(1);
    });

    it("lets an administrator deny an organization role no administrator holds", async () => {
        state.access[SPACE] = "admin";
        state.people[BEN] = "admin";
        state.heldRoles[BEN] = "support";
        await setSoundDenial({ id: ADA }, {
            spaceId: SPACE,
            denial: { kind: "role", subject: "org:design" },
            denied: true
        });
        expect(denialWrites).toHaveLength(1);
    });

    it("counts an administrator by grant when the role they hold is denied", async () => {
        state.access[SPACE] = "admin";
        state.people = {};
        state.granted[BEN] = "admin";
        state.heldRoles[BEN] = "support";
        await expect(
            setSoundDenial({ id: ADA }, {
                spaceId: SPACE,
                denial: { kind: "role", subject: "org:support" },
                denied: true
            })
        ).rejects.toMatchObject({ text: { key: "errors.soundboardDenialOwnerOnly" } });
    });

    it("lets the owner change any of them", async () => {
        state.people[BEN] = "admin";
        await setSoundDenial({ id: OWNER }, {
            spaceId: SPACE,
            denial: { kind: "user", subject: BEN },
            denied: true
        });
        await setSoundDenial({ id: OWNER }, {
            spaceId: SPACE,
            denial: { kind: "role", subject: "admin" },
            denied: false
        });
        expect(denialWrites).toHaveLength(2);
    });
});

describe("the settings page", () => {
    it("lists a private conversation only to whoever is in it", async () => {
        state.access[SPACE] = "admin";
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect(board.channels.map((one) => one.id)).toEqual([PUBLIC_CHANNEL]);
    });

    it("offers an administrator only the roles that do not reach them, and marks the denials they cannot lift", async () => {
        state.access[SPACE] = "admin";
        state.denials = [
            { kind: "user", subject: ADA },
            { kind: "role", subject: "org:other" }
        ];
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect(board.owner).toBe(false);
        expect(board.roles.map((role) => role.subject)).toEqual(["member"]);
        expect(board.denials.map((one) => one.mayChange)).toEqual([false, true]);
    });

    it("reads a denied person's standing as the server does, grants included", async () => {
        state.access[SPACE] = "admin";
        state.people = {};
        state.granted[BEN] = "admin";
        state.denials = [{ kind: "user", subject: BEN }];
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect(board.denials.map((one) => one.mayChange)).toEqual([false]);
        await expect(
            setSoundDenial({ id: ADA }, { spaceId: SPACE, denial: { kind: "user", subject: BEN }, denied: false })
        ).rejects.toMatchObject({ text: { key: "errors.soundboardDenialOwnerOnly" } });
    });

    it("keeps the reader, the owner and the administrators out of an administrator's picker", async () => {
        state.access[SPACE] = "admin";
        state.people = { [BEN]: "admin" };
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect([...board.ownerOnlyPeople].sort()).toEqual([ADA, OWNER, BEN].sort());
    });

    it("keeps an administrator by grant out of the picker too", async () => {
        state.access[SPACE] = "admin";
        state.people = {};
        state.granted[BEN] = "admin";
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect([...board.ownerOnlyPeople].sort()).toEqual([ADA, OWNER, BEN].sort());
    });

    it("leaves an organization role another administrator holds to the owner", async () => {
        state.access[SPACE] = "admin";
        state.orgRole = null;
        state.people = { [BEN]: "admin" };
        state.heldRoles[BEN] = "support";
        state.denials = [{ kind: "role", subject: "org:support" }];
        const board = await spaceSoundboard({ id: ADA }, SPACE);
        expect(board.denials.map((one) => one.mayChange)).toEqual([false]);
    });

    it("reads every denied person's standing in one batch", async () => {
        state.access[SPACE] = "admin";
        state.denials = Array.from({ length: 40 }, (_, index) => ({
            kind: "user",
            subject: `0193b0f0-0000-7000-8000-${String(index).padStart(12, "0")}`
        }));
        await spaceSoundboard({ id: ADA }, SPACE);
        expect(standingBatches).toBe(1);
    });

    it("refuses the switch of a private conversation the administrator is not in", async () => {
        state.access[SPACE] = "admin";
        await expect(
            setChannelSoundboard({ id: ADA }, { channelId: PRIVATE_CHANNEL, enabled: false })
        ).rejects.toMatchObject({ text: { key: "errors.notInSpace" } });
        await setChannelSoundboard({ id: ADA }, { channelId: PUBLIC_CHANNEL, enabled: false });
        expect(channelWrites).toHaveLength(1);
    });
});
