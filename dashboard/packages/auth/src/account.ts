/**
 * Account self-service. Lets a signed-in user change their own profile, the
 * addresses on the account, and their password. Credential checks and hashing go
 * through better-auth's context - the same hasher sign-in verifies against - so
 * there is one source of truth for how passwords are stored. Changing what signs
 * in (the primary address) and the password both re-verify the current password
 * first; profile edits (name, username, company) do not touch credentials.
 */

import { prisma } from "@polaris/db";
import type { Auth } from "./auth.js";
import {
    companyField,
    descriptionField,
    displayNameField,
    nameHalfField,
    isReservedUsername,
    usernameChangeRefusal,
    RESERVED_USERNAME_MESSAGE,
    USERNAME_COOLDOWN_DAYS
} from "@polaris/core";

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
 * Update a user's own profile: what they are called on screen, the name behind
 * it, their handle, their company and what they say about themselves.
 *
 * The display name and the two halves of a name are treated differently on
 * purpose. A name is recorded, so it is written the way a name is written
 * wherever it was typed - a phone capitalizes sentences and not words, and
 * "rahma" typed on one should not be stored differently from the same name typed
 * on a laptop. A display name is chosen, so it is left exactly as it was typed:
 * somebody who writes their name in lower case meant to.
 *
 * Username must stay unique; everything else is free text and may be cleared.
 *
 * It also costs a wait. A handle is how other people find and address somebody,
 * so an account cannot cycle through them: the previous change is remembered and
 * a new one is refused until the operator's cooldown has passed. Enforced here
 * rather than in the action that calls it, because this is the copy that decides
 * what is stored - the same reason the display name is re-checked below.
 *
 * `cooldownDays` is passed in because the operator's setting lives in the
 * dashboard's own store and this package deliberately does not read it. Omitted,
 * the default applies, so a caller that forgets gets the rule rather than no rule.
 */
export async function updateUserProfile(
    userId: string,
    input: {
        name?: string;
        firstName?: string | null;
        lastName?: string | null;
        username?: string | null;
        company?: string | null;
        description?: string | null;
    },
    options?: { cooldownDays?: number; now?: Date }
): Promise<{ error?: string }> {
    const data: {
        name?: string;
        firstName?: string | null;
        lastName?: string | null;
        username?: string | null;
        usernameChangedAt?: Date;
        company?: string | null;
        description?: string;
    } = {};
    if (input.name !== undefined) {
        // Checked here rather than only in the form: this is the copy that
        // decides what is stored, and an API key posting a name never sees a blur.
        const parsed = displayNameField.safeParse(input.name);
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the display name." };
        data.name = parsed.data;
    }
    for (const half of ["firstName", "lastName"] as const) {
        const value = input[half];
        if (value === undefined) continue;
        const parsed = nameHalfField.safeParse(value ?? "");
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the name." };
        // Null rather than empty: an unset half of a name is a column with
        // nothing in it, and "" would make an account that cleared it look
        // different from every account that never had one.
        data[half] = parsed.data || null;
    }
    if (input.username !== undefined) {
        const username = input.username?.trim().toLowerCase() || null;
        const held = await prisma.user.findUnique({
            where: { id: userId },
            select: { username: true, usernameChangedAt: true }
        });
        // Compared the way a username is matched, so retyping the same handle in
        // different capitals is not a change and never costs anybody a wait.
        const changing = username !== (held?.username ?? null);
        if (changing) {
            const now = options?.now ?? new Date();
            const refusal = usernameChangeRefusal(
                held?.usernameChangedAt ?? null,
                now,
                options?.cooldownDays ?? USERNAME_COOLDOWN_DAYS
            );
            if (refusal) return { error: refusal };
            if (username) {
                if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
                    return { error: "Username must be 3-32 characters: letters, numbers, . _ -" };
                }
                // A handle addresses a public page and is printed beside
                // everything somebody writes, which is what makes a few of them
                // dangerous rather than confusing - see `usernames.ts`. Checked
                // here as well as in the form, because the form is a courtesy.
                if (isReservedUsername(username)) return { error: RESERVED_USERNAME_MESSAGE };
                const taken = await prisma.user.findFirst({
                    where: { username, id: { not: userId } },
                    select: { id: true }
                });
                if (taken) return { error: "That username is already taken." };
            }
            data.username = username;
            // Clearing a handle starts the clock too. Otherwise clear-then-set
            // would be two changes for the price of none, which is the whole
            // thing this is here to stop.
            data.usernameChangedAt = now;
        }
    }
    if (input.company !== undefined) {
        const parsed = companyField.safeParse(input.company ?? "");
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the company." };
        data.company = parsed.data || null;
    }
    if (input.description !== undefined) {
        const parsed = descriptionField.safeParse(input.description ?? "");
        if (!parsed.success) {
            return { error: parsed.error.issues[0]?.message ?? "Check the description." };
        }
        // Empty rather than null: it is a line somebody may have cleared, and
        // the column has no meaning for "unset" that "" does not already carry.
        data.description = parsed.data;
    }
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: userId }, data });
    return {};
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A user's addresses. The primary is the one they sign in with and cannot be
 * removed; the rest are alternates, each of which may be flagged as a recovery
 * contact. An address is only ever claimed by one account, so every addition is
 * checked against both the primary addresses and the alternates.
 */
export interface UserEmailView {
    /** Null for the primary, which lives on the user row rather than its own. */
    id: string | null;
    email: string;
    primary: boolean;
    recovery: boolean;
    /** Whether the owner has proved they can read mail at this address. */
    verified: boolean;
    addedAt: string | null;
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Which account holds an address, as a primary or an alternate, or null when
 * nobody does.
 *
 * One question asked in one place, because an address is claimed by exactly one
 * account and every path that would create or move one has to respect that -
 * including provisioning, which is how an invited account is created and which
 * would otherwise happily take an address somebody else has already proved.
 */
export async function emailOwner(email: string): Promise<string | null> {
    const address = normalizeEmail(email);
    const [asPrimary, asAlternate] = await Promise.all([
        prisma.user.findFirst({ where: { email: address }, select: { id: true } }),
        prisma.userEmail.findFirst({ where: { email: address }, select: { userId: true } })
    ]);
    return asPrimary?.id ?? asAlternate?.userId ?? null;
}

/** Every address a user holds, primary first. */
export async function listUserEmails(userId: string): Promise<UserEmailView[]> {
    const [user, alternates] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { id: true, email: true, recovery: true, verifiedAt: true, createdAt: true }
        })
    ]);
    // The primary's verified flag lives on the user row, which better-auth owns;
    // the alternates keep their own stamp.
    const primary: UserEmailView[] = user
        ? [
              {
                  id: null,
                  email: user.email,
                  primary: true,
                  recovery: false,
                  verified: user.emailVerified,
                  addedAt: null
              }
          ]
        : [];
    return [
        ...primary,
        ...alternates.map((row) => ({
            id: row.id,
            email: row.email,
            primary: false,
            recovery: row.recovery,
            verified: row.verifiedAt !== null,
            addedAt: row.createdAt.toISOString()
        }))
    ];
}

/** How many alternates one account may hold, so the list cannot be used as storage. */
export const MAX_ALTERNATE_EMAILS = 10;

/** Add an alternate address. Refused if anybody already holds it. */
export async function addUserEmail(userId: string, newEmail: string): Promise<{ error?: string }> {
    const email = normalizeEmail(newEmail);
    if (!isEmail(email)) return { error: "Enter a valid email address." };
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (current?.email === email) return { error: "That is already your primary address." };
    // Anybody's, including this account's own alternates: the column is unique
    // across the table, so an address the caller already holds is refused with a
    // message rather than as a constraint violation on the way to the database.
    if (await emailOwner(email)) return { error: "That email is already in use." };
    const held = await prisma.userEmail.count({ where: { userId } });
    if (held >= MAX_ALTERNATE_EMAILS) {
        return { error: `You can hold at most ${MAX_ALTERNATE_EMAILS} extra addresses.` };
    }
    await prisma.userEmail.create({ data: { userId, email } });
    return {};
}

/**
 * Record an address an outside provider has just handed over as one of this
 * account's own.
 *
 * Recording it is what reserves it, and that happens whatever anybody thinks of
 * the provider: an address one account holds is one no other account can be
 * created with, so somebody who signs in with their work Google cannot later be
 * shadowed by a second Polaris account under the same address.
 *
 * Whether it also arrives confirmed is `verified`, and it is the caller's call
 * rather than this function's - it turns on which service vouched and what the
 * deployment has decided that service's word is worth, neither of which is
 * knowable here. When it is true the provider is saying the same thing a
 * confirmation link says: this person reads mail at that address. When it is
 * false the address is still held, and its owner proves it the ordinary way.
 *
 * An address that is already the one they sign in with is confirmed in place. It
 * is the same address and the same proof; leaving the primary alone would have
 * the account showing "unverified" next to an address a provider had just
 * vouched for, with a Verify button that sends mail nobody needed to read.
 *
 * Every way this can fail is a reason to leave things exactly as they are, never
 * to fail the link that triggered it: an address somebody else already holds
 * stays theirs, and an account already at its limit simply does not collect
 * another. The caller treats the reason as a note, not an error.
 */
export async function adoptProviderEmail(
    userId: string,
    newEmail: string,
    options: { verified: boolean }
): Promise<{ error?: string }> {
    const email = normalizeEmail(newEmail);
    if (!isEmail(email)) return { error: "That is not an address Polaris can hold." };

    const owner = await emailOwner(email);
    if (owner === userId) {
        if (!options.verified) return {};
        // Whichever of the two this address is. Both are narrowed to the
        // unconfirmed case, so an address that was already proved keeps the
        // stamp it earned rather than being re-dated by every re-authorization.
        await Promise.all([
            prisma.user.updateMany({
                where: { id: userId, email, emailVerified: false },
                data: { emailVerified: true }
            }),
            prisma.userEmail.updateMany({
                where: { userId, email, verifiedAt: null },
                data: { verifiedAt: new Date() }
            })
        ]);
        return {};
    }
    if (owner) return { error: "That address is already on another account." };

    const held = await prisma.userEmail.count({ where: { userId } });
    if (held >= MAX_ALTERNATE_EMAILS) {
        return { error: `That account already holds ${MAX_ALTERNATE_EMAILS} extra addresses.` };
    }
    await prisma.userEmail.create({
        data: { userId, email, verifiedAt: options.verified ? new Date() : null }
    });
    return {};
}

/** Drop one of a user's own alternate addresses. */
export async function removeUserEmail(userId: string, emailId: string): Promise<{ error?: string }> {
    const result = await prisma.userEmail.deleteMany({ where: { id: emailId, userId } });
    return result.count > 0 ? {} : { error: "That address is no longer on your account." };
}

/** Flag or unflag one of a user's own alternates as a recovery contact. */
export async function setUserEmailRecovery(
    userId: string,
    emailId: string,
    recovery: boolean
): Promise<{ error?: string }> {
    const result = await prisma.userEmail.updateMany({ where: { id: emailId, userId }, data: { recovery } });
    return result.count > 0 ? {} : { error: "That address is no longer on your account." };
}

/**
 * Promote an alternate to primary, which is what a user signs in with - so it
 * re-verifies the password like any other email change. The outgoing primary is
 * kept as an alternate rather than dropped: losing it silently would strip an
 * address the account still owns.
 */
export async function promoteUserEmail(
    auth: Auth,
    userId: string,
    emailId: string,
    currentPassword: string
): Promise<{ error?: string }> {
    const [user, alternate] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findFirst({
            where: { id: emailId, userId },
            select: { id: true, email: true, verifiedAt: true }
        })
    ]);
    if (!user || !alternate) return { error: "That address is no longer on your account." };
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    // Both addresses keep whatever they had proved: verification says the owner
    // can read mail there, which does not stop being true because the address
    // swapped places with the one that signs in.
    await prisma.$transaction([
        prisma.userEmail.delete({ where: { id: alternate.id } }),
        prisma.user.update({
            where: { id: userId },
            data: { email: alternate.email, emailVerified: alternate.verifiedAt !== null }
        }),
        prisma.userEmail.create({
            data: {
                userId,
                email: user.email,
                verifiedAt: user.emailVerified ? new Date() : null
            }
        })
    ]);
    return {};
}

/** Change a user's own password after re-verifying the current one. */
export async function changeUserPassword(
    auth: Auth,
    userId: string,
    currentPassword: string,
    newPassword: string,
    minLength = 10
): Promise<{ error?: string }> {
    if (newPassword.length < minLength) {
        return { error: `New password must be at least ${minLength} characters.` };
    }
    if (!(await verifyPassword(auth, userId, currentPassword))) {
        return { error: "Current password is incorrect." };
    }
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(newPassword);
    await prisma.account.updateMany({
        where: { userId, providerId: "credential" },
        data: { password: hash }
    });
    return {};
}
