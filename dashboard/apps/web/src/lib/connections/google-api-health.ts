/**
 * Whether each Google API Polaris calls is switched on in the Cloud project of
 * the operator's OAuth client - asked on the Integrations screen, where the
 * person who can switch it on is looking, instead of found later by somebody
 * whose calendar never fills.
 *
 * Google answers that question only to a signed-in call: there is no way to ask
 * with the client id and secret alone. So each API is asked once with a token
 * some account here already granted for it - the reader's own first - for the
 * cheapest read it serves (`fields=kind`, nothing of the person's data). Until an
 * account has granted that API, the answer is "not checked yet".
 *
 * Bounded: one token and one request per API, at most every ten minutes unless
 * the reader asks again, and never two at once. The answer is kept in the
 * `Setting` table the Calendar's sync writes too, so whichever learns first,
 * both screens say the same thing - and when an API that was off answers again,
 * every calendar waiting on it is retried at once.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { readCredential } from "@/lib/connections/store";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getGoogleOAuthClient, googleAccessToken } from "@/lib/google-calendar/service";

/** An answer younger than this is shown without asking Google again. */
const FRESH_MS = 10 * 60_000;
/** Asking again on request is still not asking more often than this. */
const FORCED_GAP_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface GoogleApiHealth {
    readonly id: core.GoogleApiId;
    readonly title: string;
    readonly service: string;
    /** `unknown`: no account here has granted this API yet, or Google did not say. */
    readonly state: "enabled" | "disabled" | "unknown";
    readonly project: string | null;
    /** The API's page in the console: Google's own activation link when it is
     *  off and gave one, else the library page on the client's project. */
    readonly url: string;
    readonly checkedAt: string | null;
}

type Api = (typeof core.GOOGLE_APIS)[number];

/** A token some account here granted for this API, the reader's own first. */
async function tokenFor(api: Api, readerId: string): Promise<string | null> {
    const client = await getGoogleOAuthClient();
    if (!client) return null;
    const where = {
        provider: "google",
        method: "oauth",
        scope: { contains: api.scope },
        encryptedToken: { not: null },
        healthNotice: ""
    };
    const link =
        (await prisma.userConnection.findFirst({
            where: { ...where, userId: readerId },
            select: { id: true }
        })) ??
        (await prisma.userConnection.findFirst({
            where,
            orderBy: { updatedAt: "desc" },
            select: { id: true }
        }));
    if (!link) return null;
    const refreshToken = (await readCredential(link.id))?.refreshToken;
    if (!refreshToken) return null;
    return googleAccessToken(client, refreshToken).catch(() => null);
}

/** What Google says about one API right now, or null when it could not be asked. */
async function probe(
    api: Api,
    readerId: string
): Promise<core.ProviderApiProblem | { kind: "enabled" } | null> {
    const token = await tokenFor(api, readerId);
    if (!token) return null;
    let response: Response;
    try {
        response = await fetch(api.probe, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            cache: "no-store"
        });
    } catch {
        return null;
    }
    if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "enabled" };
    }
    const body: unknown = await response
        .text()
        .then((text) => JSON.parse(text.slice(0, 64 * 1024)) as unknown)
        .catch(() => null);
    return core.readGoogleApiError(response.status, body);
}

async function stored(api: Api): Promise<core.ProviderApiState | null> {
    return core.readProviderApiState(await getSetting(core.googleApiStateKey(api.id)));
}

/** Ask Google about one API and keep the answer; the previous one when it would not say. */
async function refresh(
    api: Api,
    readerId: string,
    now: Date
): Promise<core.ProviderApiState | null> {
    const previous = await stored(api);
    const answer = await probe(api, readerId);
    let next: core.ProviderApiState | null = null;
    if (answer?.kind === "enabled")
        next = core.nextProviderApiState(previous, { state: "enabled" }, now);
    else if (answer?.kind === "setup")
        next = core.nextProviderApiState(
            previous,
            { state: "disabled", project: answer.project, activationUrl: answer.activationUrl },
            now
        );
    if (!next) return previous;
    await setSetting(core.googleApiStateKey(api.id), JSON.stringify(next));
    if (api.id === "calendar" && previous?.state === "disabled" && next.state === "enabled") {
        // The calendars waiting on it are tried on the next sync pass rather than
        // at the end of their growing gap.
        await prisma.calendarSource.updateMany({
            where: { kind: "google", status: "setup", nextSyncAt: { gt: now } },
            data: { nextSyncAt: now }
        });
    }
    return next;
}

let running: Promise<GoogleApiHealth[]> | null = null;

/**
 * Every API's state. Asks Google only for an answer older than ten minutes, or
 * on `force` for one older than twenty seconds; one check at a time per process.
 */
export function googleApiHealth(readerId: string, force = false): Promise<GoogleApiHealth[]> {
    running ??= check(readerId, force).finally(() => {
        running = null;
    });
    return running;
}

async function check(readerId: string, force: boolean): Promise<GoogleApiHealth[]> {
    const now = new Date();
    const client = await getGoogleOAuthClient();
    const clientProject = client ? core.projectFromGoogleClientId(client.clientId) : null;
    return Promise.all(
        core.GOOGLE_APIS.map(async (api) => {
            let state = await stored(api);
            const age = state ? now.getTime() - Date.parse(state.checkedAt) : Infinity;
            if (age > (force ? FORCED_GAP_MS : FRESH_MS)) state = await refresh(api, readerId, now);
            const project = state?.project ?? clientProject;
            return {
                id: api.id,
                title: api.title,
                service: api.service,
                state: state?.state ?? "unknown",
                project,
                url:
                    state?.state === "disabled"
                        ? core.googleApiEnableUrl(api.service, state, clientProject)
                        : core.googleApiLibraryUrl(api.service, project),
                checkedAt: state?.checkedAt ?? null
            };
        })
    );
}
