/**
 * Sending through a relay (a smarthost) instead of straight to each recipient.
 *
 * A server on a home connection usually cannot send mail itself: most providers
 * block outbound port 25, and receivers distrust residential addresses. A relay
 * - Amazon SES, SendGrid, Mailgun, Postmark, Resend, or any SMTP host - takes the
 * mail on the submission port and delivers it from addresses receivers trust.
 *
 * The engine holds the route: one named `polaris-relay`, and the outbound
 * strategy pointed at it. Clearing the relay removes the route and points the
 * strategy back at the engine's own direct delivery. The setting is kept on the
 * row too, so the screen can show it and the DNS plan can add the provider to
 * the SPF record; the password is sealed and never sent back to a browser.
 */

import { z } from "zod";
import { call } from "./stalwart";
import { reached } from "./steps";
import * as core from "@polaris/core";
import { endpointFor } from "./transport";
import { recordAudit } from "@/lib/audit-service";
import { prisma, type MailServer } from "@polaris/db";
import { adminCredentials, MailServerAccessError, seal, unseal } from "./access";

export interface RelaySetting {
    readonly provider: core.RelayProviderId;
    readonly host: string;
    readonly region: string;
    readonly port: number;
    readonly username: string;
    /** Whether a password is held; the password itself never leaves the server. */
    readonly hasSecret: boolean;
}

const storedRelaySchema = z.object({
    provider: z.enum(core.RELAY_PROVIDER_IDS),
    host: z.string().catch(""),
    region: z.string().catch(""),
    port: z.number().int().catch(587),
    username: z.string().catch("")
});

/** The relay the row records, or null when mail goes out directly. */
export function storedRelay(server: MailServer): RelaySetting | null {
    if (!server.relay) return null;
    try {
        const parsed = storedRelaySchema.safeParse(JSON.parse(server.relay));
        if (!parsed.success) return null;
        return { ...parsed.data, hasSecret: Boolean(server.relaySecret) };
    } catch {
        return null;
    }
}

/** The SPF mechanism the relay's provider needs, or null for none or a custom host. */
export function relaySpfInclude(server: MailServer): string | null {
    const relay = storedRelay(server);
    if (!relay) return null;
    const include = core.relayProvider(relay.provider).spfInclude;
    return include || null;
}

async function engine(server: MailServer) {
    if (!server.applicationId || !reached(server.step, "admin")) {
        throw new MailServerAccessError("This mail server is still being set up.");
    }
    return {
        endpoint: await endpointFor(server.applicationId),
        credentials: adminCredentials(server)
    };
}

/** Remove the relay route the engine has, if it has one. */
async function dropRoute(server: MailServer): Promise<void> {
    const { endpoint, credentials } = await engine(server);
    const routes = core.listOfAnswer<{ id: string; name?: string }>(
        await call(endpoint, credentials, core.routeListCall()),
        "routes"
    );
    for (const route of routes.filter((one) => one.name === core.RELAY_ROUTE_NAME)) {
        core.assertApplied(
            await call(endpoint, credentials, [core.routeDestroyCall(route.id)]),
            "destroy",
            route.id
        );
    }
}

/**
 * Send through a relay, or - with `provider: null` - directly again.
 *
 * The order keeps mail moving: the strategy is pointed back at direct delivery
 * before the old route goes, the new route is created, and only then is the
 * strategy pointed at it. A refusal half way leaves mail going out directly,
 * never at a route that does not exist.
 */
export async function setRelay(
    actorId: string,
    server: MailServer,
    input: core.MailRelayInput
): Promise<void> {
    const { endpoint, credentials } = await engine(server);
    core.assertApplied(
        await call(endpoint, credentials, [core.outboundRouteCall(core.DIRECT_ROUTE_NAME)]),
        "strategy",
        "singleton"
    );
    await dropRoute(server);

    if (input.provider === null) {
        await prisma.mailServer.update({
            where: { id: server.id },
            data: { relay: "", relaySecret: null, relaySecretNonce: null, relaySecretKeyId: null }
        });
        await recordAudit({
            actorId,
            action: "mailserver.relay.clear",
            targetType: "mail-server",
            targetId: server.id,
            orgId: server.orgId ?? undefined
        });
        return;
    }

    const provider = input.provider;
    const host = core.resolveRelayHost({ provider, host: input.host, region: input.region });
    if (!host) throw new MailServerAccessError("Enter the relay's SMTP host.");
    const typed = input.secret.trim();
    const stored = unseal(server.relaySecret, server.relaySecretNonce, server.relaySecretKeyId);
    const secret = typed || stored || "";
    if (!secret) throw new MailServerAccessError("Enter the relay's password or API key.");
    const username = input.username || core.relayProvider(provider).username;
    if (!username) throw new MailServerAccessError("Enter the relay's username.");

    core.createdId(
        await call(endpoint, credentials, [
            core.relayRouteCreateCall({
                host,
                port: input.port,
                implicitTls: input.port === 465,
                username,
                secret
            })
        ]),
        "route",
        "relay"
    );
    core.assertApplied(
        await call(endpoint, credentials, [core.outboundRouteCall(core.RELAY_ROUTE_NAME)]),
        "strategy",
        "singleton"
    );

    const sealed = typed ? seal(typed) : null;
    await prisma.mailServer.update({
        where: { id: server.id },
        data: {
            relay: JSON.stringify({
                provider,
                host,
                region: input.region,
                port: input.port,
                username
            }),
            ...(sealed
                ? {
                      relaySecret: sealed.ciphertext,
                      relaySecretNonce: sealed.nonce,
                      relaySecretKeyId: sealed.keyId
                  }
                : {})
        }
    });
    await recordAudit({
        actorId,
        action: "mailserver.relay.set",
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined,
        metadata: { provider, host }
    });
}
