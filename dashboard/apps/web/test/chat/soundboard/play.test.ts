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
    orgRole: string | null;
    allowed: boolean;
    reachable: boolean;
}

let state: State;
let sent: { meetingId: string; payload: unknown; topic: string }[] = [];
let denialWrites: unknown[] = [];
let counted = 0;

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
        orgRole: "sales",
        allowed: true,
        reachable: true
    };
    sent = [];
    denialWrites = [];
    counted = 0;
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
    }
}));

vi.mock("@/lib/chat/access", async (importActual) => {
    const actual = await importActual<typeof import("@/lib/chat/access")>();
    return {
        ...actual,
        spaceAccess: async (_actor: unknown, spaceId: string) => state.access[spaceId] ?? null,
        reachableSpaceIds: async () => new Set(Object.keys(state.access)),
        requireSpace: async (_actor: unknown, spaceId: string, minimum = "member") => {
            const role = state.access[spaceId] ?? null;
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
            findUnique: async () => (state.orgRole ? { role: state.orgRole } : null)
        },
        chatSpace: { findUnique: async () => ({ ownerId: OWNER }) },
        chatSpaceSound: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                if (where.id === SOUND)
                    return { id: SOUND, spaceId: SPACE, name: "Drum", emoji: "", volume: 0.4 };
                if (where.id === FOREIGN_SOUND)
                    return { id: FOREIGN_SOUND, spaceId: OTHER_SPACE, name: "Far", emoji: "", volume: 1 };
                return null;
            }
        }
    }
}));

const { playSound, setSoundDenial } = await import("@/lib/chat/soundboard-service");
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
});
