/**
 * The vault's wire vocabulary: the numbers and string shapes Bitwarden clients
 * already speak.
 *
 * None of this is a Polaris invention and none of it is negotiable - a client
 * that reads `type: 2` on a cipher expects a secure note, and a `2.<iv>|<ct>|<mac>`
 * string is what its own crypto is written against. It lives in @polaris/core,
 * pure and isomorphic, so the browser that encrypts and the server that stores
 * agree on it without either owning the definition.
 *
 * There is deliberately no cryptography here. The server never holds a key, so
 * a module it can import must not be able to decrypt anything; the browser-side
 * crypto lives in the web app, next to the screens that unlock a vault.
 */

/** How a master password is turned into a master key. */
export const KDF_PBKDF2 = 0;
export const KDF_ARGON2ID = 1;
export type KdfType = typeof KDF_PBKDF2 | typeof KDF_ARGON2ID;

/**
 * The KDF a new vault starts on.
 *
 * PBKDF2 rather than Argon2id, matching Bitwarden's own default: every client
 * can do it with the platform's own crypto, while Argon2 needs a WASM build that
 * an old or restricted browser may not run. An account is free to move to
 * Argon2id afterwards, and the vault reads either.
 */
export const DEFAULT_KDF: KdfType = KDF_PBKDF2;

/** OWASP's recommendation for PBKDF2-HMAC-SHA256, and Bitwarden's default. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Argon2id defaults: 3 passes over 64 MiB, 4 lanes. */
export const DEFAULT_ARGON2_ITERATIONS = 3;
export const DEFAULT_ARGON2_MEMORY_MIB = 64;
export const DEFAULT_ARGON2_PARALLELISM = 4;

/**
 * What a vault will accept when somebody changes their KDF.
 *
 * The floors are the security control: a vault set to 5,000 PBKDF2 rounds is a
 * vault whose master password can be attacked offline from a database dump. The
 * ceilings are a denial-of-service control in the other direction - a phone that
 * cannot finish the derivation is an account nobody can open, including its
 * owner, and 2 GiB of Argon2 memory is not a setting, it is a lockout.
 */
export const KDF_LIMITS = {
    pbkdf2: { min: 100_000, max: 2_000_000 },
    argon2Iterations: { min: 2, max: 10 },
    argon2MemoryMib: { min: 16, max: 1024 },
    argon2Parallelism: { min: 1, max: 16 }
} as const;

/** The KDF settings one account uses, as prelogin reports them. */
export interface KdfSettings {
    kdf: KdfType;
    kdfIterations: number;
    /** Argon2id only: memory in MiB, and lanes. Null for PBKDF2. */
    kdfMemory: number | null;
    kdfParallelism: number | null;
}

/** The settings a vault is created with. */
export const DEFAULT_KDF_SETTINGS: KdfSettings = {
    kdf: DEFAULT_KDF,
    kdfIterations: DEFAULT_PBKDF2_ITERATIONS,
    kdfMemory: null,
    kdfParallelism: null
};

/** Whether a set of KDF settings is one this deployment will store. */
export function kdfSettingsValid(settings: KdfSettings): boolean {
    if (settings.kdf === KDF_PBKDF2) {
        return (
            settings.kdfIterations >= KDF_LIMITS.pbkdf2.min &&
            settings.kdfIterations <= KDF_LIMITS.pbkdf2.max
        );
    }
    if (settings.kdf !== KDF_ARGON2ID) return false;
    const memory = settings.kdfMemory ?? 0;
    const parallelism = settings.kdfParallelism ?? 0;
    return (
        settings.kdfIterations >= KDF_LIMITS.argon2Iterations.min &&
        settings.kdfIterations <= KDF_LIMITS.argon2Iterations.max &&
        memory >= KDF_LIMITS.argon2MemoryMib.min &&
        memory <= KDF_LIMITS.argon2MemoryMib.max &&
        parallelism >= KDF_LIMITS.argon2Parallelism.min &&
        parallelism <= KDF_LIMITS.argon2Parallelism.max
    );
}

/**
 * The encryption a stored string was produced with, as its leading number.
 *
 * Only 2 and 4 are ever written. The others are read-only history: 0 and 1 are
 * unauthenticated or short-key modes nothing should still be producing, and 3
 * and 6 are RSA variants Bitwarden moved off. A vault imported from an old
 * client can still contain them, which is why they are named rather than
 * treated as corrupt.
 */
export const ENC_AES_CBC256_B64 = 0;
export const ENC_AES_CBC128_HMAC_SHA256_B64 = 1;
export const ENC_AES_CBC256_HMAC_SHA256_B64 = 2;
export const ENC_RSA_2048_OAEP_SHA256_B64 = 3;
export const ENC_RSA_2048_OAEP_SHA1_B64 = 4;
export const ENC_RSA_2048_OAEP_SHA256_HMAC_SHA256_B64 = 5;
export const ENC_RSA_2048_OAEP_SHA1_HMAC_SHA256_B64 = 6;

export type EncryptionType =
    | typeof ENC_AES_CBC256_B64
    | typeof ENC_AES_CBC128_HMAC_SHA256_B64
    | typeof ENC_AES_CBC256_HMAC_SHA256_B64
    | typeof ENC_RSA_2048_OAEP_SHA256_B64
    | typeof ENC_RSA_2048_OAEP_SHA1_B64
    | typeof ENC_RSA_2048_OAEP_SHA256_HMAC_SHA256_B64
    | typeof ENC_RSA_2048_OAEP_SHA1_HMAC_SHA256_B64;

/** A parsed encrypted string. Every field is still base64 - nothing here decodes. */
export interface ParsedEncString {
    type: EncryptionType;
    /** Initialization vector, for the symmetric types. */
    iv: string | null;
    data: string;
    /** Authentication tag, for the types that carry one. */
    mac: string | null;
}

/** How many pieces each type carries after the leading "<n>.". */
const PIECES: Readonly<Record<number, number>> = {
    [ENC_AES_CBC256_B64]: 2,
    [ENC_AES_CBC128_HMAC_SHA256_B64]: 3,
    [ENC_AES_CBC256_HMAC_SHA256_B64]: 3,
    [ENC_RSA_2048_OAEP_SHA256_B64]: 1,
    [ENC_RSA_2048_OAEP_SHA1_B64]: 1,
    [ENC_RSA_2048_OAEP_SHA256_HMAC_SHA256_B64]: 2,
    [ENC_RSA_2048_OAEP_SHA1_HMAC_SHA256_B64]: 2
};

/** Base64 with standard alphabet and padding, which is what these carry. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Read an encrypted string, or null when it is not one.
 *
 * Null rather than a throw because this runs over data the server did not
 * produce and cannot check any other way: a client sending nonsense should get
 * a refusal, not a stack trace, and a stored value that fails to parse should
 * be reported as unreadable rather than crash the sync that touched it.
 */
export function parseEncString(value: string): ParsedEncString | null {
    const dot = value.indexOf(".");
    if (dot < 1) return null;
    const type = Number(value.slice(0, dot));
    const expected = PIECES[type];
    if (expected === undefined) return null;

    const pieces = value.slice(dot + 1).split("|");
    if (pieces.length !== expected) return null;
    if (pieces.some((piece) => piece.length === 0 || !BASE64.test(piece))) return null;

    // Symmetric types lead with the IV; the RSA ones are just the payload.
    if (expected === 1) {
        return { type: type as EncryptionType, iv: null, data: pieces[0]!, mac: null };
    }
    if (type === ENC_AES_CBC256_B64) {
        return { type, iv: pieces[0]!, data: pieces[1]!, mac: null };
    }
    if (expected === 2) {
        return { type: type as EncryptionType, iv: null, data: pieces[0]!, mac: pieces[1]! };
    }
    return { type: type as EncryptionType, iv: pieces[0]!, data: pieces[1]!, mac: pieces[2]! };
}

/** Whether a value is a well-formed encrypted string. */
export function isEncString(value: unknown): value is string {
    return typeof value === "string" && parseEncString(value) !== null;
}

/** Write the pieces back out in the form clients read. */
export function formatEncString(parsed: ParsedEncString): string {
    const pieces =
        parsed.iv !== null
            ? parsed.mac !== null
                ? [parsed.iv, parsed.data, parsed.mac]
                : [parsed.iv, parsed.data]
            : parsed.mac !== null
              ? [parsed.data, parsed.mac]
              : [parsed.data];
    return `${parsed.type}.${pieces.join("|")}`;
}

/** What a vault item is. */
export const CIPHER_LOGIN = 1;
export const CIPHER_SECURE_NOTE = 2;
export const CIPHER_CARD = 3;
export const CIPHER_IDENTITY = 4;
export const CIPHER_SSH_KEY = 5;
export type CipherType =
    | typeof CIPHER_LOGIN
    | typeof CIPHER_SECURE_NOTE
    | typeof CIPHER_CARD
    | typeof CIPHER_IDENTITY
    | typeof CIPHER_SSH_KEY;

export const CIPHER_TYPES: readonly CipherType[] = [
    CIPHER_LOGIN,
    CIPHER_SECURE_NOTE,
    CIPHER_CARD,
    CIPHER_IDENTITY,
    CIPHER_SSH_KEY
];

/** What Polaris calls each of them on its own screens. */
export const CIPHER_TYPE_LABEL: Readonly<Record<CipherType, string>> = {
    [CIPHER_LOGIN]: "Login",
    [CIPHER_SECURE_NOTE]: "Note",
    [CIPHER_CARD]: "Card",
    [CIPHER_IDENTITY]: "Identity",
    [CIPHER_SSH_KEY]: "SSH key"
};

/** A custom field on an item. */
export const FIELD_TEXT = 0;
export const FIELD_HIDDEN = 1;
export const FIELD_BOOLEAN = 2;
export const FIELD_LINKED = 3;

/** How a saved address is matched against the page somebody is on. */
export const URI_MATCH_DOMAIN = 0;
export const URI_MATCH_HOST = 1;
export const URI_MATCH_STARTS_WITH = 2;
export const URI_MATCH_EXACT = 3;
export const URI_MATCH_REGEX = 4;
export const URI_MATCH_NEVER = 5;

/** What a Send holds. */
export const SEND_TEXT = 0;
export const SEND_FILE = 1;
export type SendType = typeof SEND_TEXT | typeof SEND_FILE;

/**
 * How long a vault stays open in a browser that is not being used.
 *
 * The key never leaves the browser, so this is the whole of the trade: a vault
 * that locks the moment you look away is the safest and the one people stop
 * using, because moving between two Polaris screens asks for the master password
 * twice. The two ends of the scale are named rather than numbered - "when I
 * close the tab" is not a duration - and everything between is minutes.
 */
export const VAULT_LOCK_ON_TAB_CLOSE = -1;
export const VAULT_LOCK_IMMEDIATELY = 0;

/** The choices offered, in the order they are shown. */
export const VAULT_UNLOCK_TIMEOUTS = [
    VAULT_LOCK_IMMEDIATELY,
    1,
    5,
    15,
    30,
    60,
    240,
    VAULT_LOCK_ON_TAB_CLOSE
] as const;

/**
 * Fifteen minutes, which is what Bitwarden's own clients default to. Long
 * enough that ordinary work does not keep asking, short enough that a machine
 * left alone is not left open.
 */
export const DEFAULT_VAULT_UNLOCK_TIMEOUT = 15;

/** What each choice is called. */
export const VAULT_UNLOCK_TIMEOUT_LABEL: Readonly<Record<number, string>> = {
    [VAULT_LOCK_IMMEDIATELY]: "As soon as I leave the vault",
    1: "After 1 minute idle",
    5: "After 5 minutes idle",
    15: "After 15 minutes idle",
    30: "After 30 minutes idle",
    60: "After 1 hour idle",
    240: "After 4 hours idle",
    [VAULT_LOCK_ON_TAB_CLOSE]: "When I close the tab"
};

/** Whether a stored timeout is one of the offered choices. */
export function vaultUnlockTimeoutValid(minutes: number): boolean {
    return VAULT_UNLOCK_TIMEOUTS.includes(minutes as (typeof VAULT_UNLOCK_TIMEOUTS)[number]);
}

/**
 * How many vaults of their own one account may keep, beside the vault it starts
 * with. Not a licence tier: each one is a key somebody has to remember they hold,
 * and an account with hundreds of them is a mistake or a script, not a filing
 * system.
 */
export const MAX_OWNED_VAULTS = 20;

/** Where an account stands in an organization. */
export const ORG_USER_INVITED = 0;
export const ORG_USER_ACCEPTED = 1;
export const ORG_USER_CONFIRMED = 2;
export const ORG_USER_REVOKED = -1;

/** What an account may do in an organization, in the numbers clients read. */
export const ORG_ROLE_OWNER = 0;
export const ORG_ROLE_ADMIN = 1;
export const ORG_ROLE_USER = 2;
export const ORG_ROLE_MANAGER = 3;
export const ORG_ROLE_CUSTOM = 4;

/**
 * The second factors a client can be asked for, in the provider numbers it
 * expects. Only the two Polaris can actually serve are listed: a client offered
 * a provider that does not answer is a client stuck on a code that never comes.
 */
export const TWO_FACTOR_AUTHENTICATOR = 0;
export const TWO_FACTOR_EMAIL = 1;

/**
 * A device type, as a client reports itself. The full list is long and only
 * matters for how a session is named back to its owner, so the ones with a name
 * here are the ones Polaris labels; anything else is shown as its number.
 */
export const DEVICE_TYPE_LABEL: Readonly<Record<number, string>> = {
    0: "Android",
    1: "iOS",
    2: "Chrome extension",
    3: "Firefox extension",
    4: "Opera extension",
    5: "Edge extension",
    6: "Windows",
    7: "macOS",
    8: "Linux",
    9: "Chrome",
    10: "Firefox",
    11: "Opera",
    12: "Edge",
    13: "Internet Explorer",
    14: "Unknown browser",
    15: "Android (Amazon)",
    16: "UWP",
    17: "Safari",
    18: "Vivaldi",
    19: "Vivaldi extension",
    20: "Safari extension",
    21: "SDK",
    22: "Server",
    23: "Windows CLI",
    24: "macOS CLI",
    25: "Linux CLI"
};

/** How a device is named back to its owner. */
export function deviceTypeLabel(type: number | null | undefined): string {
    if (type === null || type === undefined) return "Unknown device";
    return DEVICE_TYPE_LABEL[type] ?? `Device type ${type}`;
}
