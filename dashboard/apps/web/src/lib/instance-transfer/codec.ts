/**
 * One row, as it travels between two Polaris instances.
 *
 * Plain JSON cannot hold a date, a large integer or raw bytes, so each is tagged.
 * The harder part is what is sealed: every credential here is encrypted under the
 * instance's own master key, and the instance it moves to has a different one. So
 * each secret is opened on the way out and sealed again on the way in, under the
 * key that will read it there. The file they travel in is sealed under a
 * passphrase as a whole; nothing leaves in the clear.
 *
 * Three shapes of secret exist in the schema, found from the schema rather than
 * listed by hand, so a table added later is carried without anyone remembering to:
 *
 *  - an envelope in three columns: the ciphertext (`encryptedX`, or `x` itself),
 *    `xNonce` and `xKeyId`;
 *  - an envelope as one JSON string, `{"c","n","k"}`, in a text column;
 *  - the sign-in library's own sealing of two-factor secrets, under the auth secret.
 *
 * A secret that does not open here - sealed under a key this instance no longer
 * has - travels as it is and is counted, so the summary can say it will need
 * entering again.
 */

import type { SchemaField, SchemaModel } from "./plan";

export interface Envelope {
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly keyId: string;
}

/** How secrets are opened on one instance and sealed on the other. */
export interface SecretCodec {
    open(blob: Envelope): string | null;
    seal(plain: string): Envelope;
    /** A two-factor value sealed by the sign-in library, or null when it does not open. */
    openAuth(value: string): Promise<string | null>;
    sealAuth(plain: string): Promise<string>;
}

export interface Tally {
    carried: number;
    unreadable: number;
}

/** The models whose two-factor columns the sign-in library seals. */
const AUTH_SEALED: Readonly<Record<string, readonly string[]>> = {
    TwoFactor: ["secret", "backupCodes"]
};

/** Columns worked out from a secret, reset on arrival rather than carried. */
const DERIVED_FROM_SECRET = new Set(["secretFingerprint"]);

export interface Triple {
    readonly ciphertext: string;
    readonly nonce: string;
    readonly keyId: string;
}

/** Every envelope a model keeps in three columns. */
export function envelopeTriples(model: Pick<SchemaModel, "fields">): Triple[] {
    const byName = new Map(model.fields.map((field) => [field.name, field]));
    const triples: Triple[] = [];
    for (const field of model.fields) {
        if (!field.name.endsWith("Nonce") || field.type !== "Bytes") continue;
        const base = field.name.slice(0, -"Nonce".length);
        const keyId = `${base}KeyId`;
        const prefixed = `encrypted${base.charAt(0).toUpperCase()}${base.slice(1)}`;
        const ciphertext =
            byName.get(prefixed)?.type === "Bytes"
                ? prefixed
                : byName.get(base)?.type === "Bytes"
                  ? base
                  : null;
        if (ciphertext && byName.get(keyId)?.type === "String")
            triples.push({ ciphertext, nonce: field.name, keyId });
    }
    return triples;
}

/** Whether a text value is an envelope stored as `{"c","n","k"}`. */
function sealedText(value: string): { c: string; n: string; k: string } | null {
    if (!value.startsWith("{") || !value.includes('"c"')) return null;
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const keys = Object.keys(parsed).sort().join(",");
        if (keys !== "c,k,n") return null;
        if (
            typeof parsed.c !== "string" ||
            typeof parsed.n !== "string" ||
            typeof parsed.k !== "string"
        )
            return null;
        return parsed as { c: string; n: string; k: string };
    } catch {
        return null;
    }
}

function encodeScalar(field: SchemaField, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (field.isList && Array.isArray(value))
        return value.map((item) => encodeScalar({ ...field, isList: false }, item));
    switch (field.type) {
        case "DateTime":
            return { $date: (value as Date).toISOString() };
        case "BigInt":
            return { $bigint: String(value) };
        case "Bytes":
            return { $bytes: Buffer.from(value as Uint8Array).toString("base64") };
        case "Decimal":
            return { $decimal: String(value) };
        default:
            return value;
    }
}

function decodeScalar(field: SchemaField, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (field.isList && Array.isArray(value))
        return value.map((item) => decodeScalar({ ...field, isList: false }, item));
    const tagged = value as Record<string, unknown>;
    switch (field.type) {
        case "DateTime":
            return new Date(String(tagged.$date));
        case "BigInt":
            return BigInt(String(tagged.$bigint));
        case "Bytes":
            return Buffer.from(String(tagged.$bytes), "base64");
        case "Decimal":
            return String(tagged.$decimal);
        default:
            return value;
    }
}

/** A row as it is written to the transfer file. */
export async function encodeRow(
    model: SchemaModel,
    row: Record<string, unknown>,
    codec: SecretCodec,
    tally: Tally
): Promise<Record<string, unknown>> {
    const triples = envelopeTriples(model);
    const skip = new Set(triples.flatMap((triple) => [triple.nonce, triple.keyId]));
    const cipherColumns = new Map(triples.map((triple) => [triple.ciphertext, triple]));
    const authSealed = new Set(AUTH_SEALED[model.name] ?? []);
    const out: Record<string, unknown> = {};
    for (const field of model.fields) {
        if (field.kind === "object" || skip.has(field.name) || !(field.name in row)) continue;
        const value = row[field.name];
        const triple = cipherColumns.get(field.name);
        if (triple) {
            if (value === null || value === undefined) {
                out[field.name] = null;
                continue;
            }
            const blob = {
                ciphertext: Buffer.from(value as Uint8Array),
                nonce: Buffer.from((row[triple.nonce] as Uint8Array | null) ?? new Uint8Array()),
                keyId: String(row[triple.keyId] ?? "")
            };
            const plain = codec.open(blob);
            if (plain === null) {
                tally.unreadable += 1;
                out[field.name] = {
                    $sealed: {
                        c: blob.ciphertext.toString("base64"),
                        n: blob.nonce.toString("base64"),
                        k: blob.keyId
                    }
                };
            } else {
                tally.carried += 1;
                out[field.name] = { $secret: plain };
            }
            continue;
        }
        if (typeof value === "string" && authSealed.has(field.name)) {
            const plain = await codec.openAuth(value);
            if (plain === null) tally.unreadable += 1;
            else tally.carried += 1;
            out[field.name] = plain === null ? value : { $auth: plain };
            continue;
        }
        if (typeof value === "string") {
            const sealed = sealedText(value);
            if (sealed) {
                const plain = codec.open({
                    ciphertext: Buffer.from(sealed.c, "base64"),
                    nonce: Buffer.from(sealed.n, "base64"),
                    keyId: sealed.k
                });
                if (plain === null) tally.unreadable += 1;
                else tally.carried += 1;
                out[field.name] = plain === null ? value : { $sealedText: plain };
                continue;
            }
        }
        out[field.name] = encodeScalar(field, value);
    }
    return out;
}

/** A row from the transfer file, ready to write here. */
export async function decodeRow(
    model: SchemaModel,
    encoded: Record<string, unknown>,
    codec: SecretCodec
): Promise<Record<string, unknown>> {
    const triples = envelopeTriples(model);
    const cipherColumns = new Map(triples.map((triple) => [triple.ciphertext, triple]));
    const out: Record<string, unknown> = {};
    for (const field of model.fields) {
        // A column this build does not have is dropped; one the file does not
        // carry is left to its default.
        if (field.kind === "object" || !(field.name in encoded)) continue;
        if (DERIVED_FROM_SECRET.has(field.name)) {
            out[field.name] = null;
            continue;
        }
        const value = encoded[field.name];
        const triple = cipherColumns.get(field.name);
        if (triple) {
            const tagged = (value ?? null) as {
                $secret?: string;
                $sealed?: { c: string; n: string; k: string };
            } | null;
            if (tagged === null) {
                out[field.name] = null;
                out[triple.nonce] = null;
                out[triple.keyId] = null;
            } else if (typeof tagged.$secret === "string") {
                const blob = codec.seal(tagged.$secret);
                out[field.name] = blob.ciphertext;
                out[triple.nonce] = blob.nonce;
                out[triple.keyId] = blob.keyId;
            } else if (tagged.$sealed) {
                out[field.name] = Buffer.from(tagged.$sealed.c, "base64");
                out[triple.nonce] = Buffer.from(tagged.$sealed.n, "base64");
                out[triple.keyId] = tagged.$sealed.k;
            }
            continue;
        }
        // A text column only ever carries a plain string or one of these two.
        if (
            field.type === "String" &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            const tagged = value as { $auth?: unknown; $sealedText?: unknown };
            if (typeof tagged.$auth === "string") {
                out[field.name] = await codec.sealAuth(tagged.$auth);
                continue;
            }
            if (typeof tagged.$sealedText === "string") {
                const blob = codec.seal(tagged.$sealedText);
                out[field.name] = JSON.stringify({
                    c: blob.ciphertext.toString("base64"),
                    n: blob.nonce.toString("base64"),
                    k: blob.keyId
                });
                continue;
            }
        }
        out[field.name] = decodeScalar(field, value);
    }
    return out;
}
