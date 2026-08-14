/**
 * The six digits beside a saved login.
 *
 * A password manager that stores an authenticator secret and cannot show the
 * code is half a product - the point of keeping it is not having to reach for a
 * phone. The secret is decrypted in the browser like everything else, so the
 * code is computed here too; nothing about it reaches the server.
 *
 * What gets stored varies: some people paste the bare base32 secret, others
 * paste the whole `otpauth://` URI a site's QR code encodes, and that URI can
 * carry its own digit count, period and algorithm. Both are read.
 */

/** RFC 4648 base32, which is how every authenticator writes a secret. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode base32 to bytes, ignoring padding, spaces and case. */
function fromBase32(value: string): Uint8Array | null {
    const cleaned = value.replace(/[\s=-]/g, "").toUpperCase();
    if (cleaned.length === 0) return null;
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const character of cleaned) {
        const index = ALPHABET.indexOf(character);
        if (index < 0) return null;
        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return bytes.length > 0 ? Uint8Array.from(bytes) : null;
}

/** What a stored authenticator value amounts to. */
export interface TotpSettings {
    secret: string;
    digits: number;
    period: number;
    algorithm: "SHA-1" | "SHA-256" | "SHA-512";
}

/** Read either form of stored value, or null when it is neither. */
export function parseTotp(value: string): TotpSettings | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;

    if (!trimmed.toLowerCase().startsWith("otpauth://")) {
        return fromBase32(trimmed)
            ? { secret: trimmed, digits: 6, period: 30, algorithm: "SHA-1" }
            : null;
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    const secret = url.searchParams.get("secret");
    if (!secret || !fromBase32(secret)) return null;
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    return {
        secret,
        digits: Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6,
        period: Number.isFinite(period) && period >= 15 && period <= 120 ? period : 30,
        algorithm: algorithm === "SHA256" ? "SHA-256" : algorithm === "SHA512" ? "SHA-512" : "SHA-1"
    };
}

/** The code for a stored authenticator value right now, or null. */
export async function totpCode(value: string): Promise<string | null> {
    const settings = parseTotp(value);
    if (!settings) return null;
    const key = fromBase32(settings.secret);
    if (!key) return null;

    const counter = Math.floor(Date.now() / 1000 / settings.period);
    const message = new ArrayBuffer(8);
    new DataView(message).setBigUint64(0, BigInt(counter), false);

    const hmacKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: settings.algorithm },
        false,
        ["sign"]
    );
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, message));
    // Dynamic truncation, RFC 4226 section 5.4.
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary =
        ((digest[offset]! & 0x7f) << 24) |
        ((digest[offset + 1]! & 0xff) << 16) |
        ((digest[offset + 2]! & 0xff) << 8) |
        (digest[offset + 3]! & 0xff);
    return (binary % 10 ** settings.digits).toString().padStart(settings.digits, "0");
}

/** Seconds left before the current code turns over, for the ring beside it. */
export function totpRemaining(value: string): number {
    const period = parseTotp(value)?.period ?? 30;
    return period - (Math.floor(Date.now() / 1000) % period);
}
