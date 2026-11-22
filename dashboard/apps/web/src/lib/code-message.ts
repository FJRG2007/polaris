/**
 * The words around a one-time code Polaris sends: by Telegram, WhatsApp or email,
 * for a sign-in, an account added to a browser, a confirmed action or turning on
 * two-step verification.
 *
 * Every one says the same things, in the same order, because a code message is
 * what a phisher imitates and the reader can only tell the two apart by what the
 * real one always says: which Polaris it is for, what it unlocks, where the
 * request came from, how long it lasts, and that nobody - Polaris included -
 * will ever ask for it. The code leads, so a notification preview is enough.
 *
 * `composeCodeMessage` is pure and is what the tests assert; `codeMessageFor`
 * gathers the facts for one account and one request.
 */

import { appBaseUrl } from "@/lib/domain-service";
import { translatorFor } from "@/lib/i18n/translate";
import { countryForIp } from "@/lib/analytics-geoip";
import { getUserLocale } from "@/lib/i18n/locale-service";
import {
    describeDevice,
    originIp,
    originUserAgent,
    originUserAgentBrands,
    originUserAgentPlatform,
    TWO_FACTOR_CODE_TTL_MINUTES,
    type Locale
} from "@polaris/core";

/** What the code unlocks. */
export type CodePurpose = "signIn" | "addAccount" | "stepUp" | "enableTwoFactor";

/** Where the request came from and where to go if it was not the reader. */
export interface CodeContext {
    /** The Polaris the code is for, as a hostname. */
    host: string | null;
    /** The browser and system that asked, as one line. */
    device: string | null;
    /** The address that asked, and its country when known. */
    place: string | null;
    /** The account security page, to act on a request that was not theirs. */
    securityUrl: string | null;
}

export interface CodeMessage {
    subject: string;
    text: string;
    html: string;
}

type Words = ReturnType<typeof translatorFor<"api">>;

/** Longest a single fact may run before it is cut, so a crafted user-agent
 *  cannot push the warning out of a notification preview. */
const FACT_LIMIT = 80;

/**
 * One fact made safe to print: control characters and line breaks gone (a
 * value that could start a new line could forge one, "Support: reply with
 * the code"), runs of space collapsed, and the length capped.
 */
export function plainFact(value: string | null | undefined): string | null {
    if (!value) return null;
    const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!flat) return null;
    return flat.length > FACT_LIMIT ? `${flat.slice(0, FACT_LIMIT - 1)}...` : flat;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Only an http(s) address is printed as a link; anything else is dropped. */
function safeUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

/** The message itself, from facts already gathered. Pure. */
export function composeCodeMessage(
    t: Words,
    input: { code: string; purpose: CodePurpose; context: CodeContext; minutes?: number }
): CodeMessage {
    const { code, purpose } = input;
    const minutes = input.minutes ?? TWO_FACTOR_CODE_TTL_MINUTES;
    const host = plainFact(input.context.host);
    const device = plainFact(input.context.device);
    const place = plainFact(input.context.place);
    const securityUrl = safeUrl(input.context.securityUrl);
    // The code is digits, but it is printed raw only after proving it.
    const digits = code.replace(/[^0-9A-Za-z]/g, "");

    const headline = host
        ? t(`codeMessage.headline.${purpose}`, { code: digits, host })
        : t(`codeMessage.headlineNoHost.${purpose}`, { code: digits });
    const from = [device, place].filter(Boolean).join(" - ");
    const lines: Array<{ text: string; html: string }> = [
        { text: headline, html: escapeHtml(headline).replace(digits, `<strong>${digits}</strong>`) },
        ...(from ? [{ text: t("codeMessage.requestedFrom", { from }), html: escapeHtml(t("codeMessage.requestedFrom", { from })) }] : []),
        { text: t("codeMessage.expires", { minutes }), html: escapeHtml(t("codeMessage.expires", { minutes })) },
        { text: t("codeMessage.neverShare"), html: `<strong>${escapeHtml(t("codeMessage.neverShare"))}</strong>` }
    ];
    const notYou = t(purpose === "stepUp" ? "codeMessage.notYouSession" : "codeMessage.notYou");
    lines.push(
        securityUrl
            ? {
                  text: `${notYou} ${securityUrl}`,
                  html: `${escapeHtml(notYou)} <a href="${escapeHtml(securityUrl)}">${escapeHtml(securityUrl)}</a>`
              }
            : { text: notYou, html: escapeHtml(notYou) }
    );

    return {
        subject: t(`codeMessage.subject.${purpose}`, { code: digits }),
        text: lines.map((line) => line.text).join("\n\n"),
        html: lines.map((line) => `<p>${line.html}</p>`).join("")
    };
}

/** The country an address is in, named in the reader's language. */
function countryName(ip: string | undefined, locale: Locale): string | null {
    const code = countryForIp(ip);
    if (!code) return null;
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}

/** The hostname of the configured Polaris domain - the one a link would use. */
async function polarisHost(): Promise<{ host: string | null; base: string | null }> {
    try {
        const base = (await appBaseUrl()).replace(/\/+$/, "");
        return { host: new URL(base).hostname, base };
    } catch {
        return { host: null, base: null };
    }
}

/** The facts about one request, read from its headers. */
export async function codeContext(headers: Headers | undefined, locale: Locale): Promise<CodeContext> {
    const { host, base } = await polarisHost();
    if (!headers) return { host, device: null, place: null, securityUrl: base ? `${base}/account/security` : null };
    const device = describeDevice(
        originUserAgent(headers),
        originUserAgentBrands(headers),
        originUserAgentPlatform(headers)
    );
    const ip = originIp(headers);
    const country = countryName(ip, locale);
    const place = ip ? (country ? `${ip} (${country})` : ip) : null;
    return { host, device: device || null, place, securityUrl: base ? `${base}/account/security` : null };
}

/** The headers of the request in progress, when there is one. */
async function currentHeaders(): Promise<Headers | undefined> {
    try {
        const { headers } = await import("next/headers");
        return new Headers(await headers());
    } catch {
        return undefined;
    }
}

/**
 * The message for one account, in its own language, about the request in
 * progress - or the one passed in, for a send that runs after its request.
 */
export async function codeMessageFor(
    userId: string,
    purpose: CodePurpose,
    code: string,
    headers?: Headers
): Promise<CodeMessage> {
    const locale = await getUserLocale(userId).catch(() => null);
    const reader = (locale ?? "en-US") as Locale;
    const context = await codeContext(headers ?? (await currentHeaders()), reader);
    return composeCodeMessage(translatorFor(reader, "api"), { code, purpose, context });
}

/** Whether a sign-in code is for an account being added beside others: the
 *  browser already holds one of Polaris' per-account session cookies. Only a
 *  label - nothing is decided by it. */
export function isAddingAccount(headers: Headers | undefined): boolean {
    return /session_token_multi-/.test(headers?.get("cookie") ?? "");
}
