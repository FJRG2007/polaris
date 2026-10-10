/**
 * The soundboard: a space's own sounds, who may play them, and playing one.
 *
 * The rules themselves are in `soundboard.ts`, pure; this is where they are fed
 * the facts and enforced. Three things a client could otherwise get wrong are
 * decided only here:
 *
 * - **Whether a play happens.** The seat, the call, its conversation, the
 *   space, the space's and the conversation's switches, the denials, the
 *   person's own microphone and headphones, the sound and the cooldown are all
 *   read again on every press. A screen that hid the button decided nothing.
 * - **What everybody hears.** The play is sent to the room by the call server
 *   itself (`sendToRoom`), named and sized from the database row, so a browser
 *   cannot put a sound into a call by publishing one of its own - a browser in
 *   the room only believes a play that arrived with no participant attached.
 * - **Who can fetch the clip.** Whoever reaches the sound's space, and
 *   whoever holds a seat in a call it was played in, with the pass the play
 *   carried (`soundboard-ticket`).
 *
 * Who manages a space's sounds is whoever runs the space - its owner and its
 * administrators - the same people who manage its emoji: Discord's "Create
 * Expressions" and "Manage Expressions" on the role model this space has.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { sendToRoom } from "./call-server";
import type { MeetingSeat } from "./meetings";
import { soundUrl } from "./soundboard-ticket";
import { prisma, type Prisma } from "@polaris/db";
import { grantedSubjects } from "@/lib/access/grants";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { readWav, type SoundFileProblem } from "./sound-file";
import {
    ChatRuleError,
    channelAccess,
    reachableSpaceIds,
    requireSpace,
    spaceAccess,
    type ChatActor,
    type ChatErrorText,
    type ChatSpaceAccess
} from "./access";
import * as rules from "./soundboard";

/** One sound, as the screens draw it. */
export interface SoundView {
    readonly id: string;
    readonly spaceId: string;
    readonly name: string;
    readonly emoji: string;
    readonly volume: number;
    readonly durationMs: number;
    readonly uploaderName: string | null;
    readonly createdAt: string;
}

const VIEW_SELECT = {
    id: true,
    spaceId: true,
    name: true,
    emoji: true,
    volume: true,
    durationMs: true,
    createdAt: true,
    uploader: { select: { name: true } }
} satisfies Prisma.ChatSpaceSoundSelect;

type ViewRow = Prisma.ChatSpaceSoundGetPayload<{ select: typeof VIEW_SELECT }>;

function view(row: ViewRow): SoundView {
    return {
        id: row.id,
        spaceId: row.spaceId,
        name: row.name,
        emoji: row.emoji,
        volume: row.volume,
        durationMs: row.durationMs,
        uploaderName: row.uploader?.name ?? null,
        createdAt: row.createdAt.toISOString()
    };
}

const FILE_REFUSAL: Record<SoundFileProblem, ChatErrorText> = {
    empty: { key: "errors.soundFileEmpty" },
    size: { key: "errors.soundFileSize" },
    type: { key: "errors.soundFileType" },
    length: { key: "errors.soundFileLength" }
};

/** What each refusal is said as, to the person who pressed the button. */
export const REFUSAL_TEXT: Record<rules.SoundboardRefusal, ChatErrorText> = {
    guest: { key: "errors.soundboardGuest" },
    standalone: { key: "errors.soundboardStandalone" },
    spaceOff: { key: "errors.soundboardSpaceOff" },
    channelOff: { key: "errors.soundboardChannelOff" },
    denied: { key: "errors.soundboardDenied" },
    moderated: { key: "errors.soundboardModerated" },
    deafened: { key: "errors.soundboardDeafened" },
    muted: { key: "errors.soundboardMuted" }
};

// ---------------------------------------------------------------------------
// Who somebody is, as a denial can name them
// ---------------------------------------------------------------------------

/** The denials a space keeps. A space has a handful; the bound is only so a
 *  hand-edited table cannot make this an unbounded read. */
async function denialsOf(spaceId: string): Promise<rules.SoundDenial[]> {
    const rows = await prisma.chatSoundboardDenial.findMany({
        where: { spaceId },
        select: { kind: true, subject: true },
        take: 1_000
    });
    return rows.flatMap((row) =>
        row.kind === "user" || row.kind === "role" ? [row as rules.SoundDenial] : []
    );
}

/** Their role in the organization that owns a space: `owner` for whoever owns
 *  the organization, their roster role otherwise, null when they are not on
 *  it. */
async function orgRoleOf(orgId: string | null, userId: string): Promise<string | null> {
    if (!orgId) return null;
    const [org, member] = await Promise.all([
        prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }),
        prisma.organizationMember.findUnique({
            where: { orgId_userId: { orgId, userId } },
            select: { role: true }
        })
    ]);
    if (org?.ownerId === userId) return "owner";
    return member?.role ?? null;
}

/** Whether a denial names this person in this space. */
async function deniedIn(
    space: { readonly id: string; readonly orgId: string | null },
    userId: string,
    access: ChatSpaceAccess | null
): Promise<boolean> {
    const denials = await denialsOf(space.id);
    if (denials.length === 0) return false;
    return rules.soundboardDenied(denials, {
        userId,
        // Somebody in a call in a space they do not otherwise reach - brought
        // into a private channel's call - holds the space's lowest role.
        spaceRole: access ?? "member",
        orgRole: await orgRoleOf(space.orgId, userId)
    });
}

/** The standing each of these people has in the space as its owner or on its
 *  member list. */
async function spaceRolesOf(
    spaceId: string,
    userIds: readonly string[]
): Promise<Map<string, rules.SpaceRole | "owner">> {
    const standings = new Map<string, rules.SpaceRole | "owner">();
    if (userIds.length === 0) return standings;
    const [space, members] = await Promise.all([
        prisma.chatSpace.findUnique({ where: { id: spaceId }, select: { ownerId: true } }),
        prisma.chatSpaceMember.findMany({
            where: { spaceId, userId: { in: [...userIds] } },
            select: { userId: true, role: true }
        })
    ]);
    for (const member of members) standings.set(member.userId, member.role === "admin" ? "admin" : "member");
    if (space?.ownerId && userIds.includes(space.ownerId)) standings.set(space.ownerId, "owner");
    return standings;
}

// ---------------------------------------------------------------------------
// One seat in one call
// ---------------------------------------------------------------------------

/** Everything about a seat the soundboard needs, read in one query. */
async function seatFacts(seat: MeetingSeat): Promise<{
    readonly facts: rules.SoundboardFacts;
    readonly userId: string | null;
    readonly spaceId: string | null;
}> {
    const row = await prisma.meetingParticipant.findFirst({
        where: { id: seat.participantId, meetingId: seat.meetingId, leftAt: null },
        select: {
            userId: true,
            admission: true,
            muted: true,
            deafened: true,
            serverMuted: true,
            serverDeafened: true,
            meeting: {
                select: {
                    endedAt: true,
                    channel: {
                        select: {
                            soundboard: true,
                            space: {
                                select: {
                                    id: true,
                                    orgId: true,
                                    soundboard: true,
                                    soundboardExternal: true
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    if (!row || row.admission !== "admitted" || row.meeting.endedAt) {
        throw new ChatRuleError({ key: "errors.notInCall" });
    }
    const channel = row.meeting.channel;
    const space = channel?.space ?? null;
    const userId = row.userId;
    const denied =
        space && userId
            ? await deniedIn(space, userId, await spaceAccess({ id: userId }, space.id))
            : false;
    return {
        userId,
        spaceId: space?.id ?? null,
        facts: {
            guest: !userId,
            standalone: !channel,
            space: space ? { enabled: space.soundboard, external: space.soundboardExternal } : null,
            channelEnabled: space ? (channel?.soundboard ?? true) : true,
            denied,
            muted: row.muted,
            deafened: row.deafened,
            serverMuted: row.serverMuted,
            serverDeafened: row.serverDeafened
        }
    };
}

/** One space's sounds, as the picker groups them. */
export interface SoundGroup {
    readonly spaceId: string;
    readonly spaceName: string;
    /** The call's own space, drawn first. */
    readonly here: boolean;
    readonly sounds: readonly SoundView[];
}

/** What the picker in a call is drawn from. */
export interface CallSoundboard {
    /** Why this seat cannot play anything, or null. Drawn on the button and
     *  over the picker, from the same answer a play would get. */
    readonly refusal: rules.SoundboardRefusal | null;
    /** Whether sounds from another space may be played here. */
    readonly external: boolean;
    readonly groups: readonly SoundGroup[];
    /** The sounds this account starred, by reference. */
    readonly favorites: readonly string[];
    /** Where the call's space keeps its sounds, for whoever runs it. */
    readonly manageSpaceId: string | null;
    readonly cooldownMs: number;
}

/**
 * Most sounds the picker lists from other spaces. Forty-eight is one full
 * space; ten of them is more than anybody scrolls through in a call.
 */
const ELSEWHERE_LIMIT = rules.SOUNDBOARD_SLOTS * 10;

export async function callSoundboard(seat: MeetingSeat): Promise<CallSoundboard> {
    const { facts, userId, spaceId } = await seatFacts(seat);
    const refusal = rules.soundboardRefusal(facts);
    const external = facts.space ? facts.space.external : true;
    if (!userId) {
        return {
            refusal,
            external,
            groups: [],
            favorites: [],
            manageSpaceId: null,
            cooldownMs: rules.SOUND_COOLDOWN_MS
        };
    }
    const actor = { id: userId };
    const reachable = await reachableSpaceIds(actor);
    if (spaceId) reachable.delete(spaceId);
    const [here, elsewhere, favorites, access] = await Promise.all([
        spaceId
            ? prisma.chatSpaceSound.findMany({
                  where: { spaceId },
                  orderBy: { createdAt: "asc" },
                  take: rules.SOUNDBOARD_SLOTS * 2,
                  select: { ...VIEW_SELECT, space: { select: { name: true } } }
              })
            : Promise.resolve([]),
        external && reachable.size > 0
            ? prisma.chatSpaceSound.findMany({
                  where: { spaceId: { in: [...reachable] } },
                  orderBy: [{ spaceId: "asc" }, { createdAt: "asc" }],
                  take: ELSEWHERE_LIMIT,
                  select: { ...VIEW_SELECT, space: { select: { name: true } } }
              })
            : Promise.resolve([]),
        prisma.chatSoundFavorite.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            take: 200,
            select: { sound: true }
        }),
        spaceId ? spaceAccess(actor, spaceId) : Promise.resolve(null)
    ]);

    const groups = new Map<string, { spaceName: string; here: boolean; sounds: SoundView[] }>();
    for (const row of [...here, ...elsewhere]) {
        const group = groups.get(row.spaceId) ?? {
            spaceName: row.space.name,
            here: row.spaceId === spaceId,
            sounds: []
        };
        group.sounds.push(view(row));
        groups.set(row.spaceId, group);
    }
    return {
        refusal,
        external,
        groups: [...groups].map(([id, group]) => ({ spaceId: id, ...group })),
        favorites: favorites.map((row) => row.sound),
        manageSpaceId: spaceId && access && access !== "member" ? spaceId : null,
        cooldownMs: rules.SOUND_COOLDOWN_MS
    };
}

/**
 * Play one sound into a call.
 *
 * Everything is checked again, in the order a reader would want to be told
 * about it, and only then does the cooldown count the play - a refusal costs
 * nobody their next three seconds. Returns once the call server took it; the
 * browser that pressed the button hears it back the same way everybody else
 * does, which is what makes "it played" mean that the room heard it.
 */
export async function playSound(seat: MeetingSeat, ref: string): Promise<void> {
    const { facts, userId, spaceId } = await seatFacts(seat);
    const refusal = rules.soundboardRefusal(facts);
    if (refusal) throw new ChatRuleError(REFUSAL_TEXT[refusal]);
    if (!userId) throw new ChatRuleError(REFUSAL_TEXT.guest);

    const parsed = rules.parseSoundRef(ref);
    if (!parsed) throw new ChatRuleError({ key: "errors.soundGone" });

    let played: Omit<rules.SoundPlayed, "id" | "from" | "userId">;
    if (parsed.kind === "default") {
        const sound = rules.DEFAULT_SOUNDS.find((entry) => entry.id === parsed.id);
        if (!sound) throw new ChatRuleError({ key: "errors.soundGone" });
        // The name is drawn by each browser in its own language.
        played = { kind: "sound", sound: ref, name: "", emoji: sound.emoji, volume: 1 };
    } else {
        const row = await prisma.chatSpaceSound.findUnique({
            where: { id: parsed.id },
            select: { id: true, spaceId: true, name: true, emoji: true, volume: true }
        });
        const reachable = row ? (await spaceAccess({ id: userId }, row.spaceId)) !== null : false;
        const problem = rules.soundRefusal(facts, {
            kind: "space",
            here: row?.spaceId === spaceId,
            reachable
        });
        if (!row || problem === "gone") throw new ChatRuleError({ key: "errors.soundGone" });
        if (problem === "external") throw new ChatRuleError({ key: "errors.soundboardExternal" });
        played = {
            kind: "sound",
            sound: row.id,
            name: row.name,
            emoji: row.emoji,
            volume: row.volume,
            url: soundUrl(row.id, seat.meetingId)
        };
    }

    const allowed = await rateLimit(`soundboard:${userId}`, 1, rules.SOUND_COOLDOWN_MS);
    if (!allowed.ok) {
        throw new ChatRuleError({
            key: "errors.soundboardCooldown",
            params: { seconds: Math.max(1, Math.ceil(allowed.retryAfterMs / 1000)) }
        });
    }

    const message: rules.SoundPlayed = {
        ...played,
        id: crypto.randomUUID(),
        from: seat.participantId,
        userId
    };
    if (!(await sendToRoom(seat.meetingId, message, rules.SOUNDBOARD_TOPIC))) {
        await resetRateLimit(`soundboard:${userId}`);
        throw new ChatRuleError({ key: "errors.soundboardUnreachable" });
    }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

/** Star a sound, or take the star off. Kept on the account, so it follows the
 *  person to every device - Discord's favourites do. */
export async function setFavorite(actor: ChatActor, sound: string, favorite: boolean): Promise<void> {
    if (!rules.parseSoundRef(sound)) throw new ChatRuleError({ key: "errors.soundGone" });
    if (!favorite) {
        await prisma.chatSoundFavorite.deleteMany({ where: { userId: actor.id, sound } });
        return;
    }
    const count = await prisma.chatSoundFavorite.count({ where: { userId: actor.id } });
    if (count >= 200) throw new ChatRuleError({ key: "errors.soundFavoritesFull" });
    await prisma.chatSoundFavorite.upsert({
        where: { userId_sound: { userId: actor.id, sound } },
        create: { userId: actor.id, sound },
        update: {}
    });
}

// ---------------------------------------------------------------------------
// A space's settings and its sounds
// ---------------------------------------------------------------------------

/** One role a denial can name, as the settings page offers it. */
export interface SoundRoleOption {
    readonly subject: string;
    /** An organization's role is named by the organization; the space's own two
     *  are named by the screen, in the reader's language. */
    readonly name: string | null;
}

/** Everything the soundboard settings page draws. */
export interface SpaceSoundboard {
    readonly spaceId: string;
    readonly spaceName: string;
    readonly enabled: boolean;
    readonly external: boolean;
    readonly sounds: readonly SoundView[];
    readonly slots: number;
    readonly denials: readonly (rules.SoundDenial & {
        readonly name: string | null;
        /** Whether the reader may lift it - see `rules.mayChangeDenial`. */
        readonly mayChange: boolean;
    })[];
    /** The roles the reader may deny. */
    readonly roles: readonly SoundRoleOption[];
    readonly channels: readonly {
        readonly id: string;
        readonly name: string;
        readonly kind: string;
        readonly enabled: boolean;
    }[];
}

/** The page, for whoever runs the space. */
export async function spaceSoundboard(actor: ChatActor, spaceId: string): Promise<SpaceSoundboard> {
    const access = await requireSpace(actor, spaceId, "admin");
    const space = await prisma.chatSpace.findUnique({
        where: { id: spaceId },
        select: { id: true, name: true, orgId: true, soundboard: true, soundboardExternal: true }
    });
    if (!space) throw new ChatRuleError({ key: "errors.notInSpace" });
    const granted = await grantedSubjects(actor.id, "chat.channel");
    const [sounds, denials, channels, orgRoles, actorOrgRole] = await Promise.all([
        prisma.chatSpaceSound.findMany({
            where: { spaceId },
            orderBy: { createdAt: "asc" },
            take: rules.SOUNDBOARD_SLOTS * 2,
            select: VIEW_SELECT
        }),
        denialsOf(spaceId),
        prisma.chatChannel.findMany({
            where: {
                spaceId,
                archived: false,
                OR: [
                    { private: false },
                    { members: { some: { userId: actor.id } } },
                    { id: { in: [...granted.keys()] } }
                ]
            },
            orderBy: { order: "asc" },
            take: 500,
            select: { id: true, name: true, kind: true, soundboard: true }
        }),
        space.orgId
            ? prisma.orgRole.findMany({
                  where: { orgId: space.orgId },
                  orderBy: { name: "asc" },
                  take: 200,
                  select: { slug: true, name: true }
              })
            : Promise.resolve([]),
        orgRoleOf(space.orgId, actor.id)
    ]);
    const deniedPeople = denials.filter((d) => d.kind === "user").map((d) => d.subject);
    const [people, standings] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: deniedPeople } },
            select: { id: true, name: true }
        }),
        spaceRolesOf(spaceId, deniedPeople)
    ]);
    const self: rules.SoundboardSubject = { userId: actor.id, spaceRole: access, orgRole: actorOrgRole };
    const mayChange = (denial: rules.SoundDenial) =>
        rules.mayChangeDenial(denial, self, {
            spaceRole: denial.kind === "user" ? (standings.get(denial.subject) ?? null) : null
        });
    const personName = new Map(people.map((person) => [person.id, person.name]));
    const roleName = new Map(
        orgRoles.map((role) => [`${rules.ORG_ROLE_PREFIX}${role.slug}`, role.name])
    );
    return {
        spaceId: space.id,
        spaceName: space.name,
        enabled: space.soundboard,
        external: space.soundboardExternal,
        sounds: sounds.map(view),
        slots: rules.SOUNDBOARD_SLOTS,
        denials: denials.map((denial) => ({
            ...denial,
            name:
                denial.kind === "user"
                    ? (personName.get(denial.subject) ?? null)
                    : (roleName.get(denial.subject) ?? null),
            mayChange: mayChange(denial)
        })),
        roles: [
            { subject: "member", name: null },
            { subject: "admin", name: null },
            ...orgRoles.map((role) => ({ subject: `${rules.ORG_ROLE_PREFIX}${role.slug}`, name: role.name }))
        ].filter((role) => mayChange({ kind: "role", subject: role.subject } as rules.SoundDenial)),
        channels: channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            enabled: channel.soundboard
        }))
    };
}

/** Turn the space's soundboard on or off, or its sounds from elsewhere. */
export async function setSpaceSoundboard(
    actor: ChatActor,
    input: { readonly spaceId: string; readonly enabled?: boolean; readonly external?: boolean }
): Promise<void> {
    await requireSpace(actor, input.spaceId, "admin");
    await prisma.chatSpace.update({
        where: { id: input.spaceId },
        data: {
            ...(input.enabled === undefined ? {} : { soundboard: input.enabled }),
            ...(input.external === undefined ? {} : { soundboardExternal: input.external })
        }
    });
}

/** Turn it on or off for one conversation in a space. */
export async function setChannelSoundboard(
    actor: ChatActor,
    input: { readonly channelId: string; readonly enabled: boolean }
): Promise<void> {
    const channel = await channelAccess(actor, input.channelId);
    if (!channel?.spaceId) throw new ChatRuleError({ key: "errors.notInSpace" });
    await requireSpace(actor, channel.spaceId, "admin");
    await prisma.chatChannel.update({
        where: { id: input.channelId },
        data: { soundboard: input.enabled }
    });
}

/** Deny the soundboard to a person or a role, or lift the denial. */
export async function setSoundDenial(
    actor: ChatActor,
    input: { readonly spaceId: string; readonly denial: rules.SoundDenial; readonly denied: boolean }
): Promise<void> {
    const access = await requireSpace(actor, input.spaceId, "admin");
    const key = { spaceId: input.spaceId, kind: input.denial.kind, subject: input.denial.subject };
    const named =
        input.denial.kind === "user"
            ? await spaceAccess({ id: input.denial.subject }, input.spaceId)
            : null;
    if (input.denied && named === "owner") {
        // The owner is never denied - the rule `rules.soundboardDenied` keeps too -
        // so the page cannot list a denial that does nothing.
        throw new ChatRuleError({ key: "errors.soundboardOwner" });
    }
    const space = await prisma.chatSpace.findUnique({
        where: { id: input.spaceId },
        select: { orgId: true }
    });
    const self: rules.SoundboardSubject = {
        userId: actor.id,
        spaceRole: access,
        orgRole: await orgRoleOf(space?.orgId ?? null, actor.id)
    };
    if (!rules.mayChangeDenial(input.denial, self, { spaceRole: named })) {
        throw new ChatRuleError({ key: "errors.soundboardDenialOwnerOnly" });
    }
    if (!input.denied) {
        await prisma.chatSoundboardDenial.deleteMany({ where: key });
        return;
    }
    await prisma.chatSoundboardDenial.upsert({
        where: { spaceId_kind_subject: key },
        create: { ...key, createdById: actor.id },
        update: {}
    });
}

/**
 * Add one.
 *
 * The file is checked first - it is the browser's WAV, read again here - and
 * the row is written inside a transaction that holds the space's row while it
 * counts, so two uploads racing for the last slot are one after the other and
 * the second is refused.
 */
export async function uploadSound(
    actor: ChatActor,
    input: {
        readonly spaceId: string;
        readonly name: string;
        readonly emoji: string;
        readonly volume: number;
        readonly bytes: Uint8Array;
    }
): Promise<SoundView> {
    await requireSpace(actor, input.spaceId, "admin");
    const file = readWav(input.bytes);
    if (!file.ok) throw new ChatRuleError(FILE_REFUSAL[file.problem]);

    const row = await prisma.$transaction(async (tx) => {
        if (loadEnv().POLARIS_DB_PROVIDER === "postgresql") {
            await tx.$queryRaw`SELECT "id" FROM "ChatSpace" WHERE "id" = ${input.spaceId}::uuid FOR UPDATE`;
        }
        const used = await tx.chatSpaceSound.count({ where: { spaceId: input.spaceId } });
        if (used >= rules.SOUNDBOARD_SLOTS) {
            throw new ChatRuleError({
                key: "errors.soundSlots",
                params: { count: rules.SOUNDBOARD_SLOTS }
            });
        }
        return tx.chatSpaceSound.create({
            data: {
                spaceId: input.spaceId,
                name: input.name,
                emoji: input.emoji,
                volume: input.volume,
                mime: "audio/wav",
                size: file.canonical.length,
                durationMs: file.durationMs,
                data: Buffer.from(file.canonical),
                uploaderId: actor.id
            },
            select: VIEW_SELECT
        });
    });
    return view(row);
}

/** The space one sound belongs to, for whoever runs it, or a refusal. */
async function managed(actor: ChatActor, soundId: string): Promise<{ id: string; spaceId: string }> {
    const row = await prisma.chatSpaceSound.findUnique({
        where: { id: soundId },
        select: { id: true, spaceId: true }
    });
    if (!row) throw new ChatRuleError({ key: "errors.soundGone" });
    await requireSpace(actor, row.spaceId, "admin");
    return row;
}

/** Rename one, give it another emoji, or change how loud it plays. */
export async function updateSound(actor: ChatActor, input: rules.SoundUpdateInput): Promise<SoundView> {
    const row = await managed(actor, input.soundId);
    const updated = await prisma.chatSpaceSound.update({
        where: { id: row.id },
        data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.emoji === undefined ? {} : { emoji: input.emoji }),
            ...(input.volume === undefined ? {} : { volume: input.volume })
        },
        select: VIEW_SELECT
    });
    return view(updated);
}

/** Take one away, and the stars people gave it. */
export async function deleteSound(actor: ChatActor, soundId: string): Promise<void> {
    const row = await managed(actor, soundId);
    await prisma.$transaction([
        prisma.chatSoundFavorite.deleteMany({ where: { sound: row.id } }),
        prisma.chatSpaceSound.delete({ where: { id: row.id } })
    ]);
}

// ---------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------

/** One sound's clip, for somebody who reaches its space, or null - the same
 *  answer as "there is no such sound". */
export async function readSound(
    actor: ChatActor | null,
    soundId: string,
    playedIn: { readonly seat: MeetingSeat | null; readonly ticketValid: boolean } | null
): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | null> {
    const row = await prisma.chatSpaceSound.findUnique({
        where: { id: soundId },
        select: { spaceId: true, mime: true, data: true }
    });
    if (!row) return null;
    const inCall = Boolean(
        playedIn?.ticketValid && playedIn.seat && playedIn.seat.admission === "admitted"
    );
    if (!inCall) {
        if (!actor || !(await spaceAccess(actor, row.spaceId))) return null;
    }
    return { mime: row.mime, bytes: new Uint8Array(row.data) };
}
