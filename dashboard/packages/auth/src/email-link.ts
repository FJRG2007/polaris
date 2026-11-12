/**
 * Sign-in by emailed link, tied to the browser and the connection that asked
 * for it.
 *
 * A link in a mailbox is a bearer credential: whoever opens it is signed in. A
 * forwarded message, an intercepted one, a mail scanner that follows every link
 * it is handed, a phone that previews the inbox - each of them used to be a
 * session for somebody who was never at the sign-in page. So asking for a link
 * also hands the asking browser a random cookie, and the link is only redeemed
 * where that cookie turns up again, from the address it was asked from. Anywhere
 * else the link is left untouched (still good where it belongs, until it
 * expires) and the reader is shown where to open it instead.
 *
 * Only a digest of the cookie is stored, beside the link in better-auth's own
 * verification table, so neither a database read nor the link alone is enough.
 * Nothing here needs a setting or a migration: the row, the cookie and the
 * address all come from what every install already has.
 */

import * as z from "zod";
import { magicLink } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { addressMoved, originIp } from "@polaris/core";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Where an emailed sign-in link is redeemed. */
export const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

/** The page a link opened somewhere else lands on. */
export const EMAIL_LINK_ELSEWHERE_PATH = "/oauth/link-elsewhere";

/** How long an emailed sign-in link stays good. Short: it is a bearer credential
 *  sitting in an inbox, and the user is asking to sign in right now. */
export const EMAIL_LINK_TTL_SECONDS = 10 * 60;

/** The cookie that marks the browser a link was asked from. */
const BINDING_COOKIE = "link_binding";

/** What a held binding cookie looks like: 32 random bytes, base64url. Anything
 *  else is replaced rather than trusted. */
const BINDING_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** The sentence every link email carries, so the refusal is never a surprise. */
export const EMAIL_LINK_SAME_PLACE =
    "Open this link on the same device and internet connection you used to ask for it.";

const bindingRecord = z
    .object({
        cookie: z.string().regex(/^[0-9a-f]{64}$/),
        ip: z.string().max(64).nullable()
    })
    .strict();

type BindingRecord = z.infer<typeof bindingRecord>;

function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** Keyed by a digest of the link's token, never the token itself. */
function bindingIdentifier(token: string): string {
    return `magic-link-binding:${digest(token)}`;
}

/** better-auth's own key for the link, with the plugin's default plain storage. */
function linkIdentifier(token: string): string {
    return `magic-link:${token}`;
}

/** The slice of an endpoint context this module touches, so the handful of
 *  calls it makes are typed without naming better-auth's internal generics. */
interface LinkContext {
    headers?: Headers;
    request?: Request;
    getCookie(name: string): string | null | undefined;
    setCookie(name: string, value: string, attributes?: Record<string, unknown>): unknown;
    context: {
        isTrustedOrigin(url: string): boolean;
        createAuthCookie(
            name: string,
            attributes?: Record<string, unknown>
        ): { name: string; attributes: Record<string, unknown> };
        internalAdapter: {
            createVerificationValue(data: {
                identifier: string;
                value: string;
                expiresAt: Date;
            }): Promise<unknown>;
            findVerificationValue(
                identifier: string
            ): Promise<{ value: string; expiresAt: Date } | null>;
            deleteVerificationByIdentifier(identifier: string): Promise<void>;
        };
    };
}

function requestHeaders(ctx: LinkContext): Headers | undefined {
    return ctx.headers ?? ctx.request?.headers;
}

/** The scheme the browser used, as the proxy in front reports it. */
function requestScheme(ctx: LinkContext): string | undefined {
    const forwarded = requestHeaders(ctx)?.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.toLowerCase();
    if (!ctx.request) return undefined;
    try {
        return new URL(ctx.request.url).protocol.replace(/:$/, "");
    } catch {
        return undefined;
    }
}

/** The origin the browser asked from, when it is one this deployment trusts. */
function requestOrigin(ctx: LinkContext): string | undefined {
    const host = (requestHeaders(ctx)?.get("x-forwarded-host") ?? requestHeaders(ctx)?.get("host"))
        ?.split(",")[0]
        ?.trim();
    const scheme = requestScheme(ctx);
    if (!host || (scheme !== "http" && scheme !== "https")) return undefined;
    try {
        const origin = new URL(`${scheme}://${host}`).origin;
        return ctx.context.isTrustedOrigin(origin) ? origin : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The link, pointed at the address the browser asked from.
 *
 * The cookie only goes back to the host that set it, so a link asked for on the
 * local name and opened on the published one would be refused on the very
 * device it belongs to. The landing page moves with it: better-auth resolves a
 * relative one against the published address, which would carry a session made
 * on one host over to another that has none.
 */
export function linkOnRequestHost(ctx: LinkContext, url: string): string {
    const origin = requestOrigin(ctx);
    if (!origin) return url;
    const link = new URL(url);
    if (link.origin === origin) return url;
    const moved = new URL(`${link.pathname}${link.search}`, origin);
    for (const key of ["callbackURL", "newUserCallbackURL", "errorCallbackURL"]) {
        const target = moved.searchParams.get(key);
        if (target?.startsWith("/") && !target.startsWith("//")) {
            moved.searchParams.set(key, `${origin}${target}`);
        }
    }
    return moved.toString();
}

/**
 * Mark the asking browser and remember it beside the link.
 *
 * A browser that already holds a mark keeps it, so asking twice leaves both
 * links good on it rather than the second quietly killing the first.
 */
export async function bindRequester(ctx: LinkContext, token: string): Promise<void> {
    const cookie = ctx.context.createAuthCookie(BINDING_COOKIE, { maxAge: EMAIL_LINK_TTL_SECONDS });
    const held = ctx.getCookie(cookie.name);
    const value = held && BINDING_VALUE.test(held) ? held : randomBytes(32).toString("base64url");
    ctx.setCookie(cookie.name, value, {
        ...cookie.attributes,
        secure: cookie.attributes.secure === true || requestScheme(ctx) === "https"
    });
    const record: BindingRecord = {
        cookie: digest(value),
        ip: originIp(requestHeaders(ctx) ?? new Headers()) ?? null
    };
    await ctx.context.internalAdapter.createVerificationValue({
        identifier: bindingIdentifier(token),
        value: JSON.stringify(record),
        expiresAt: new Date(Date.now() + EMAIL_LINK_TTL_SECONDS * 1000)
    });
}

function readRecord(value: string): BindingRecord | null {
    try {
        const parsed = bindingRecord.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function sameDigest(held: string, stored: string): boolean {
    const a = Buffer.from(digest(held), "hex");
    const b = Buffer.from(stored, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether this request may redeem the link: "open" when it is where the link
 * was asked for, "elsewhere" when it is not, and "unknown" when there is no
 * such link at all - which better-auth's own endpoint already answers.
 *
 * A link with no record beside it is refused rather than waved through: it was
 * minted somewhere that never marked a browser, and that is not a link anybody
 * can be told the right place for.
 */
export async function requesterVerdict(
    ctx: LinkContext,
    token: string
): Promise<"open" | "elsewhere" | "unknown"> {
    if (!token) return "unknown";
    const adapter = ctx.context.internalAdapter;
    const row = await adapter.findVerificationValue(bindingIdentifier(token));
    const record = row && row.expiresAt.getTime() > Date.now() ? readRecord(row.value) : null;
    if (!record) {
        const link = await adapter.findVerificationValue(linkIdentifier(token));
        return link ? "elsewhere" : "unknown";
    }
    const held = ctx.getCookie(ctx.context.createAuthCookie(BINDING_COOKIE).name);
    if (!held || !BINDING_VALUE.test(held) || !sameDigest(held, record.cookie)) return "elsewhere";
    const ip = originIp(requestHeaders(ctx) ?? new Headers()) ?? null;
    if (addressMoved(record.ip, ip)) return "elsewhere";
    await adapter.deleteVerificationByIdentifier(bindingIdentifier(token));
    return "open";
}

/** What the link email says. Plain text and HTML, the same words in both. */
export function emailLinkMessage(url: string): { subject: string; text: string; html: string } {
    const expiry = `The link works once and expires in ${EMAIL_LINK_TTL_SECONDS / 60} minutes. If you did not ask to sign in, ignore this message.`;
    return {
        subject: "Your Polaris sign-in link",
        text: `Sign in to Polaris:\n\n${url}\n\n${EMAIL_LINK_SAME_PLACE}\n\n${expiry}`,
        html: `<p>Sign in to Polaris:</p><p><a href="${url}">Sign in</a></p><p>${EMAIL_LINK_SAME_PLACE}</p><p>${expiry}</p>`
    };
}

export interface EmailLinkOptions {
    /** Whether the account behind this address asked for this way in. */
    readonly allowed: (email: string) => Promise<boolean>;
    /** How to deliver the message; reports a failure rather than throwing. */
    readonly send: (message: {
        to: string;
        subject: string;
        text: string;
        html?: string;
    }) => Promise<{ error?: string }>;
}

/**
 * better-auth's magic-link plugin, with the link bound to where it was asked
 * for. The check runs before the endpoint, so a refused attempt never reaches
 * the step that spends the token.
 */
export function emailLinkPlugin(options: EmailLinkOptions): BetterAuthPlugin {
    const plugin = magicLink({
        expiresIn: EMAIL_LINK_TTL_SECONDS,
        // Registration is closed here as it is everywhere else: a link to an
        // address with no account must not conjure one.
        disableSignUp: true,
        sendMagicLink: async ({ email, url, token }, endpoint) => {
            const ctx = endpoint as unknown as LinkContext | undefined;
            // Marked for every address alike, before the gate below, so the
            // answer never says whether the address has an account.
            if (ctx) await bindRequester(ctx, token);
            // Off unless the account asked for it. This is the gate, not the
            // screen: the endpoint stays open and answers the same for every
            // address, so what an account decided about its own way in is never
            // readable from the outside. A link that is never sent is a link
            // nobody has - the token the plugin has already minted expires unused.
            if (!(await options.allowed(email))) return;
            const link = ctx ? linkOnRequestHost(ctx, url) : url;
            const result = await options.send({ to: email, ...emailLinkMessage(link) });
            // Surfacing the reason would tell an unauthenticated caller whether
            // the address has an account; the endpoint answers the same either
            // way and the failure is logged instead.
            if (result.error) console.error("magic link not sent:", result.error);
        }
    }) as BetterAuthPlugin;
    return {
        ...plugin,
        hooks: {
            ...plugin.hooks,
            before: [
                ...(plugin.hooks?.before ?? []),
                {
                    matcher: (context) => context.path === MAGIC_LINK_VERIFY_PATH,
                    handler: createAuthMiddleware(async (ctx) => {
                        const token = (ctx.query as { token?: unknown } | undefined)?.token;
                        const verdict = await requesterVerdict(
                            ctx as unknown as LinkContext,
                            typeof token === "string" ? token : ""
                        );
                        if (verdict === "elsewhere") throw ctx.redirect(EMAIL_LINK_ELSEWHERE_PATH);
                    })
                }
            ]
        }
    };
}
