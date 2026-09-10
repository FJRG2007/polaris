/**
 * How Polaris reaches the management port of a mail server it runs.
 *
 * On this machine, over the host port the service publishes, through the same
 * address the edge dials every deployed service on (`localDialHost`) - the
 * request never leaves the box.
 *
 * On another machine, never over the network in the clear: the request rides an
 * SSH channel forwarded to that machine's own loopback, with the connection and
 * pinned host key Polaris already holds for it. That keeps the administrator's
 * password off the wire and means the management port does not have to be open
 * to anybody at all.
 */

import { prisma } from "@polaris/db";
import { forwardOut } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { localDialHost } from "@/lib/deploy/dial";
import { hostPortForApp } from "@/lib/deploy-service";
import { exchangeOverStream, type HttpAnswer } from "./http1";
import { getHostConnectionUnscoped } from "@/lib/host-service";

/** Where one mail server's management port is. */
export type MailEndpoint =
    | { readonly kind: "local"; readonly host: string; readonly port: number }
    | { readonly kind: "remote"; readonly hostId: string; readonly port: number };

/** Raised when the server cannot be reached at all, as opposed to refusing. */
export class MailServerUnreachable extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MailServerUnreachable";
    }
}

/** The endpoint of the Deploy service a mail server runs as. */
export async function endpointFor(applicationId: string): Promise<MailEndpoint> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { id: true, target: { select: { kind: true, hostId: true } } }
    });
    if (!app) throw new MailServerUnreachable("The mail server's service no longer exists.");
    // A mail server never keeps releases side by side, so its host port is the
    // service's own and not a release's.
    const port = hostPortForApp(app.id);
    if (app.target.kind === "local" || !app.target.hostId) {
        const host = await localDialHost();
        if (!host) throw new MailServerUnreachable("Polaris does not know this machine's address yet.");
        return { kind: "local", host, port };
    }
    return { kind: "remote", hostId: app.target.hostId, port };
}

export interface MailRequest {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
}

/** Send one request to a mail server's management port. */
export async function send(endpoint: MailEndpoint, request: MailRequest): Promise<HttpAnswer> {
    if (endpoint.kind === "local") {
        let response: Response;
        try {
            response = await fetch(`http://${endpoint.host}:${endpoint.port}${request.path}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                cache: "no-store",
                signal: AbortSignal.timeout(20_000)
            });
        } catch {
            throw new MailServerUnreachable("The mail server is not answering on this machine.");
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
            headers[name] = value;
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers, body: bytes.toString("utf8"), bytes };
    }

    const connection = await getHostConnectionUnscoped(endpoint.hostId);
    const lease = await borrowSsh("exec", endpoint.hostId, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    }).catch(() => {
        throw new MailServerUnreachable("Polaris could not reach the server the mail server runs on.");
    });
    try {
        const channel = await forwardOut(lease.client, "127.0.0.1", endpoint.port).catch(() => {
            throw new MailServerUnreachable("The mail server is not answering on its server.");
        });
        return await exchangeOverStream(channel, {
            method: request.method,
            path: request.path,
            host: `127.0.0.1:${endpoint.port}`,
            headers: request.headers,
            body: request.body
        });
    } finally {
        lease.release();
    }
}
