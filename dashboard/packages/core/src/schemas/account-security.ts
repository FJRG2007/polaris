/**
 * Account-security schemas: the shapes behind a user's own protection settings -
 * quick-unlock PIN, session limits, recovery questions, network access rules,
 * and personal API keys. Shared so the dialogs validate in real time against
 * exactly what the server actions enforce.
 *
 * Network rules are additive everywhere they appear: the effective allowlist for
 * a sign-in or an API key is the union of its attached access groups and its own
 * inline rules, and an empty union means "no restriction". A malformed rule would
 * silently narrow that union, so every entry is validated at save time.
 */

import { z } from "zod";
import { isCidr, isIpAddress } from "../cidr.js";
import { CONTINENTS, COUNTRY_CODES } from "../geo.js";
import { USER_AGENT_PATTERN_MAX } from "../user-agent.js";
import { expandPermissions, PERMISSIONS } from "../permissions.js";

/** A single IP address or CIDR range in a network allowlist. */
export const ipRuleField = z
    .string()
    .trim()
    .refine((value) => isIpAddress(value) || isCidr(value), {
        message: "Must be an IP address or CIDR range"
    });

const countryCodeField = z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => COUNTRY_CODES.includes(value), { message: "Unknown country" });

const continentCodeField = z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => CONTINENTS.some((entry) => entry.code === value), { message: "Unknown continent" });

const uniqueList = <T extends z.ZodTypeAny>(item: T) =>
    z.array(item).max(200).transform((values) => Array.from(new Set(values)) as z.infer<T>[]);

/** The network rules a target (an account sign-in or an API key) may carry. */
export const accessRulesSchema = z.object({
    /** Access groups whose rules are folded in. */
    groupIds: z.array(z.string().uuid()).max(50).default([]),
    allowedCidrs: uniqueList(ipRuleField).default([]),
    allowedCountries: uniqueList(countryCodeField).default([]),
    allowedContinents: uniqueList(continentCodeField).default([])
});

export type AccessRulesInput = z.infer<typeof accessRulesSchema>;

/** A reusable named rule set, created and owned by the user. */
export const accessGroupSchema = accessRulesSchema.omit({ groupIds: true }).extend({
    name: z.string().trim().min(1, "Name is required").max(60),
    description: z.string().trim().max(200).optional()
});

export type AccessGroupInput = z.infer<typeof accessGroupSchema>;

// ---------------------------------------------------------------------------
// Quick-unlock PIN and session limits
// ---------------------------------------------------------------------------

/** The quick-unlock PIN. Only re-opens a locked dashboard - signing in always
 *  requires the password - so 4-6 digits is an acceptable trade for speed. */
export const pinField = z
    .string()
    .trim()
    .regex(/^\d{4,6}$/, "Use 4 to 6 digits");

export const setPinSchema = z
    .object({
        pin: pinField,
        confirmPin: z.string().trim(),
        password: z.string().min(1, "Password is required")
    })
    .refine((value) => value.pin === value.confirmPin, {
        message: "The PINs do not match",
        path: ["confirmPin"]
    });

/** Inactivity before the dashboard locks. 0 disables the lock entirely. */
export const IDLE_LOCK_CHOICES = [0, 5, 15, 30, 60, 120, 480] as const;

/** Absolute session lifetime. 0 keeps the instance default (7 days). */
export const SESSION_MAX_CHOICES = [0, 60, 480, 1440, 10080, 43200] as const;

export const sessionLimitsSchema = z.object({
    idleLockMinutes: z
        .number()
        .int()
        .refine((value) => (IDLE_LOCK_CHOICES as readonly number[]).includes(value), {
            message: "Unsupported lock timeout"
        }),
    sessionMaxMinutes: z
        .number()
        .int()
        .refine((value) => (SESSION_MAX_CHOICES as readonly number[]).includes(value), {
            message: "Unsupported session lifetime"
        })
});

/**
 * How long a device newly seen on an account waits before it may change what
 * protects that account. 0 asks for no wait, which is the default.
 *
 * Offered as a list rather than a free number so the screen can name each one,
 * and so a value nobody chose cannot be stored through the endpoint. An
 * unrecognised one is refused rather than rounded: every direction it could be
 * rounded in is a different promise about the account.
 */
export const NEW_DEVICE_GRACE_CHOICES = [0, 1, 3, 7, 14, 30] as const;

export const newDeviceGraceSchema = z
    .number()
    .int()
    .refine((value) => (NEW_DEVICE_GRACE_CHOICES as readonly number[]).includes(value), {
        message: "Unsupported wait"
    });

// ---------------------------------------------------------------------------
// Signing in by QR code
// ---------------------------------------------------------------------------

/**
 * The only client allowed to open a QR sign-in. The device flow is not a public
 * API here - Polaris is both the screen showing the code and the app approving
 * it - so anything else asking for a code is refused.
 */
export const QR_SIGN_IN_CLIENT_ID = "polaris-dashboard";

/** Where a scanned code is answered. Also the path the QR itself encodes. */
export const QR_SIGN_IN_PATH = "/account/scan";

/** How long a code on the sign-in screen stays good. Short: it is on display in
 *  whatever room the screen is in, and the person is signing in right now. */
export const QR_SIGN_IN_TTL_SECONDS = 120;

/** How often the waiting screen may ask whether the code has been answered. */
export const QR_SIGN_IN_POLL_SECONDS = 3;

/**
 * The code as it is shown and typed. The generator emits uppercase letters and
 * digits without the characters that read as each other, and a code is only ever
 * compared after the display grouping is stripped.
 */
export const qrUserCodeField = z
    .string()
    .trim()
    .toUpperCase()
    .transform((value) => value.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^[A-Z0-9]{6,12}$/, "That code is not a Polaris sign-in code"));

/** Answering a scanned code. Approving needs the PIN; refusing only closes a
 *  door, so the field is optional and ignored on a refusal. */
export const qrSignInDecisionSchema = z.object({
    userCode: qrUserCodeField,
    approve: z.boolean(),
    pin: z.string().trim().default("")
});

export type QrSignInDecision = z.infer<typeof qrSignInDecisionSchema>;

// ---------------------------------------------------------------------------
// Recovery questions
// ---------------------------------------------------------------------------

/** How many questions must be set to arm password recovery, and answered to use it. */
export const SECURITY_QUESTION_COUNT = 3;

/** Starting points offered in the dialog; the user may write their own. */
export const SECURITY_QUESTION_SUGGESTIONS: readonly string[] = [
    "What was the name of your first pet?",
    "What city were you born in?",
    "What was the make of your first car?",
    "What is your oldest sibling's middle name?",
    "What was the name of your first school?",
    "What street did you live on at age ten?"
];

const securityAnswerField = z
    .string()
    .trim()
    .min(2, "Answer is too short")
    .max(120, "Answer is too long");

export const securityQuestionsSchema = z.object({
    answers: z
        .array(
            z.object({
                question: z.string().trim().min(5, "Question is too short").max(200),
                answer: securityAnswerField
            })
        )
        .length(SECURITY_QUESTION_COUNT, `Set ${SECURITY_QUESTION_COUNT} questions`)
});

/** Proving identity without the current password: answer every question, or
 *  present a valid authenticator code. */
export const recoverPasswordSchema = z
    .object({
        newPassword: z.string().min(10, "Use at least 10 characters").max(256),
        answers: z.array(securityAnswerField).default([]),
        totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional()
    })
    .refine((value) => value.totpCode !== undefined || value.answers.length === SECURITY_QUESTION_COUNT, {
        message: "Answer your security questions or use an authenticator code",
        path: ["answers"]
    });

// ---------------------------------------------------------------------------
// Recovering an account from outside it
// ---------------------------------------------------------------------------

/** How a request to get back into an account stands. */
export const ACCOUNT_RECOVERY_STATUSES = ["pending", "approved", "denied", "expired", "used"] as const;

export type AccountRecoveryStatus = (typeof ACCOUNT_RECOVERY_STATUSES)[number];

const recoveryIdentifierField = z
    .string()
    .trim()
    .min(1, "Enter your email or username")
    .max(200);

export const recoveryLookupSchema = z.object({ identifier: recoveryIdentifierField });

/**
 * Raising the request. Answers are optional because the route exists precisely
 * for accounts that have nothing left to prove with: one that never set the
 * questions still gets to ask, and the administrator deciding it is told that
 * nothing was verified.
 */
export const recoveryRequestSchema = z.object({
    identifier: recoveryIdentifierField,
    answers: z.array(securityAnswerField).max(SECURITY_QUESTION_COUNT).default([])
});

/** Spending an approved request on a new password. */
export const recoveryResetSchema = z.object({
    ticket: z.string().trim().min(1).max(512),
    newPassword: z.string().min(10, "Use at least 10 characters").max(256)
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** Marks a Polaris personal access token, so a leaked string is recognizable. */
export const API_KEY_PREFIX = "plk";

/** How long a key may live. 0 means it never expires. */
export const API_KEY_EXPIRY_CHOICES = [0, 7, 30, 90, 180, 365] as const;

/** How far ahead a hand-picked expiry date may sit. */
export const API_KEY_MAX_EXPIRY_YEARS = 10;

/** How many client patterns one key may carry per list. A handful describes any
 *  real client; a long list is a sign the rule is not doing what was meant. */
const USER_AGENT_LIST_MAX = 20;

/** One client pattern, normalized before it is checked so a value that only
 *  differs by surrounding space is the same rule. */
const userAgentPattern = z.string().trim().min(1, "Enter a pattern").max(USER_AGENT_PATTERN_MAX);

/** The client lists a key may carry, on top of the addresses it may be used
 *  from. Duplicates are dropped: two copies of a pattern decide nothing twice. */
export const userAgentRulesSchema = z.object({
    allowedUserAgents: z
        .array(userAgentPattern)
        .max(USER_AGENT_LIST_MAX)
        .default([])
        .transform((values) => [...new Set(values)]),
    deniedUserAgents: z
        .array(userAgentPattern)
        .max(USER_AGENT_LIST_MAX)
        .default([])
        .transform((values) => [...new Set(values)])
});

export const createApiKeySchema = accessRulesSchema.extend({
    ...userAgentRulesSchema.shape,
    name: z.string().trim().min(1, "Name is required").max(60),
    /** Permissions the key may exercise; it can only ever narrow its owner's own. */
    scopes: z
        .array(z.enum(PERMISSIONS))
        .min(1, "Pick at least one scope")
        .transform((values) => expandPermissions(values)),
    expiresInDays: z
        .number()
        .int()
        .refine((value) => (API_KEY_EXPIRY_CHOICES as readonly number[]).includes(value), {
            message: "Unsupported expiry"
        })
        .default(90),
    /** A hand-picked expiry instant. Takes the place of one of the fixed spans. */
    expiresAt: z
        .string()
        .datetime({ offset: true })
        .optional()
        .refine((value) => value === undefined || new Date(value).getTime() > Date.now(), {
            message: "Pick a date in the future"
        })
        .refine(
            (value) =>
                value === undefined ||
                new Date(value).getTime() <
                    Date.now() + API_KEY_MAX_EXPIRY_YEARS * 365 * 24 * 60 * 60 * 1000,
            { message: `Pick a date within ${API_KEY_MAX_EXPIRY_YEARS} years` }
        )
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON string array column back into a list. The schema stores arrays as
 * strings for SQLite portability, so every reader goes through here rather than
 * trusting the column to parse; a corrupted value degrades to an empty list,
 * which for an allowlist means "no restriction from this source" - the union
 * with the other sources still decides.
 */
export function parseStringList(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

/** Serialize a list back to the stored JSON string form. */
export function stringifyList(values: readonly string[]): string {
    return JSON.stringify(Array.from(new Set(values)));
}

/** The stored columns every rule-carrying row shares. */
export interface StoredAccessRules {
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
}

/** The flattened allowlist a check runs against. */
export interface EffectiveAccessRules {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}

/**
 * Fold several rule sources into one allowlist. Rules are additive by design: a
 * target's effective allowlist is its own rules plus every access group attached
 * to it, so adding a group can only ever widen access, never narrow it. An empty
 * result means no restriction, which is what makes "attach nothing" the safe
 * default for a target that has never been configured.
 */
export function unionRules(
    sources: ReadonlyArray<StoredAccessRules | null | undefined>
): EffectiveAccessRules {
    const cidrs = new Set<string>();
    const countries = new Set<string>();
    const continents = new Set<string>();
    for (const source of sources) {
        if (!source) continue;
        for (const rule of parseStringList(source.allowedCidrs)) cidrs.add(rule);
        for (const code of parseStringList(source.allowedCountries)) countries.add(code);
        for (const code of parseStringList(source.allowedContinents)) continents.add(code);
    }
    return {
        allowedCidrs: [...cidrs],
        allowedCountries: [...countries],
        allowedContinents: [...continents]
    };
}
