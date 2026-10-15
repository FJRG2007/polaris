/**
 * An integration nobody can get through, and the operator being told about it.
 *
 * The person who presses Connect is never the person who can fix what it hits.
 * They are sent to somebody else's console, refused there for a reason only that
 * console holds, and land back here with a sentence saying the service did not
 * complete the authorization - which is the whole of what this deployment knew.
 * Meanwhile the one account that could act on it, the operator's, hears nothing
 * at all unless that person happens to walk over and say so.
 *
 * So a refusal is recorded against the integration and raised to whoever may
 * configure it, carrying the provider's own words for it. That is the difference
 * between "Epic did not complete the authorization" and "Epic said the client is
 * not authorized for this grant type", and the second one names the switch.
 *
 * Once an hour per service, because a broken application refuses everybody who
 * tries: the first refusal is news and the fortieth is the same news. The record
 * on the integration is written every time regardless - it is what the
 * Integrations screen reads, and it should say what happened last, not what
 * happened the last time an alert was due.
 */

import { prisma } from "@polaris/db";
import { rateLimit } from "@/lib/rate-limit-service";
import { findConnectionProvider } from "@polaris/core";
import { notifyOperators, type OperatorAlert } from "@/lib/notifications/operators";
import {
    getIntegrationState,
    listIntegrationStates,
    upsertIntegration
} from "@/lib/integration-service";

/** Held on the integration's own config, so forgetting the application forgets
 *  its failures with it. */
const FAILURE = "lastFailure";

/** The alert's event, and the plain link alerts raised before they named
 *  their service carried. */
const EVENT = "integration.attention";
const PLAIN_HREF = "/admin/integrations";

/** Where an alert about this service points: its own setup, opened on arrival. */
export function attentionHref(provider: string): string {
    return `${PLAIN_HREF}?configure=${provider}`;
}

/** How often one service may raise this. */
const ALERT_WINDOW_MS = 60 * 60 * 1000;

/** What went wrong the last time somebody tried to authorize. */
export interface ConnectionFailure {
    /** ISO timestamp. */
    at: string;
    /** The provider's reason, as far as it gave one. */
    reason: string;
}

/** The failure held on a stored config, or null when there is none to read. */
export function readConnectionFailure(
    config: Record<string, unknown> | undefined
): ConnectionFailure | null {
    const held = config?.[FAILURE];
    if (!held || typeof held !== "object") return null;
    const { at, reason } = held as Record<string, unknown>;
    if (typeof at !== "string" || typeof reason !== "string") return null;
    return { at, reason };
}

/** What the last authorization failed with, for the screen that configures it. */
export async function connectionFailure(provider: string): Promise<ConnectionFailure | null> {
    return readConnectionFailure((await getIntegrationState(provider))?.config);
}

/**
 * What a caught failure is worth repeating to an operator.
 *
 * Only an Error's message, which every provider module writes deliberately and
 * none of them builds out of a credential. Anything else thrown is something
 * this code did not anticipate, and its shape is not worth guessing at in an
 * alert.
 */
export function describeFailure(caught: unknown): string {
    const message = caught instanceof Error ? caught.message.trim() : "";
    return message || "The service refused the authorization without saying why";
}

/**
 * Record a refusal and tell whoever can act on it. Never throws: it runs on the
 * path that is already handling a failure, and the person waiting on that
 * redirect must still land somewhere. Answers whether the reason was recorded.
 *
 * `notice` replaces the alert's words, for a failure that is not somebody
 * connecting an account - a linked account the provider stopped serving.
 */
export async function recordConnectionFailure(
    provider: string,
    reason: string,
    notice?: Pick<OperatorAlert, "title" | "body" | "say">
): Promise<boolean> {
    let recorded = false;
    try {
        const state = await getIntegrationState(provider);
        // No row means no application: nothing reached the provider, so there is
        // nothing here for an operator to go and fix.
        if (!state) return false;
        await upsertIntegration(provider, {
            config: {
                ...state.config,
                [FAILURE]: { at: new Date().toISOString(), reason } satisfies ConnectionFailure
            }
        });
        recorded = true;

        const throttle = await rateLimit(`integration-attention:${provider}`, 1, ALERT_WINDOW_MS);
        if (!throttle.ok) return recorded;

        const name = findConnectionProvider(provider)?.name ?? provider;
        await notifyOperators({
            permission: "settings.manage",
            event: EVENT,
            // i18n-ignore the fallback; each operator reads `say` in their language
            title: `${name} could not complete an authorization`,
            body: `Somebody tried to connect their ${name} account and it was refused. ${name} said: ${reason}`,
            say: (t) => ({
                title: t("connections.refusedTitle", { name }),
                body: t("connections.refusedBody", { name, reason })
            }),
            ...notice,
            href: attentionHref(provider),
            level: "warning",
            actionRequired: true
        });
    } catch (error) {
        console.error("polaris: could not record the connection failure:", error);
    }
    return recorded;
}

/** Forget the last failure, on an authorization that completed. What it answers
 *  is whether this service needs attention now, and one that just took somebody
 *  all the way through does not. */
export async function clearConnectionFailure(provider: string): Promise<void> {
    try {
        const state = await getIntegrationState(provider);
        if (!state || !readConnectionFailure(state.config)) return;
        const config = { ...state.config };
        delete config[FAILURE];
        await upsertIntegration(provider, { config });
        await answerAlerts(provider);
    } catch (error) {
        console.error("polaris: could not clear the connection failure:", error);
    }
}

/**
 * Read and answer this service's alerts in every operator's bell.
 *
 * The failure is the deployment's, not one reader's, so once it is gone the
 * "Action needed" it raised is answered for all of them - left standing it is a
 * chore nobody can clear because nothing is wrong. Alerts from before they named
 * their service are answered once no service is left needing attention.
 */
async function answerAlerts(provider: string): Promise<void> {
    const stillFailing = [...(await listIntegrationStates()).values()].some(
        (state) => readConnectionFailure(state.config) !== null
    );
    const hrefs = stillFailing ? [attentionHref(provider)] : [attentionHref(provider), PLAIN_HREF];
    await prisma.notification.updateMany({
        where: {
            type: EVENT,
            href: { in: hrefs },
            OR: [{ readAt: null }, { actionRequired: true }]
        },
        data: { readAt: new Date(), actionRequired: false }
    });
}
