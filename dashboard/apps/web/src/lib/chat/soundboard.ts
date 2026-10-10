/**
 * The soundboard's rules: what a sound is, who may play one, and what a play
 * looks like on the wire.
 *
 * Discord's soundboard is the model, held to its real limits rather than to
 * round numbers: a sound is at most 512 KB and 5.2 seconds, its name is two to
 * thirty-two characters, it carries one emoji and a volume of its own, and a
 * space holds at most 48 of them - Discord's ceiling at its highest boost
 * level, which is the only level a space here has.
 *
 * **Who may play is decided on the server, every time.** The button is hidden
 * or disabled from the same answer (`soundboardRefusal`), but a press is only a
 * request: the server resolves the call, the conversation, the space, the
 * person and the sound again, and only then does it put the sound into the
 * room. The play reaches the other browsers from the call server itself rather
 * than from the browser that pressed the button, so a browser that skipped the
 * check has nothing to send - see `soundboard-service`.
 *
 * **Roles.** A space here has two roles, `member` and `admin`, and its owner
 * outranks both. A space that belongs to an organization also has the roles of
 * that organization, which are what a person holds there (`owner`, `admin`,
 * `member`, or one the organization made). Either can be denied the soundboard,
 * and so can one person. A denial of any of them beats everything else - the
 * rule the rest of Polaris follows - except for the space's owner, who decides
 * the denials and could lift one on themselves anyway.
 *
 * Pure, so the whole decision can be checked without a call server or a
 * database, and shared by the server and the screens.
 */

import { z } from "zod";

/** Discord's own limits for one sound. */
export const SOUND_MAX_BYTES = 512 * 1024;
export const SOUND_MAX_MS = 5_200;
export const SOUND_NAME_MIN = 2;
export const SOUND_NAME_MAX = 32;

/** How many sounds one space holds: Discord's ceiling at boost level three. */
export const SOUNDBOARD_SLOTS = 48;

/**
 * How long somebody waits between two sounds.
 *
 * Discord documents no cooldown of its own and leaves spam to moderation bots;
 * a soundboard nobody can be stopped from mashing is the first thing an
 * operator would ask to turn off, so Polaris holds everybody to one sound every
 * three seconds - on the server, per account, across every tab.
 */
export const SOUND_COOLDOWN_MS = 3_000;

/** The topic a play travels under on the call's data channel. */
export const SOUNDBOARD_TOPIC = "polaris.soundboard";

/**
 * The sounds every call has, whoever is in it.
 *
 * Original, synthesised in the browser (`soundboard-synth`), so they cost
 * nothing to ship, never 404 after an update and owe nobody a licence. The name
 * each one is shown under lives in the catalogs, under `soundboard.defaults`.
 */
export const DEFAULT_SOUNDS = [
    { id: "applause", emoji: "\u{1F44F}" },
    { id: "rimshot", emoji: "\u{1F941}" },
    { id: "crickets", emoji: "\u{1F997}" },
    { id: "letdown", emoji: "\u{1F3BA}" },
    { id: "fanfare", emoji: "\u{1F389}" },
    { id: "boing", emoji: "\u{1F300}" },
    { id: "whoosh", emoji: "\u{1F4A8}" },
    { id: "horn", emoji: "\u{1F4EF}" }
] as const;

export type DefaultSoundId = (typeof DEFAULT_SOUNDS)[number]["id"];

export const DEFAULT_SOUND_IDS = DEFAULT_SOUNDS.map((sound) => sound.id) as [
    DefaultSoundId,
    ...DefaultSoundId[]
];

/** The prefix a default sound's reference carries, so it can never be mistaken
 *  for an uploaded one's id. */
const DEFAULT_PREFIX = "default:";

/** One sound, as a play and a favourite name it: a default by its id, or a
 *  space's sound by its row id. */
export type SoundRef = `default:${DefaultSoundId}` | string;

export function defaultRef(id: DefaultSoundId): SoundRef {
    return `${DEFAULT_PREFIX}${id}`;
}

/** What a reference points at, or null for one that points at nothing. */
export function parseSoundRef(
    ref: string
): { kind: "default"; id: DefaultSoundId } | { kind: "space"; id: string } | null {
    if (ref.startsWith(DEFAULT_PREFIX)) {
        const id = ref.slice(DEFAULT_PREFIX.length);
        return (DEFAULT_SOUND_IDS as readonly string[]).includes(id)
            ? { kind: "default", id: id as DefaultSoundId }
            : null;
    }
    return z.string().uuid().safeParse(ref).success ? { kind: "space", id: ref.toLowerCase() } : null;
}

export const soundRefSchema = z
    .string()
    .max(64)
    .refine((ref) => parseSoundRef(ref) !== null);

// ---------------------------------------------------------------------------
// A sound's own fields
// ---------------------------------------------------------------------------

/** The name as it is stored: trimmed, and every run of spaces one space. */
export function normalizeSoundName(raw: string): string {
    return raw.trim().replace(/\s+/g, " ");
}

export type SoundNameProblem = "short" | "long";

export function soundNameProblem(name: string): SoundNameProblem | null {
    const length = [...name].length;
    if (length < SOUND_NAME_MIN) return "short";
    if (length > SOUND_NAME_MAX) return "long";
    return null;
}

export const soundNameSchema = z
    .string()
    .max(SOUND_NAME_MAX * 4)
    .transform(normalizeSoundName)
    .superRefine((name, context) => {
        const problem = soundNameProblem(name);
        if (problem) context.addIssue({ code: "custom", message: problem });
    });

/**
 * Whether a string is one emoji and nothing else.
 *
 * One grapheme, and a pictographic one: a flag, a skin tone and a family are
 * each one grapheme made of several code points, and a letter is not an emoji
 * however it is written. Empty is allowed - it means no emoji.
 */
export function isOneEmoji(value: string): boolean {
    if (value === "") return true;
    if (value.length > 32) return false;
    const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)];
    if (graphemes.length !== 1) return false;
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

export const soundEmojiSchema = z
    .string()
    .transform((value) => value.trim())
    .refine(isOneEmoji, { message: "emoji" });

/** A sound's volume, 0 to 1, as stored. The screens show it as a percentage. */
export const soundVolumeSchema = z.number().min(0).max(1);

export const soundUploadFieldsSchema = z.object({
    spaceId: z.string().uuid(),
    name: soundNameSchema,
    emoji: soundEmojiSchema,
    volume: soundVolumeSchema
});

export const soundUpdateSchema = z.object({
    soundId: z.string().uuid(),
    name: soundNameSchema.optional(),
    emoji: soundEmojiSchema.optional(),
    volume: soundVolumeSchema.optional()
});

export type SoundUpdateInput = z.infer<typeof soundUpdateSchema>;

export const soundDeleteSchema = z.object({ soundId: z.string().uuid() });

export const soundPlaySchema = z.object({
    meetingId: z.string().uuid(),
    sound: soundRefSchema
});

export const soundFavoriteSchema = z.object({
    sound: soundRefSchema,
    favorite: z.boolean()
});

export const spaceSoundboardSchema = z.object({
    spaceId: z.string().uuid(),
    enabled: z.boolean().optional(),
    external: z.boolean().optional()
});

export const channelSoundboardSchema = z.object({
    channelId: z.string().uuid(),
    enabled: z.boolean()
});

// ---------------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------------

/** The space's own two roles, as a denial names them. */
export const SPACE_ROLES = ["member", "admin"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** The prefix an organization's role carries in a denial, so a role an
 *  organization happened to call `admin` is not the space's `admin`. */
export const ORG_ROLE_PREFIX = "org:";

export const soundDenialSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), subject: z.string().uuid() }),
    z.object({
        kind: z.literal("role"),
        subject: z.union([
            z.enum(SPACE_ROLES),
            z
                .string()
                .regex(/^org:[a-z0-9][a-z0-9_-]{0,62}$/)
        ])
    })
]);

export type SoundDenial = z.infer<typeof soundDenialSchema>;

export const soundDenialChangeSchema = z.object({
    spaceId: z.string().uuid(),
    denial: soundDenialSchema,
    denied: z.boolean()
});

/** Everything about one person that a denial can name. */
export interface SoundboardSubject {
    readonly userId: string;
    /** `owner` for the space's owner, who is never denied. */
    readonly spaceRole: SpaceRole | "owner";
    /** Their role in the organization that owns the space, when it has one and
     *  they are in it. */
    readonly orgRole: string | null;
}

/**
 * Whether any denial names this person, directly or through a role they hold.
 *
 * Deny beats allow and there is no allow to beat: the soundboard is on for
 * everybody until a denial says otherwise. A denial of `member` does not reach
 * an administrator, as Discord's Administrator passes over role overwrites:
 * the people who run the space can deny it to every member, and only the owner
 * denies an administrator - through `admin`, by name, or through an
 * organization role they hold.
 */
export function soundboardDenied(
    denials: readonly SoundDenial[],
    subject: SoundboardSubject
): boolean {
    if (subject.spaceRole === "owner") return false;
    const roles = new Set<string>([subject.spaceRole]);
    if (subject.orgRole) roles.add(`${ORG_ROLE_PREFIX}${subject.orgRole}`);
    return denials.some((denial) =>
        denial.kind === "user" ? denial.subject === subject.userId : roles.has(denial.subject)
    );
}

/**
 * Whether somebody who runs the space may add or lift this denial.
 *
 * The owner may change any of them. An administrator may change a denial of
 * `member`, of a person who does not run the space and of an organization role
 * no administrator holds. They may not change one that reaches themselves -
 * `admin`, their own name, a role of theirs - or "deny beats allow" would mean
 * nothing to the people who manage it, nor one naming another administrator or
 * a role another administrator holds, so the administrators cannot silence each
 * other: both are the owner's to decide.
 */
export function mayChangeDenial(
    denial: SoundDenial,
    actor: SoundboardSubject,
    named: {
        /** The standing of the person a denial names. */
        readonly spaceRole: SpaceRole | "owner" | null;
        /** Whether an administrator holds the organization role a denial names. */
        readonly heldByAdmin?: boolean;
    } = { spaceRole: null }
): boolean {
    if (actor.spaceRole === "owner") return true;
    if (soundboardDenied([denial], actor)) return false;
    if (denial.kind === "role") return !(denial.subject.startsWith(ORG_ROLE_PREFIX) && named.heldByAdmin);
    return named.spaceRole !== "admin" && named.spaceRole !== "owner";
}

// ---------------------------------------------------------------------------
// Who may play
// ---------------------------------------------------------------------------

/** Why the soundboard is not available, as a word the screens turn into a
 *  sentence. Ordered by how a reader would want to be told: the reasons
 *  nobody here can change first, their own controls last. */
export type SoundboardRefusal =
    /** A guest in a meeting: no account to hold a cooldown or a denial to. */
    | "guest"
    /** A meeting of its own, not a conversation's call. */
    | "standalone"
    /** Turned off for the whole space. */
    | "spaceOff"
    /** Turned off for this conversation. */
    | "channelOff"
    /** Denied to this person, or to a role they hold. */
    | "denied"
    /** A moderator muted or deafened them for the room. */
    | "moderated"
    /** Their own microphone is off - Discord's rule too. */
    | "muted"
    /** Their own headphones are off. */
    | "deafened";

/** What the server knows about one seat in one call, when somebody asks. */
export interface SoundboardFacts {
    readonly guest: boolean;
    /** The call has no conversation. */
    readonly standalone: boolean;
    /** The space the conversation is in, or null for a direct message or a
     *  group. */
    readonly space: { readonly enabled: boolean; readonly external: boolean } | null;
    /** The conversation's own switch. Always true outside a space. */
    readonly channelEnabled: boolean;
    readonly denied: boolean;
    readonly muted: boolean;
    readonly deafened: boolean;
    readonly serverMuted: boolean;
    readonly serverDeafened: boolean;
}

/** Why this seat may not use the soundboard at all, or null when it may. */
export function soundboardRefusal(facts: SoundboardFacts): SoundboardRefusal | null {
    if (facts.guest) return "guest";
    if (facts.standalone) return "standalone";
    if (facts.space && !facts.space.enabled) return "spaceOff";
    if (!facts.channelEnabled) return "channelOff";
    if (facts.denied) return "denied";
    if (facts.serverMuted || facts.serverDeafened) return "moderated";
    if (facts.deafened) return "deafened";
    if (facts.muted) return "muted";
    return null;
}

/** Where a sound comes from, against the call it is asked to play in. */
export type SoundOrigin =
    | { readonly kind: "default" }
    | {
          readonly kind: "space";
          /** The sound's own space is the call's space. */
          readonly here: boolean;
          /** The person playing it reaches the sound's space. */
          readonly reachable: boolean;
      };

/** Why one sound may not be played here, by somebody who may use the
 *  soundboard. */
export type SoundRefusal =
    /** No such sound, or one the player cannot reach. */
    | "gone"
    /** From another space, and this space keeps to its own. */
    | "external";

/**
 * Whether this sound may be played in this call.
 *
 * A default always may, and so does one of the call's own space: the picker
 * offers them to everybody in the call, whoever brought them in. A sound from
 * another space needs its player to reach that space -
 * the picker never offers one they do not, and a reference typed by hand is
 * answered as if the sound did not exist. One from another space also needs the
 * call's space to allow sounds from elsewhere; outside a space - a direct
 * message, a group - every sound the player has is theirs to bring, the way a
 * Discord member brings their servers' sounds into a DM call.
 */
export function soundRefusal(facts: SoundboardFacts, origin: SoundOrigin): SoundRefusal | null {
    if (origin.kind === "default") return null;
    if (origin.here) return null;
    if (!origin.reachable) return "gone";
    if (facts.space && !facts.space.external) return "external";
    return null;
}

// ---------------------------------------------------------------------------
// A play, on the wire
// ---------------------------------------------------------------------------

/** Where a space's sound is read from by everybody in the call. Signed for the
 *  call it was played in, so somebody who is not in the sound's space can
 *  still hear it - see `soundboard-ticket`. */
const SOUND_URL = /^\/api\/chat\/sounds\/[0-9a-f-]{36}\?m=[0-9a-f-]{36}&t=[A-Za-z0-9_.-]{10,200}$/;

/**
 * What the call server hands every browser in the room when somebody plays a
 * sound.
 *
 * Validated as strictly as a request body even though only the server sends
 * it: a browser only believes one that arrived with no participant attached -
 * the call server's own voice - and checks its shape before it plays anything.
 */
export const soundPlayedSchema = z.object({
    kind: z.literal("sound"),
    /** One play, so the same sound twice in a row is two plays. */
    id: z.string().uuid(),
    /** The seat that played it, which is the face the cue is drawn over. */
    from: z.string().uuid(),
    /** Their account, which is what a listener mutes. */
    userId: z.string().uuid(),
    sound: soundRefSchema,
    name: z.string().max(SOUND_NAME_MAX * 4),
    emoji: z.string().max(32),
    volume: soundVolumeSchema,
    /** Absent for a default, which every browser makes itself. */
    url: z.string().regex(SOUND_URL).optional()
});

export type SoundPlayed = z.infer<typeof soundPlayedSchema>;

/** How loud one play is for one listener: the sound's own volume times theirs,
 *  and nothing at all from somebody they muted. */
export function playbackVolume(
    played: Pick<SoundPlayed, "volume" | "userId">,
    listener: { readonly volume: number; readonly muted: ReadonlySet<string> }
): number {
    if (listener.muted.has(played.userId)) return 0;
    const value = played.volume * listener.volume;
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
