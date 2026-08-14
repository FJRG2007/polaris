/**
 * What the vault will accept from a client.
 *
 * Everything valuable in a vault request is opaque - the server cannot read a
 * password, so it cannot check one - which makes it tempting to store whatever
 * arrives. That would be wrong twice over: a client with a bug would write junk
 * that no client can read back, and an endpoint that stores arbitrary JSON is an
 * endpoint somebody can put arbitrary JSON through.
 *
 * So the shape is validated even though the contents cannot be: every leaf that
 * should be encrypted has to LOOK encrypted, every number has to be one of the
 * values clients actually send, and anything unrecognized is dropped rather than
 * persisted.
 */

import { z } from "zod";
import { CIPHER_TYPES, isEncString, SEND_TEXT, SEND_FILE } from "../vault.js";

/**
 * A value that has already been encrypted by a client.
 *
 * The check is structural - a leading type number and base64 pieces - which is
 * all that can be checked without a key. It is still worth doing: a client
 * sending a plaintext password to a field that should be encrypted is a bug that
 * otherwise reaches the database and looks like data.
 */
export const encString = z.string().refine(isEncString, { message: "Must be an encrypted value" });

/** An encrypted value that may be absent. */
const optionalEncString = encString.nullish();

/** A custom field on an item. Its value is encrypted; its type is not. */
const cipherField = z.object({
    type: z.number().int().min(0).max(3),
    name: optionalEncString,
    value: optionalEncString,
    linkedId: z.number().int().nullish()
});

/** One address a login is offered on. */
const loginUri = z.object({
    uri: optionalEncString,
    // Absent means "whatever the account's default match is".
    match: z.number().int().min(0).max(5).nullish(),
    uriChecksum: optionalEncString
});

const loginData = z.object({
    username: optionalEncString,
    password: optionalEncString,
    passwordRevisionDate: z.coerce.date().nullish(),
    totp: optionalEncString,
    uris: z.array(loginUri).nullish(),
    fido2Credentials: z.array(z.record(z.unknown())).nullish(),
    autofillOnPageLoad: z.boolean().nullish()
});

const cardData = z.object({
    cardholderName: optionalEncString,
    brand: optionalEncString,
    number: optionalEncString,
    expMonth: optionalEncString,
    expYear: optionalEncString,
    code: optionalEncString
});

const identityData = z.object({
    title: optionalEncString,
    firstName: optionalEncString,
    middleName: optionalEncString,
    lastName: optionalEncString,
    address1: optionalEncString,
    address2: optionalEncString,
    address3: optionalEncString,
    city: optionalEncString,
    state: optionalEncString,
    postalCode: optionalEncString,
    country: optionalEncString,
    company: optionalEncString,
    email: optionalEncString,
    phone: optionalEncString,
    ssn: optionalEncString,
    username: optionalEncString,
    passportNumber: optionalEncString,
    licenseNumber: optionalEncString
});

const secureNoteData = z.object({ type: z.number().int().min(0).max(1).default(0) });

const sshKeyData = z.object({
    privateKey: optionalEncString,
    publicKey: optionalEncString,
    keyFingerprint: optionalEncString
});

/** A password a client kept after it was replaced. */
const passwordHistoryEntry = z.object({
    password: encString,
    lastUsedDate: z.coerce.date().nullish()
});

/**
 * One vault item, as a client sends it.
 *
 * Not a discriminated union on `type`: clients send the sub-object matching the
 * type and sometimes leave the others as nulls, and refusing that would break
 * them for no gain. The type decides how it is DRAWN, and nothing here reads the
 * contents anyway.
 */
export const cipherSchema = z.object({
    type: z
        .number()
        .int()
        .refine((value) => CIPHER_TYPES.includes(value as never), {
            message: "Unknown item type"
        }),
    organizationId: z.string().uuid().nullish(),
    folderId: z.string().uuid().nullish(),
    name: encString,
    notes: optionalEncString,
    favorite: z.boolean().nullish(),
    reprompt: z.number().int().min(0).max(1).nullish(),
    fields: z.array(cipherField).nullish(),
    passwordHistory: z.array(passwordHistoryEntry).nullish(),
    login: loginData.nullish(),
    card: cardData.nullish(),
    identity: identityData.nullish(),
    secureNote: secureNoteData.nullish(),
    sshKey: sshKeyData.nullish(),
    /**
     * What the client believed the item's revision was.
     *
     * Sent so a save from a client that had gone stale can be refused instead of
     * quietly overwriting somebody else's edit. Optional, because not every
     * client sends it.
     */
    lastKnownRevisionDate: z.coerce.date().nullish()
});

export type CipherInput = z.infer<typeof cipherSchema>;

/** Creating an item straight into an organization, with the collections it goes in. */
export const cipherCreateSchema = z.object({
    cipher: cipherSchema,
    collectionIds: z.array(z.string().uuid()).default([])
});

/** Moving an item into an organization: it is re-encrypted client-side first. */
export const cipherShareSchema = z.object({
    cipher: cipherSchema,
    collectionIds: z.array(z.string().uuid()).min(1)
});

/** A vault folder. Named `vaultFolderSchema` because Tasks already owns
 *  `folderSchema` and one barrel exports both. */
export const vaultFolderSchema = z.object({ name: encString });

export const collectionSchema = z.object({
    name: encString,
    externalId: z.string().max(300).nullish(),
    groups: z.array(z.record(z.unknown())).nullish(),
    users: z
        .array(
            z.object({
                id: z.string().uuid(),
                readOnly: z.boolean().default(false),
                hidePasswords: z.boolean().default(false)
            })
        )
        .nullish()
});

/**
 * A partial edit: the two things a client changes without re-encrypting.
 *
 * Filing an item and starring it are the only writes that touch nothing
 * encrypted, and clients send them on their own endpoint precisely so a browser
 * extension can do them without holding the whole item. Accepting the full item
 * schema here instead would make the extension re-upload a login to move it.
 */
export const cipherPartialSchema = z.object({
    folderId: z.string().uuid().nullish(),
    favorite: z.boolean().nullish()
});

/** Which of an organization's collections an item belongs to. */
export const cipherCollectionsSchema = z.object({
    collectionIds: z.array(z.string().uuid()).default([])
});

/**
 * A whole vault arriving from a client's own import screen.
 *
 * `folderRelationships` is Bitwarden's way of saying which item goes in which
 * folder without ids that do not exist yet: both arrays are positional, and each
 * relationship pairs an index in one with an index in the other.
 *
 * The caps are what keeps one request from becoming an unbounded write. They sit
 * far above any real vault; somebody past them splits the file.
 */
export const VAULT_IMPORT_MAX_FOLDERS = 500;
export const VAULT_IMPORT_MAX_CIPHERS = 10_000;

export const vaultImportSchema = z.object({
    folders: z.array(vaultFolderSchema).max(VAULT_IMPORT_MAX_FOLDERS).default([]),
    ciphers: z.array(cipherSchema).max(VAULT_IMPORT_MAX_CIPHERS).default([]),
    folderRelationships: z
        .array(
            z.object({ key: z.number().int().nonnegative(), value: z.number().int().nonnegative() })
        )
        .max(VAULT_IMPORT_MAX_CIPHERS)
        .default([])
});

export type VaultImportInput = z.infer<typeof vaultImportSchema>;

/** Items being moved between folders, or emptied out of the trash. */
export const cipherIdsSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });

/** A bulk move. The destination rides in the body beside the items, and a null
 *  or absent folder is "no folder" rather than a missing field. */
export const cipherMoveSchema = cipherIdsSchema.extend({
    folderId: z.string().uuid().nullish()
});

/** A Send: something handed to somebody outside the vault. */
export const sendSchema = z.object({
    type: z
        .number()
        .int()
        .refine((value) => value === SEND_TEXT || value === SEND_FILE, {
            message: "Unknown send type"
        }),
    name: encString,
    notes: optionalEncString,
    /** The Send's own key, wrapped under the user's vault key. */
    key: encString,
    text: z.object({ text: optionalEncString, hidden: z.boolean().default(false) }).nullish(),
    file: z.object({ fileName: optionalEncString, size: z.coerce.number().nullish() }).nullish(),
    /** The client stretches a link password and sends the result, never the word. */
    password: z.string().max(512).nullish(),
    maxAccessCount: z.number().int().positive().nullish(),
    expirationDate: z.coerce.date().nullish(),
    deletionDate: z.coerce.date(),
    disabled: z.boolean().default(false),
    hideEmail: z.boolean().default(false)
});

export type SendInput = z.infer<typeof sendSchema>;

/** What a client says about itself when it signs in. */
export const deviceSchema = z.object({
    identifier: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    type: z.coerce.number().int().min(0).max(100),
    pushToken: z.string().max(2000).nullish()
});

/**
 * A key pair a browser minted. The public half is plain - it is what somebody
 * else's key gets wrapped to - and the private half arrives already wrapped.
 */
const keyPair = z.object({ publicKey: z.string().min(1), encryptedPrivateKey: encString });

/** Setting up a vault: the keys a browser minted, and how it derives them. */
export const vaultRegisterSchema = z.object({
    masterPasswordHash: z.string().min(1).max(512),
    masterPasswordHint: z.string().max(500).nullish(),
    key: encString,
    keys: keyPair,
    kdf: z.number().int().min(0).max(1),
    kdfIterations: z.number().int().positive(),
    kdfMemory: z.number().int().positive().nullish(),
    kdfParallelism: z.number().int().positive().nullish()
});

/** Changing the master password: the new wrapping, and proof of the old one. */
export const vaultPasswordSchema = z.object({
    masterPasswordHash: z.string().min(1).max(512),
    newMasterPasswordHash: z.string().min(1).max(512),
    masterPasswordHint: z.string().max(500).nullish(),
    key: encString,
    kdf: z.number().int().min(0).max(1).optional(),
    kdfIterations: z.number().int().positive().optional(),
    kdfMemory: z.number().int().positive().nullish(),
    kdfParallelism: z.number().int().positive().nullish()
});

/** Proving the master password again, for a screen that asks a second time. */
export const vaultVerifySchema = z.object({
    masterPasswordHash: z.string().min(1).max(512)
});

/** An organization's vault being created: the keys somebody minted for it. */
export const vaultOrganizationSchema = z.object({
    /** The Polaris organization this belongs to. */
    organizationId: z.string().uuid(),
    /** The organization's key, wrapped to the creator's own public key. */
    key: encString,
    keys: keyPair,
    collectionName: encString
});

/** Long enough to name a vault, short enough to stay a label in a picker. */
export const VAULT_NAME_MAX = 60;

/**
 * What a vault is called.
 *
 * Only a vault of somebody's own has one - an organization's takes the
 * organization's name - and unlike everything else in a vault it is stored in
 * the clear, because clients read it off the profile to label the vault.
 */
export const vaultNameField = z
    .string()
    .trim()
    .min(1, "Give it a name")
    .max(VAULT_NAME_MAX, `At most ${VAULT_NAME_MAX} characters`);

/** A second vault of somebody's own being created, with the keys for it. */
export const personalVaultSchema = z.object({
    name: vaultNameField,
    /** The vault's key, wrapped to the creator's own public key. */
    key: encString,
    keys: keyPair,
    collectionName: encString
});

/**
 * What one member of a vault reaches.
 *
 * Either the whole vault, or the collections named here and nothing else. The
 * two are not combined: `accessAll` already reaches every collection, so rows
 * beside it would be dead weight that outlives the day somebody takes it away.
 */
export const vaultScopeSchema = z.object({
    accessAll: z.boolean(),
    collections: z
        .array(
            z.object({
                collectionId: z.string().uuid(),
                readOnly: z.boolean(),
                hidePasswords: z.boolean()
            })
        )
        .max(200)
});

export type VaultScope = z.infer<typeof vaultScopeSchema>;
