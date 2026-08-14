/**
 * Snippets: text handed out by link, and the drop point that asks for it.
 *
 * A snippet is one or more named files of text with a language on each. It is
 * shared with the same guardrails a Drive share carries - password, expiry, a
 * view cap, address rules - because it is the same act with different content,
 * and somebody who has learned one should not have to learn the other.
 *
 * Every limit here is a security control: a snippet is often exactly the thing
 * that should not be readable for longer than it has to be.
 */

import { z } from "zod";
import { accountIdentityList, addressRuleFields, addressRuleUpdateFields } from "./link-rules.js";

/** Who can open a snippet. */
export const SNIPPET_VISIBILITIES = ["private", "link", "invite"] as const;
export type SnippetVisibility = (typeof SNIPPET_VISIBILITIES)[number];

/** Files in one snippet. Past a handful it is a repository, not a paste. */
export const MAX_SNIPPET_FILES = 20;

/** Characters in one file. Large enough for a real config or a stack trace,
 *  small enough that the row stays cheap to read and highlight. */
export const MAX_SNIPPET_FILE_CHARS = 512_000;

/** Characters across every file in one snippet. */
export const MAX_SNIPPET_TOTAL_CHARS = 1_000_000;

export const MAX_SNIPPET_TITLE = 200;
export const MAX_SNIPPET_DESCRIPTION = 2000;
export const MAX_SNIPPET_FILE_NAME = 120;

/**
 * A file name inside a snippet. It is shown, downloaded and used to guess a
 * language, never resolved against a filesystem - so the separators are stripped
 * rather than rejected: a person who pastes `src/app/page.tsx` means the name,
 * and refusing it would be pedantry, while keeping it would put a path where
 * something later may treat it as one.
 */
export const snippetFileName = z
    .string()
    .trim()
    .max(MAX_SNIPPET_FILE_NAME)
    .transform((value) =>
        value
            .replace(/[\\/]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    )
    .refine((value) => value.length > 0, { message: "A file needs a name" });

export const snippetFileSchema = z.object({
    name: snippetFileName,
    /** The highlight.js token, or "" to leave it as plain text. */
    language: z
        .string()
        .trim()
        .toLowerCase()
        .max(32)
        .regex(/^[a-z0-9+#-]*$/, "Unknown language")
        .default(""),
    body: z.string().max(MAX_SNIPPET_FILE_CHARS)
});

export type SnippetFileInput = z.infer<typeof snippetFileSchema>;

/** The files of a snippet, with the total size enforced across all of them. */
const snippetFiles = z
    .array(snippetFileSchema)
    .min(1, "A snippet needs at least one file")
    .max(MAX_SNIPPET_FILES)
    .refine(
        (files) =>
            files.reduce((total, file) => total + file.body.length, 0) <= MAX_SNIPPET_TOTAL_CHARS,
        { message: "This snippet is too large" }
    );

/** The link guardrails a snippet shares with a Drive share. */
const snippetLinkFields = {
    /** Optional link password. Stored stretched, never in the clear. */
    password: z.string().min(1).max(256).optional(),
    /** Stop serving after this many views. Undefined means unlimited. */
    maxViews: z.number().int().positive().optional(),
    /** ISO timestamp after which the link stops working. */
    expiresAt: z.coerce.date().optional(),
    /**
     * Wipe the stored text the first time it is served. Implies a single view,
     * and unlike a view cap it leaves nothing behind in a later backup.
     */
    burnAfterRead: z.boolean().default(false),
    ...addressRuleFields
} as const;

export const createSnippetSchema = z
    .object({
        title: z.string().trim().max(MAX_SNIPPET_TITLE).optional(),
        description: z.string().trim().max(MAX_SNIPPET_DESCRIPTION).optional(),
        visibility: z.enum(SNIPPET_VISIBILITIES).default("private"),
        files: snippetFiles,
        /**
         * Set when the browser already sealed every body under a key that will
         * ride in the URL fragment. Polaris then stores ciphertext it cannot read.
         */
        clientSealed: z.boolean().default(false),
        /**
         * For an invite snippet: who may open it, named the way people name each
         * other - a username or an address, not an id. The server resolves them
         * to accounts and refuses the ones it cannot place.
         */
        inviteUsers: accountIdentityList.default([]),
        ...snippetLinkFields
    })
    .refine((value) => value.visibility !== "invite" || value.inviteUsers.length > 0, {
        message: "Pick at least one person to share it with",
        path: ["inviteUsers"]
    })
    // A sealed snippet the server could preview would defeat the point, and a
    // language on it would be a lie: the server holds bytes it cannot read.
    .refine((value) => !value.clientSealed || value.files.every((file) => file.language === ""), {
        message: "A sealed snippet carries no language",
        path: ["files"]
    });

export type CreateSnippetInput = z.infer<typeof createSnippetSchema>;

export const updateSnippetSchema = z.object({
    title: z.string().trim().max(MAX_SNIPPET_TITLE).optional(),
    description: z.string().trim().max(MAX_SNIPPET_DESCRIPTION).nullable().optional(),
    files: snippetFiles.optional()
});

export type UpdateSnippetInput = z.infer<typeof updateSnippetSchema>;

/**
 * Change how a snippet is shared. Every field is optional so a dialog can send
 * only what moved; `null` clears a limit, which `undefined` must not do.
 */
export const shareSnippetSchema = z.object({
    visibility: z.enum(SNIPPET_VISIBILITIES).optional(),
    password: z.string().min(1).max(256).nullable().optional(),
    maxViews: z.number().int().positive().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    burnAfterRead: z.boolean().optional(),
    inviteUsers: accountIdentityList.optional(),
    ...addressRuleUpdateFields
});

export type ShareSnippetInput = z.infer<typeof shareSnippetSchema>;

/** Characters one drop point will accept in a single submission, by default. */
export const DEFAULT_TEXT_REQUEST_MAX_LENGTH = 100_000;

export const createTextRequestSchema = z.object({
    title: z.string().trim().max(MAX_SNIPPET_TITLE).optional(),
    instructions: z.string().trim().max(MAX_SNIPPET_DESCRIPTION).optional(),
    /** When false, anyone with the link may send without an account. */
    requireLogin: z.boolean().default(false),
    password: z.string().min(1).max(256).optional(),
    maxLength: z
        .number()
        .int()
        .positive()
        .max(MAX_SNIPPET_FILE_CHARS)
        .default(DEFAULT_TEXT_REQUEST_MAX_LENGTH),
    maxSubmissions: z.number().int().positive().optional(),
    /**
     * Offer the sender the option to seal what they send in their own browser.
     * Off by default, because then the owner cannot read it in Polaris either -
     * they need the key the sender gives them separately.
     */
    allowSealed: z.boolean().default(false),
    /**
     * Allowlist of sender identities (email or username), lowercased with any
     * leading "@" removed. Non-empty implies sign-in is required.
     */
    allowedUsers: accountIdentityList.default([]),
    startsAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    ...addressRuleFields
});

export type CreateTextRequestInput = z.infer<typeof createTextRequestSchema>;

export const updateTextRequestSchema = z.object({
    title: z.string().trim().max(MAX_SNIPPET_TITLE).optional(),
    instructions: z.string().trim().max(MAX_SNIPPET_DESCRIPTION).nullable().optional(),
    requireLogin: z.boolean().optional(),
    password: z.string().min(1).max(256).nullable().optional(),
    maxLength: z.number().int().positive().max(MAX_SNIPPET_FILE_CHARS).optional(),
    maxSubmissions: z.number().int().positive().nullable().optional(),
    allowSealed: z.boolean().optional(),
    allowedUsers: z.array(z.string().trim().toLowerCase()).optional(),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    ...addressRuleUpdateFields
});

export type UpdateTextRequestInput = z.infer<typeof updateTextRequestSchema>;

/** What a sender submits to a text drop point. Re-validated server-side against
 *  the drop point's own maxLength, which is the limit that actually binds. */
export const submitTextSchema = z.object({
    title: z.string().trim().max(MAX_SNIPPET_TITLE).optional(),
    name: snippetFileName,
    body: z.string().min(1, "There is nothing to send").max(MAX_SNIPPET_FILE_CHARS),
    /** Set when the sender sealed the body in their own browser. */
    sealed: z.boolean().default(false)
});

export type SubmitTextInput = z.infer<typeof submitTextSchema>;
