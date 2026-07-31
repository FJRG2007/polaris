/**
 * A user's own security settings: the quick-unlock PIN, the session limits, the
 * login-approval switch, the recovery questions, and the network rules that
 * govern where the account may sign in from.
 *
 * Secrets are hashed through better-auth's context, the same slow hasher that
 * stores passwords, so there is one source of truth for how a credential is
 * protected. Every mutation that weakens a control (setting or clearing the PIN,
 * replacing the recovery questions) re-verifies the current password first, so
 * a hijacked session cannot quietly install its own way back in.
 */

import {
    parseStringList,
    stringifyList,
    TWO_FACTOR_DELIVERY_METHODS,
    TWO_FACTOR_METHODS,
    type AccessRulesInput,
    type TwoFactorDeliveryMethod,
    type TwoFactorMethod,
    type TwoFactorPreferencesInput
} from "@polaris/core";
import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";

/** The effective settings for a user, with the defaults an absent row implies. */
export interface UserSecuritySettings {
    hasPin: boolean;
    idleLockMinutes: number;
    sessionMaxMinutes: number;
    requireLoginApproval: boolean;
    /** Second-factor methods that send a code, beyond the authenticator. */
    twoFactorMethods: TwoFactorDeliveryMethod[];
    /** The method the challenge offers first. */
    twoFactorPreferred: TwoFactorMethod;
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    groupIds: string[];
}

const DEFAULTS: UserSecuritySettings = {
    hasPin: false,
    idleLockMinutes: 0,
    sessionMaxMinutes: 0,
    requireLoginApproval: false,
    twoFactorMethods: [],
    twoFactorPreferred: "totp",
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: [],
    groupIds: []
};

/** Read the credential password hash for a user, or null if they have none. */
async function credentialHash(userId: string): Promise<string | null> {
    const account = await prisma.account.findFirst({
        where: { userId, providerId: "credential" },
        select: { password: true }
    });
    return account?.password ?? null;
}

/** Verify a user's current password against their stored credential hash. */
async function verifyPassword(auth: Auth, userId: string, password: string): Promise<boolean> {
    const hash = await credentialHash(userId);
    if (!hash) return false;
    const ctx = await auth.$context;
    return ctx.password.verify({ hash, password });
}

/**
 * Hash a low-entropy secret (PIN, recovery answer, a sent code) with the password
 * hasher, so everything short enough to be guessed is stored the same slow way.
 */
export async function hashSecret(auth: Auth, value: string): Promise<string> {
    const ctx = await auth.$context;
    return ctx.password.hash(value);
}

/** Check a value against a hash written by hashSecret. */
export async function verifySecret(auth: Auth, hash: string, value: string): Promise<boolean> {
    const ctx = await auth.$context;
    return ctx.password.verify({ hash, password: value });
}

/**
 * The user's effective security settings, including the groups they attached
 * themselves. Groups an administrator enforced are deliberately absent: this
 * feeds the account's own editor, and what it does not show it cannot detach.
 */
export async function getUserSecurity(userId: string): Promise<UserSecuritySettings> {
    const [row, bindings] = await Promise.all([
        prisma.userSecurity.findUnique({ where: { userId } }),
        prisma.userAccessGroup.findMany({ where: { userId, enforced: false }, select: { groupId: true } })
    ]);
    const groupIds = bindings.map((binding) => binding.groupId);
    if (!row) return { ...DEFAULTS, groupIds };
    return {
        hasPin: row.pinHash !== null,
        idleLockMinutes: row.idleLockMinutes,
        sessionMaxMinutes: row.sessionMaxMinutes,
        requireLoginApproval: row.requireLoginApproval,
        twoFactorMethods: parseDeliveryMethods(row.twoFactorMethods),
        twoFactorPreferred: parsePreferredMethod(row.twoFactorPreferred),
        allowedCidrs: parseStringList(row.allowedCidrs),
        allowedCountries: parseStringList(row.allowedCountries),
        allowedContinents: parseStringList(row.allowedContinents),
        groupIds
    };
}

/** Create-or-update the settings row for a user with a partial change. */
async function upsertSecurity(
    userId: string,
    data: Parameters<typeof prisma.userSecurity.update>[0]["data"]
): Promise<void> {
    await prisma.userSecurity.upsert({
        where: { userId },
        create: { userId, ...data } as Parameters<typeof prisma.userSecurity.create>[0]["data"],
        update: data
    });
}

/** Set how long a session may idle before locking, and how long it may live. */
export async function updateSessionLimits(
    userId: string,
    limits: { idleLockMinutes: number; sessionMaxMinutes: number }
): Promise<void> {
    await upsertSecurity(userId, limits);
}

/** Turn the "new sign-ins need approval" gate on or off. */
export async function setLoginApprovalRequired(userId: string, required: boolean): Promise<void> {
    await upsertSecurity(userId, { requireLoginApproval: required });
}

// ---------------------------------------------------------------------------
// Second-factor methods
// ---------------------------------------------------------------------------

/** Read the stored method list, dropping anything this build no longer knows. */
function parseDeliveryMethods(stored: string): TwoFactorDeliveryMethod[] {
    const known: readonly string[] = TWO_FACTOR_DELIVERY_METHODS;
    return parseStringList(stored).filter((value): value is TwoFactorDeliveryMethod => known.includes(value));
}

/** An unknown or absent preference falls back to the authenticator, which is the
 *  one method that is always accepted while the factor is on. */
function parsePreferredMethod(stored: string | null): TwoFactorMethod {
    const known: readonly string[] = TWO_FACTOR_METHODS;
    return stored !== null && known.includes(stored) ? (stored as TwoFactorMethod) : "totp";
}

/**
 * Replace which methods the account accepts and which it offers first.
 *
 * Turning a method on widens the ways into the account, so it re-verifies the
 * password like every other control that does. Whether a method can actually
 * deliver right now - a channel to send through, a proved address or number - is
 * the caller's to check: this package knows the settings, not the deployment.
 */
export async function setTwoFactorPreferences(
    auth: Auth,
    userId: string,
    input: TwoFactorPreferencesInput,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    await upsertSecurity(userId, {
        twoFactorMethods: stringifyList(input.methods),
        twoFactorPreferred: input.preferred
    });
    return {};
}

/**
 * How long a rotation pass stays valid. Long enough to cover the round trip that
 * replaces the session and the navigation that follows it, short enough that it
 * is not a standing hole in the approval gate.
 */
const ROTATION_GRACE_MS = 2 * 60 * 1000;

/**
 * Issue a pass that lets the session replacing this one skip the approval gate.
 *
 * better-auth replaces the current session when an authenticator is armed or
 * removed: it creates a new one, copies the old one's details onto it, and
 * deletes the old. To the guard that is a session it has never seen, so with
 * "Approve new sign-ins" on it was held pending and the user was asked to
 * approve themselves from another session - with the session that would have
 * done the approving already gone.
 *
 * The pass is bound to the address that asked for it and consumed on first use,
 * so it only ever covers the continuation it was issued for.
 */
export async function beginSessionRotation(userId: string, ip: string | null): Promise<void> {
    await upsertSecurity(userId, {
        rotationGraceUntil: new Date(Date.now() + ROTATION_GRACE_MS),
        rotationGraceIp: ip
    });
}

/**
 * Spend the rotation pass, if there is an unexpired one for this address.
 * Always clears it, so a pass is good for exactly one session.
 */
export async function consumeSessionRotation(userId: string, ip: string | null): Promise<boolean> {
    const row = await prisma.userSecurity.findUnique({
        where: { userId },
        select: { rotationGraceUntil: true, rotationGraceIp: true }
    });
    if (!row?.rotationGraceUntil) return false;
    await prisma.userSecurity.update({
        where: { userId },
        data: { rotationGraceUntil: null, rotationGraceIp: null }
    });
    return row.rotationGraceUntil.getTime() > Date.now() && row.rotationGraceIp === ip;
}

/** Set the quick-unlock PIN after re-verifying the account password. */
export async function setQuickPin(
    auth: Auth,
    userId: string,
    pin: string,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!/^\d{4,6}$/.test(pin)) return { error: "The PIN must be 4 to 6 digits." };
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    await upsertSecurity(userId, { pinHash: await hashSecret(auth, pin), pinUpdatedAt: new Date() });
    return {};
}

/** Remove the quick-unlock PIN. Locked sessions then need the password. */
export async function clearQuickPin(
    auth: Auth,
    userId: string,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    await upsertSecurity(userId, { pinHash: null, pinUpdatedAt: null });
    return {};
}

/**
 * Check a PIN against the stored hash. Returns false when no PIN is set, so a
 * caller can never unlock an account that never armed one. Guess-throttling is
 * the caller's responsibility - a 4-digit secret needs it.
 */
export async function verifyQuickPin(auth: Auth, userId: string, pin: string): Promise<boolean> {
    const row = await prisma.userSecurity.findUnique({ where: { userId }, select: { pinHash: true } });
    if (!row?.pinHash) return false;
    const ctx = await auth.$context;
    return ctx.password.verify({ hash: row.pinHash, password: pin });
}

/** Whether the account password matches - the fallback unlock and the gate on
 *  every setting below. Exported so the lock screen can offer both factors. */
export async function verifyAccountPassword(auth: Auth, userId: string, password: string): Promise<boolean> {
    return verifyPassword(auth, userId, password);
}

// ---------------------------------------------------------------------------
// Recovery questions
// ---------------------------------------------------------------------------

/** Answers are compared case- and spacing-insensitively; people do not retype
 *  an answer exactly the way they first wrote it. */
function normalizeAnswer(answer: string): string {
    return answer.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The questions a user has set, in a stable order. Never returns the answers. */
export async function listSecurityQuestions(userId: string): Promise<Array<{ id: string; question: string }>> {
    return prisma.securityQuestion.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { id: true, question: true }
    });
}

/** Replace the user's recovery questions wholesale, after a password check. */
export async function setSecurityQuestions(
    auth: Auth,
    userId: string,
    currentPassword: string,
    entries: ReadonlyArray<{ question: string; answer: string }>
): Promise<{ error?: string }> {
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const rows = await Promise.all(
        entries.map(async (entry) => ({
            userId,
            question: entry.question.trim(),
            answerHash: await hashSecret(auth, normalizeAnswer(entry.answer))
        }))
    );
    await prisma.$transaction([
        prisma.securityQuestion.deleteMany({ where: { userId } }),
        prisma.securityQuestion.createMany({ data: rows })
    ]);
    return {};
}

/** Drop every recovery question, after a password check. */
export async function clearSecurityQuestions(
    auth: Auth,
    userId: string,
    currentPassword: string
): Promise<{ error?: string }> {
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    await prisma.securityQuestion.deleteMany({ where: { userId } });
    return {};
}

/**
 * Verify answers positionally against the questions as listed. Every answer must
 * match: a partial score proves nothing. Returns false when no questions are
 * set, so an account without this factor can never be recovered through it.
 */
export async function verifySecurityAnswers(
    auth: Auth,
    userId: string,
    answers: readonly string[]
): Promise<boolean> {
    const rows = await prisma.securityQuestion.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { answerHash: true }
    });
    if (rows.length === 0 || rows.length !== answers.length) return false;
    const ctx = await auth.$context;
    let allMatch = true;
    for (const [index, row] of rows.entries()) {
        // Verify every answer rather than short-circuiting, so the time taken
        // does not reveal which answer was the wrong one.
        const match = await ctx.password.verify({
            hash: row.answerHash,
            password: normalizeAnswer(answers[index] ?? "")
        });
        if (!match) allMatch = false;
    }
    return allMatch;
}

/**
 * Write a new password without knowing the old one. The caller MUST have proven
 * identity another way first (recovery questions or a verified authenticator
 * code) - this function performs no check of its own. Every other session is
 * revoked, since a password change is also how a user evicts an intruder.
 */
export async function resetUserPassword(
    auth: Auth,
    userId: string,
    newPassword: string,
    minLength = 10
): Promise<{ error?: string }> {
    if (newPassword.length < minLength) {
        return { error: `New password must be at least ${minLength} characters.` };
    }
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(newPassword);
    await prisma.account.updateMany({ where: { userId, providerId: "credential" }, data: { password: hash } });
    return {};
}

// ---------------------------------------------------------------------------
// Sign-in network rules
// ---------------------------------------------------------------------------

/** Replace the account's own sign-in restrictions and attached access groups. */
export async function updateSignInRules(userId: string, rules: AccessRulesInput): Promise<void> {
    await upsertSecurity(userId, {
        allowedCidrs: stringifyList(rules.allowedCidrs),
        allowedCountries: stringifyList(rules.allowedCountries),
        allowedContinents: stringifyList(rules.allowedContinents)
    });
    // Only the caller's own groups may be attached; a foreign id is dropped
    // rather than rejected, so a stale client cannot bind someone else's rules.
    const owned = await prisma.accessGroup.findMany({
        where: { ownerId: userId, id: { in: rules.groupIds } },
        select: { id: true }
    });
    await prisma.$transaction([
        // Enforced bindings are an administrator's, not this editor's, so they
        // survive a save that never offered them in the first place.
        prisma.userAccessGroup.deleteMany({ where: { userId, enforced: false } }),
        prisma.userAccessGroup.createMany({
            data: owned.map((group) => ({ userId, groupId: group.id })),
            // A group an administrator already enforced stays theirs: the binding
            // is one row, and re-attaching it here would only demote it.
            skipDuplicates: true
        })
    ]);
}

/**
 * Replace the restrictions an administrator imposes on an account. The rules are
 * judged separately from the account's own (a sign-in must satisfy both), so
 * this is the only way to narrow where someone may connect from and the user
 * cannot undo it from their own security page.
 *
 * Groups are resolved against the administrator who is attaching them: an access
 * group belongs to its creator, and a foreign id is dropped rather than
 * rejected, so a stale client cannot bind rules it was never shown.
 */
export async function updateEnforcedRules(
    userId: string,
    imposedBy: string,
    rules: AccessRulesInput
): Promise<void> {
    await upsertSecurity(userId, {
        adminCidrs: stringifyList(rules.allowedCidrs),
        adminCountries: stringifyList(rules.allowedCountries),
        adminContinents: stringifyList(rules.allowedContinents)
    });
    const owned = await prisma.accessGroup.findMany({
        where: { ownerId: imposedBy, id: { in: rules.groupIds } },
        select: { id: true }
    });
    const groupIds = owned.map((group) => group.id);
    await prisma.$transaction([
        // A binding is one row per pair, so a group the user had attached
        // themselves is taken over rather than duplicated - an enforced rule has
        // to outrank whatever the account chose for itself.
        prisma.userAccessGroup.deleteMany({
            where: { userId, OR: [{ enforced: true }, { groupId: { in: groupIds } }] }
        }),
        prisma.userAccessGroup.createMany({
            data: groupIds.map((groupId) => ({ userId, groupId, enforced: true }))
        })
    ]);
}

/** The restrictions an administrator has imposed, as their editor shows them. */
export async function getEnforcedRules(userId: string): Promise<AccessRulesInput> {
    const [row, bindings] = await Promise.all([
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { adminCidrs: true, adminCountries: true, adminContinents: true }
        }),
        prisma.userAccessGroup.findMany({ where: { userId, enforced: true }, select: { groupId: true } })
    ]);
    return {
        groupIds: bindings.map((binding) => binding.groupId),
        allowedCidrs: parseStringList(row?.adminCidrs),
        allowedCountries: parseStringList(row?.adminCountries),
        allowedContinents: parseStringList(row?.adminContinents)
    };
}
