/**
 * Auth form schemas, shared so the client validates in real time against exactly
 * what the server actions enforce. Registration is closed: accounts come from the
 * one-time admin setup (guarded by a setup token) or an admin invite.
 */

import { z } from "zod";
import { pendingGrantSchema } from "./sharing.js";
import { accessRulesSchema } from "./account-security.js";
import { MAX_ROLE_NAME_LENGTH, PERMISSIONS } from "../permissions.js";

export const emailField = z.string().trim().min(1, "Email is required").email("Enter a valid email");
export const nameField = z.string().trim().min(1, "Name is required").max(120);
export const usernameField = z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "At least 3 characters")
    .max(30, "At most 30 characters")
    .regex(/^[a-z0-9_-]+$/, "Use letters, numbers, - or _");
export const passwordField = z
    .string()
    .min(10, "Use at least 10 characters")
    .max(256, "Too long");
/** Long enough for a legal name, short enough that the field stays a label. */
export const MAX_COMPANY_LENGTH = 80;
export const companyField = z.string().trim().max(MAX_COMPANY_LENGTH, `At most ${MAX_COMPANY_LENGTH} characters`);

export const loginSchema = z.object({
    // Email or username.
    identifier: z.string().trim().min(1, "Email or username is required"),
    password: z.string().min(1, "Password is required")
});

export const setupSchema = z.object({
    name: nameField,
    username: usernameField,
    email: emailField,
    password: passwordField,
    token: z.string().trim().min(1, "Setup token is required")
});

export const acceptInviteSchema = z.object({
    name: nameField,
    username: usernameField,
    password: passwordField
});

/**
 * The role an invite hands out. Roles are rows an operator can add to, so this
 * is a name rather than a closed list; that the name exists is settled against
 * the database when the invite is created, not by the shape of the form.
 */
export const roleNameField = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Pick a role")
    .max(MAX_ROLE_NAME_LENGTH, `At most ${MAX_ROLE_NAME_LENGTH} characters`)
    .regex(/^[a-z0-9 _-]+$/, "Use letters, numbers, spaces, - or _");

/**
 * How an invite travels and what its recipient presents to claim it:
 *   link  - the administrator hands the URL over themselves.
 *   magic - Polaris emails the URL to the address being invited.
 *   code  - a short code, typed on the join page instead of following a link.
 */
export const INVITE_METHODS = ["link", "magic", "code"] as const;
export type InviteMethod = (typeof INVITE_METHODS)[number];

/** Characters an invitation code is made of, and how it is grouped when shown.
 *  The alphabet excludes 0/O/1/I/L, so a code read out loud survives the trip. */
export const INVITE_CODE_LENGTH = 12;
const INVITE_CODE_GROUP = 4;

/** Strip a typed code back to its characters: case, spaces and dashes are how
 *  people write it down, not part of what they were given. */
export function normalizeInviteCode(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The grouped form shown to whoever has to read or retype it. */
export function formatInviteCode(code: string): string {
    const normalized = normalizeInviteCode(code);
    const groups: string[] = [];
    for (let at = 0; at < normalized.length; at += INVITE_CODE_GROUP) {
        groups.push(normalized.slice(at, at + INVITE_CODE_GROUP));
    }
    return groups.join("-");
}

export const inviteCodeField = z
    .string()
    .trim()
    .min(1, "Enter your invitation code")
    .transform(normalizeInviteCode)
    .refine((value) => value.length === INVITE_CODE_LENGTH, "That code is not the right length");

/** A one-time password an invite may carry, communicated out of band. Short by
 *  design - it is single-use, rate-limited, and only ever a second factor on a
 *  token that is already unguessable. */
export const inviteOneTimePasswordField = z
    .string()
    .trim()
    .min(6, "Use at least 6 characters")
    .max(256, "Too long");

/**
 * Creating an invite. The access rules are the invitee's future limits and the
 * bounds on the claim itself: the same allowlist decides where the invite may be
 * accepted from and where the account may sign in from afterwards.
 */
export const createInviteSchema = accessRulesSchema.extend({
    email: emailField,
    role: roleNameField.default("member"),
    method: z.enum(INVITE_METHODS).default("link"),
    oneTimePassword: inviteOneTimePasswordField.optional(),
    /** Sent by somebody who is not an administrator, under the sharing policy. */
    delegated: z.boolean().default(false),
    /** The access it promises on one thing, applied when it is claimed. */
    pendingGrant: pendingGrantSchema.optional()
});

/** A role's grants, as the roles editor saves them. The wildcard is not offered:
 *  it belongs to the one role that is not editable. */
export const roleGrantsSchema = z.object({
    permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)
});

export const createRoleSchema = roleGrantsSchema.extend({ name: roleNameField });

/**
 * Why an invite cannot be claimed, and what the join page says about it. Every
 * reason is something the recipient can act on: ask for a new invite, or come
 * back from somewhere the invite allows. Which one they are told is deliberately
 * coarse - an invite that never existed and one already claimed read alike, so
 * a stranger holding a token learns nothing from the difference.
 */
export const INVITE_REFUSALS = {
    unavailable: "This invite is invalid, expired, or already used. Ask an administrator for a new one.",
    location: "This invite cannot be accepted from your network. Ask whoever sent it which addresses it allows.",
    password: "That one-time password did not match.",
    throttled: "Too many attempts from your network. Wait a few minutes and try again."
} as const;

export type InviteRefusal = keyof typeof INVITE_REFUSALS;

/** Claiming an invite: who is joining, and what proves they may. */
export const claimInviteSchema = acceptInviteSchema.extend({
    token: z.string().trim().default(""),
    code: z.string().trim().default(""),
    oneTimePassword: z.string().trim().default("")
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type ClaimInviteInput = z.infer<typeof claimInviteSchema>;
