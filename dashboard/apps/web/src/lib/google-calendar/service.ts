/**
 * Google Calendar, read-only.
 *
 * Two layers of credential, and they belong to different people. The operator
 * connects a Google Cloud OAuth client once (the `google` Integration row: the
 * client id in its config, the client secret encrypted beside it), and each
 * person authorizes their own Google account against it. Polaris therefore never
 * holds a credential that reaches everybody's calendar, and an account that
 * unlinks takes its events with it.
 *
 * Only the readonly scope is asked for. Showing somebody their own week needs no
 * more than that, and a token that could write would be a token that could
 * delete a meeting on a bug in this file.
 *
 * Everything Google answers with is parsed against a schema before it is read:
 * it is an outside service, and a field that changed shape should surface as an
 * empty calendar rather than as a crash inside a render.
 */

import { z } from "zod";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

export const CALENDAR_PROVIDER = "google";

const OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Read the calendar, learn who authorized, and nothing else. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"];

/** What a sign-in asks for: who is at the other end. Nothing more belongs on a
 *  consent screen whose whole job is to name an account. */
export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email"];

export interface GoogleOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The OAuth client an operator connected, or null when this deployment has none
 *  - which is what makes the account card offer to ask an administrator instead
 *  of a button that could only fail. */
export async function getGoogleOAuthClient(): Promise<GoogleOAuthClient | null> {
    const state = await getIntegrationState(CALENDAR_PROVIDER);
    if (!state?.enabled) return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId.trim() : "";
    if (!clientId) return null;
    const clientSecret = await getIntegrationSecret(CALENDAR_PROVIDER);
    return clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Google's consent screen for this deployment.
 *
 * Linking asks for lasting access: `access_type=offline` with `prompt=consent`
 * is what returns a refresh token, and without both, a second authorization
 * comes back with an access token that expires in an hour and the calendar stops
 * loading the same afternoon.
 *
 * A sign-in asks for neither. It needs the account's name once, so it asks for
 * no offline access and no repeated consent - what it does ask for is which
 * account, because somebody signed into two of them has to be able to say. The
 * result is that signing in shows an account chooser rather than the calendar
 * consent screen all over again.
 */
export function googleAuthorizeUrl(
    client: GoogleOAuthClient,
    redirectUri: string,
    state: string,
    flow: "link" | "signin" = "link"
): string {
    const signIn = flow === "signin";
    const url = new URL(OAUTH_AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (signIn ? GOOGLE_SIGN_IN_SCOPES : GOOGLE_SCOPES).join(" "));
    if (!signIn) url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", signIn ? "select_account" : "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional()
});

const userinfoSchema = z.object({
    sub: z.string().min(1),
    // Normalized on the way in: this address is only ever shown back as a label
    // for the linked account, and a stray case difference should not make the
    // same account look like two.
    email: z.string().trim().toLowerCase().pipe(z.string().email()).optional()
});

export interface GoogleAuthorization {
    readonly refreshToken: string;
    readonly accessToken: string;
    readonly scope: string;
    readonly accountId: string;
    readonly email: string;
}

/** Spend the authorization code and learn whose account it was. */
export async function exchangeGoogleCode(
    client: GoogleOAuthClient,
    code: string,
    redirectUri: string
): Promise<GoogleAuthorization> {
    const token = await postToken(client, {
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
    });
    if (!token.refresh_token) {
        // Google withholds it when the account already granted this client and
        // the request did not force the consent screen. Nothing here can use an
        // access token that dies in an hour, so it is refused with the one
        // instruction that fixes it.
        throw new Error(
            "Google did not return a refresh token. Remove Polaris from your Google account's third-party access and link again."
        );
    }

    const who = await fetchJson(USERINFO, userinfoSchema, { Authorization: `Bearer ${token.access_token}` });
    return {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        scope: token.scope ?? "",
        accountId: who.sub,
        email: who.email ?? ""
    };
}

/**
 * Spend a sign-in's code and report whose Google account it was.
 *
 * Deliberately narrower than the link exchange: no refresh token is asked for,
 * so there is none to keep, and the access token is spent on the one question
 * this has to answer and then dropped. The subject is what identifies the
 * account - an address can move between accounts, and Google says so itself.
 */
export async function identifyGoogleAccount(
    client: GoogleOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const token = await postToken(client, {
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
    });
    const who = await fetchJson(USERINFO, userinfoSchema, { Authorization: `Bearer ${token.access_token}` });
    return { accountId: who.sub };
}

/** Access tokens live an hour; minting one per page view would spend a request
 *  on every navigation. Cached in memory only, keyed by the refresh token that
 *  produced it, and never written anywhere. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(client: GoogleOAuthClient, refreshToken: string): Promise<string> {
    const cached = accessTokens.get(refreshToken);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const token = await postToken(client, { refresh_token: refreshToken, grant_type: "refresh_token" });
    // A minute of headroom, so a token does not expire between this check and
    // the call it was fetched for.
    const ttl = (token.expires_in ?? 3600) * 1000 - 60_000;
    accessTokens.set(refreshToken, { token: token.access_token, expiresAt: Date.now() + Math.max(0, ttl) });
    return token.access_token;
}

/** Forget a cached access token, for when its refresh token is being discarded. */
export function forgetGoogleAccessToken(refreshToken: string): void {
    accessTokens.delete(refreshToken);
}

/** Raised when Google has stopped accepting the stored refresh token - the
 *  person revoked access, or changed their password. The caller turns this into
 *  "link again" rather than into an error nobody can act on. */
export class GoogleAuthExpiredError extends Error {
    constructor() {
        super("Google no longer accepts this authorization.");
        this.name = "GoogleAuthExpiredError";
    }
}

const eventsSchema = z.object({
    items: z
        .array(
            z.object({
                id: z.string(),
                status: z.string().optional(),
                summary: z.string().optional(),
                location: z.string().optional(),
                htmlLink: z.string().optional(),
                start: z.object({ date: z.string().optional(), dateTime: z.string().optional() }).optional(),
                end: z.object({ date: z.string().optional(), dateTime: z.string().optional() }).optional()
            })
        )
        .optional()
});

/** One event as the calendar screen receives it. All-day events keep Google's
 *  plain `YYYY-MM-DD`, because turning it into an instant here would move it a
 *  day for anybody whose timezone differs from this server's. */
export interface CalendarEventView {
    readonly id: string;
    readonly title: string;
    readonly start: string;
    readonly end: string | null;
    readonly allDay: boolean;
    readonly location: string | null;
    readonly url: string | null;
}

/**
 * The account's events between two instants.
 *
 * `singleEvents` expands a recurring meeting into the occurrences that actually
 * fall in the window, which is the only form a calendar can draw. Cancelled
 * occurrences come back too and are dropped: a meeting somebody called off is
 * not on the calendar.
 */
export async function listGoogleEvents(
    client: GoogleOAuthClient,
    refreshToken: string,
    from: Date,
    to: Date
): Promise<CalendarEventView[]> {
    const accessToken = await googleAccessToken(client, refreshToken);
    const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
    url.searchParams.set("timeMin", from.toISOString());
    url.searchParams.set("timeMax", to.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");

    const body = await fetchJson(url.toString(), eventsSchema, { Authorization: `Bearer ${accessToken}` });
    const events: CalendarEventView[] = [];
    for (const item of body.items ?? []) {
        if (item.status === "cancelled") continue;
        const start = item.start?.dateTime ?? item.start?.date;
        if (!start) continue;
        events.push({
            id: item.id,
            title: item.summary?.trim() || "(no title)",
            start,
            end: item.end?.dateTime ?? item.end?.date ?? null,
            allDay: item.start?.dateTime === undefined,
            location: item.location ?? null,
            url: item.htmlLink ?? null
        });
    }
    return events;
}

async function postToken(
    client: GoogleOAuthClient,
    fields: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(OAUTH_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            ...fields,
            client_id: client.clientId,
            client_secret: client.clientSecret
        }),
        cache: "no-store"
    });
    if (response.status === 400 || response.status === 401) throw new GoogleAuthExpiredError();
    if (!response.ok) throw new Error(`Google returned ${response.status} for the token request`);
    const parsed = tokenSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Google returned a token response Polaris could not read");
    return parsed.data;
}

async function fetchJson<Shape extends z.ZodTypeAny>(
    url: string,
    schema: Shape,
    headers: HeadersInit
): Promise<z.infer<Shape>> {
    const response = await fetch(url, { headers, cache: "no-store" });
    if (response.status === 401 || response.status === 403) throw new GoogleAuthExpiredError();
    if (!response.ok) throw new Error(`Google returned ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Google returned something Polaris could not read");
    return parsed.data;
}
