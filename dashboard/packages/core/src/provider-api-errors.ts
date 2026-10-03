/**
 * What a refusal from Google's or Microsoft's APIs actually means.
 *
 * A 401 or 403 is not one thing. Google answers 403 when the API is switched off
 * in the Cloud project the OAuth client belongs to, when the token lacks a scope,
 * and when it wants the caller to slow down - and only one of those is fixed by
 * signing in again. Reading every 403 as "reconnect" is how a screen ends up
 * telling somebody to do something that can never work.
 *
 * So the error body is read, not the status alone, and sorted into the four
 * things somebody can act on:
 *
 * - `setup`: the API is turned off in the provider project. Only whoever runs
 *   that project can fix it; the project and the provider's own activation link
 *   are kept exactly as the answer gave them, never built here.
 * - `consent`: the grant is missing a scope. Authorizing again, for this scope,
 *   fixes it.
 * - `rate`: slow down and retry. Not an auth problem at all.
 * - `auth`: the credentials themselves were refused. Connect again.
 *
 * Anything else is `other`, with the provider's own reason, so it is reported as
 * a refusal rather than mislabelled as one of the above.
 *
 * Pure: no I/O, safe on the server and in the browser.
 */

import { z } from "zod";

/** What to do about one refusal. */
export type ProviderApiProblem =
    | {
          readonly kind: "setup";
          /** The provider's API name, e.g. `calendar-json.googleapis.com`. */
          readonly service: string | null;
          /** Its title as the provider writes it, e.g. "Google Calendar API". */
          readonly serviceTitle: string | null;
          /** The project number (or id) the API is off in, as the answer named it. */
          readonly project: string | null;
          /** The page that turns it on, as the answer linked it. */
          readonly activationUrl: string | null;
          readonly message: string;
      }
    | { readonly kind: "consent"; readonly message: string }
    | { readonly kind: "rate"; readonly message: string }
    | { readonly kind: "auth"; readonly message: string }
    | { readonly kind: "other"; readonly reason: string; readonly message: string };

/** The hosts an activation link may point at. Anything else in an error body is
 *  not shown as a link, whatever it says. */
const GOOGLE_CONSOLE_HOSTS = new Set(["console.developers.google.com", "console.cloud.google.com"]);

/** A Cloud project number, or a project id (6-30 lowercase letters, digits, dashes). */
const PROJECT = /^(?:\d{1,20}|[a-z][a-z0-9-]{4,28}[a-z0-9])$/;

const MAX_TEXT = 300;

function clip(text: string | null | undefined): string {
    const flat = (text ?? "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 3)}...` : flat;
}

/** The link, when it is an https page on Google's console; null otherwise. */
export function googleConsoleUrl(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length > 2048) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || !GOOGLE_CONSOLE_HOSTS.has(url.hostname)) return null;
        if (url.username || url.password) return null;
        return url.href;
    } catch {
        return null;
    }
}

function projectOf(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim().replace(/^projects\//, "");
    return PROJECT.test(value) ? value : null;
}

const GoogleDetail = z
    .object({
        "@type": z.string().optional(),
        reason: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        links: z
            .array(z.object({ url: z.string().optional(), description: z.string().optional() }))
            .optional()
    })
    .passthrough();

const GoogleErrorBody = z.object({
    error: z.object({
        code: z.number().optional(),
        message: z.string().optional(),
        status: z.string().optional(),
        errors: z
            .array(
                z
                    .object({
                        reason: z.string().optional(),
                        message: z.string().optional(),
                        extendedHelp: z.string().optional()
                    })
                    .passthrough()
            )
            .optional(),
        details: z.array(GoogleDetail).optional()
    })
});

/** `errors[].reason` (Google's v1 shape) that mean the API is off in the project. */
const GOOGLE_SETUP_REASONS = new Set(["accessNotConfigured"]);
/** `details[].reason` (google.rpc.ErrorInfo) for the same. */
const GOOGLE_SETUP_INFO = new Set(["SERVICE_DISABLED"]);

const GOOGLE_CONSENT_REASONS = new Set(["insufficientPermissions"]);
const GOOGLE_CONSENT_INFO = new Set(["ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

const GOOGLE_RATE_REASONS = new Set([
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded"
]);
const GOOGLE_RATE_INFO = new Set(["RATE_LIMIT_EXCEEDED"]);

const GOOGLE_AUTH_REASONS = new Set(["authError"]);
const GOOGLE_AUTH_INFO = new Set([
    "ACCESS_TOKEN_EXPIRED",
    "CREDENTIALS_MISSING",
    "ACCESS_TOKEN_TYPE_UNSUPPORTED"
]);

/**
 * What a failed Google API answer means, from its status and its JSON body
 * (`undefined` or anything unparseable when there was none).
 */
export function readGoogleApiError(status: number, body: unknown): ProviderApiProblem {
    const parsed = GoogleErrorBody.safeParse(body);
    const error = parsed.success ? parsed.data.error : null;
    const message = clip(error?.message);
    const reasons = new Set((error?.errors ?? []).map((entry) => entry.reason ?? ""));
    const details = error?.details ?? [];
    const infos = new Set(details.map((detail) => detail.reason ?? ""));
    const has = (from: Set<string>, info: Set<string>) =>
        [...reasons].some((reason) => from.has(reason)) ||
        [...infos].some((reason) => info.has(reason));

    if (has(GOOGLE_SETUP_REASONS, GOOGLE_SETUP_INFO)) {
        const info = details.find((detail) => GOOGLE_SETUP_INFO.has(detail.reason ?? ""));
        const metadata = info?.metadata ?? {};
        const helpLink = details
            .flatMap((detail) => detail.links ?? [])
            .map((link) => googleConsoleUrl(link.url))
            .find(Boolean);
        const activationUrl = googleConsoleUrl(metadata.activationUrl) ?? helpLink ?? null;
        let project = projectOf(metadata.consumer) ?? projectOf(metadata.containerInfo);
        if (!project && activationUrl)
            project = projectOf(new URL(activationUrl).searchParams.get("project"));
        return {
            kind: "setup",
            service: typeof metadata.service === "string" ? clip(metadata.service) : null,
            serviceTitle:
                typeof metadata.serviceTitle === "string" ? clip(metadata.serviceTitle) : null,
            project,
            activationUrl,
            message
        };
    }
    if (status === 429 || has(GOOGLE_RATE_REASONS, GOOGLE_RATE_INFO))
        return { kind: "rate", message };
    if (has(GOOGLE_CONSENT_REASONS, GOOGLE_CONSENT_INFO)) return { kind: "consent", message };
    if (status === 401 || has(GOOGLE_AUTH_REASONS, GOOGLE_AUTH_INFO))
        return { kind: "auth", message };
    const reason = [...infos, ...reasons].find(Boolean) ?? error?.status ?? "";
    return { kind: "other", reason: clip(reason), message };
}

const GraphErrorBody = z.object({
    error: z.object({
        code: z.string().nullish(),
        message: z.string().nullish(),
        innerError: z.object({ code: z.string().nullish() }).passthrough().nullish()
    })
});

/** Graph codes that mean the token lacks a permission the call needs. */
const GRAPH_CONSENT_CODES = new Set([
    "erroraccessdenied",
    "accessdenied",
    "authorization_requestdenied",
    "errorinsufficientpermissionsinaccesstoken"
]);

const GRAPH_RATE_CODES = new Set([
    "toomanyrequests",
    "applicationthrottled",
    "activitylimitreached",
    "errortoomanyobjectsopened"
]);

const GRAPH_AUTH_CODES = new Set(["invalidauthenticationtoken", "compacttoken_parsing_failed"]);

/** What a failed Microsoft Graph answer means. Graph has no switch per API, so
 *  it never answers `setup`. */
export function readGraphApiError(status: number, body: unknown): ProviderApiProblem {
    const parsed = GraphErrorBody.safeParse(body);
    const error = parsed.success ? parsed.data.error : null;
    const code = (error?.code ?? "").toLowerCase();
    const inner = (error?.innerError?.code ?? "").toLowerCase();
    const message = clip(error?.message);
    if (status === 429 || GRAPH_RATE_CODES.has(code)) return { kind: "rate", message };
    if (GRAPH_AUTH_CODES.has(code) || GRAPH_AUTH_CODES.has(inner)) return { kind: "auth", message };
    if (status === 403 && (GRAPH_CONSENT_CODES.has(code) || GRAPH_CONSENT_CODES.has(inner)))
        return { kind: "consent", message };
    if (status === 401) return { kind: "auth", message };
    return { kind: "other", reason: clip(error?.code ?? ""), message };
}

/**
 * What Polaris last learned about one provider API being switched on in the
 * project its OAuth client belongs to. One per instance: the project is the
 * operator's, so every account that syncs through it shares the answer.
 */
export const providerApiStateSchema = z.object({
    state: z.enum(["enabled", "disabled"]),
    project: z.string().regex(PROJECT).nullable(),
    activationUrl: z
        .string()
        .nullable()
        .refine((value) => value === null || googleConsoleUrl(value) === value),
    /** When it was first seen in this state, ISO. */
    since: z.string().datetime(),
    /** When it was last confirmed, ISO. */
    checkedAt: z.string().datetime()
});

export type ProviderApiState = z.infer<typeof providerApiStateSchema>;

/**
 * The Google APIs Polaris calls with the operator's OAuth client, each of which
 * has to be switched on in that client's Cloud project.
 *
 * Only what the code actually calls. Sign-in reads `oauth2/v3/userinfo`, which
 * needs nothing switched on, and mail reaches Gmail over IMAP and SMTP rather
 * than through the Gmail API. Service names are Google's own, from
 * https://developers.google.com/workspace/guides/enable-apis.
 *
 * `probe` is the cheapest read the API answers for any account: it returns the
 * resource kind and nothing of the person's data. `scope` is what a token needs
 * to be asked it.
 */
export const GOOGLE_APIS = [
    {
        id: "calendar",
        service: "calendar-json.googleapis.com",
        title: "Google Calendar API",
        scope: "https://www.googleapis.com/auth/calendar",
        probe: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=kind"
    },
    {
        id: "drive",
        service: "drive.googleapis.com",
        title: "Google Drive API",
        scope: "https://www.googleapis.com/auth/drive.file",
        probe: "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=kind"
    }
] as const;

export type GoogleApiId = (typeof GOOGLE_APIS)[number]["id"];

/** The setting one Google API's state is kept under. */
export function googleApiStateKey(api: GoogleApiId): string {
    return `google-api.${api}`;
}

/** The setting the Google Calendar API's state is kept under. */
export const GOOGLE_CALENDAR_API_STATE_KEY = googleApiStateKey("calendar");

/** The API's page in the Cloud console, opened on this project. */
export function googleApiLibraryUrl(service: string, project: string | null): string {
    const url = new URL(
        `https://console.cloud.google.com/apis/library/${encodeURIComponent(service)}`
    );
    if (project && PROJECT.test(project)) url.searchParams.set("project", project);
    return url.href;
}

/**
 * The project number an OAuth client id starts with (`<number>-<id>.apps.
 * googleusercontent.com`), or null.
 *
 * Google does not document this, so it is only a fallback for a link while
 * nothing better is known: the project an error body names always wins.
 */
export function projectFromGoogleClientId(clientId: string): string | null {
    const match = /^(\d{1,20})-[a-z0-9]+\.apps\.googleusercontent\.com$/i.exec(clientId.trim());
    return match?.[1] ?? null;
}

/** Where to switch a disabled API on: Google's own link when the answer gave
 *  one, else the API's console page on the project the answer named. */
export function googleApiEnableUrl(
    service: string,
    state: Pick<ProviderApiState, "project" | "activationUrl"> | null,
    fallbackProject: string | null = null
): string {
    return state?.activationUrl ?? googleApiLibraryUrl(service, state?.project ?? fallbackProject);
}

/** The stored state, or null when there is none or it does not read. */
export function readProviderApiState(raw: string | null | undefined): ProviderApiState | null {
    if (!raw) return null;
    try {
        const parsed = providerApiStateSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** The state after one more observation, keeping `since` while it holds. */
export function nextProviderApiState(
    previous: ProviderApiState | null,
    observed:
        | { readonly state: "enabled" }
        | {
              readonly state: "disabled";
              readonly project: string | null;
              readonly activationUrl: string | null;
          },
    now: Date
): ProviderApiState {
    const at = now.toISOString();
    const since = previous?.state === observed.state ? previous.since : at;
    if (observed.state === "enabled")
        return { state: "enabled", project: null, activationUrl: null, since, checkedAt: at };
    return {
        state: "disabled",
        project: observed.project ?? (previous?.state === "disabled" ? previous.project : null),
        activationUrl:
            observed.activationUrl ??
            (previous?.state === "disabled" ? previous.activationUrl : null),
        since,
        checkedAt: at
    };
}
