/**
 * Whether a mail server is well: the engine answering and managed, the mail
 * waiting to go, the ports the world uses to reach it, and the certificate a
 * mail app is shown.
 *
 * The ports are knocked on the way the world would: at the address the mail
 * name resolves to on a public resolver, not at the container. A port that is
 * open inside and closed at the router is the one fault an operator cannot see
 * from anywhere else. What a knock proves is decided by `portVerdict` - only an
 * answer is proof, and a silent 25 is unverified, never failed.
 */

import { z } from "zod";
import { reached } from "./steps";
import * as core from "@polaris/core";
import { adminCredentials } from "./access";
import { Resolver } from "node:dns/promises";
import { queuedMessages } from "./operations";
import { connect as tlsConnect } from "node:tls";
import { call, engineAnswers } from "./stalwart";
import { prisma, type MailServer } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { detectPublicIp } from "@/lib/network-service";
import { endpointFor, MailServerUnreachable } from "./transport";
import { probeTcpOutcome, publicProbeHost } from "@/lib/net/port-probe";

export interface EngineHealth {
    /** The engine's web listener answered. */
    readonly answers: boolean;
    /** Polaris's administrator account was accepted. */
    readonly managed: boolean;
    /** Messages waiting to go out, or null when unknown. */
    readonly queued: number | null;
    readonly note: string | null;
}

export interface PortCheck {
    readonly port: number;
    readonly label: string;
    readonly purpose: string;
    readonly required: boolean;
    readonly outcome: core.PortOutcome;
    readonly verdict: core.PortVerdict;
    readonly note: string | null;
}

export interface PortReport {
    readonly at: string;
    /** The address knocked on, or null when there was none to knock on. */
    readonly address: string | null;
    readonly results: readonly PortCheck[];
    readonly note: string | null;
}

export interface CertificateCheck {
    readonly verdict: "pass" | "warn" | "fail" | "unverified";
    readonly issuer: string | null;
    readonly expiresAt: string | null;
    readonly note: string | null;
}

export interface MailHealth {
    readonly engine: EngineHealth;
    readonly ports: PortReport;
    readonly certificate: CertificateCheck;
}

const TLS_TIMEOUT_MS = 8000;

/** Certificates this close to their end are worth a warning. */
const EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

export async function engineHealth(server: MailServer): Promise<EngineHealth> {
    if (!server.applicationId) {
        return { answers: false, managed: false, queued: null, note: "The mail server's service is missing. Repair it from the start." };
    }
    let endpoint;
    try {
        endpoint = await endpointFor(server.applicationId);
    } catch (error) {
        return {
            answers: false,
            managed: false,
            queued: null,
            note: error instanceof MailServerUnreachable ? error.message : "The mail server could not be reached."
        };
    }
    const answers = await engineAnswers(endpoint).catch(() => false);
    if (!answers) {
        return { answers, managed: false, queued: null, note: "The mail server is not answering. It may be stopped or restarting." };
    }
    if (!reached(server.step, "admin")) {
        return { answers, managed: false, queued: null, note: "Setup has not finished yet." };
    }
    const managed = await call(endpoint, adminCredentials(server), [["x:Domain/query", {}, "q"]])
        .then((response) => {
            core.answerOf(response, "q");
            return true;
        })
        .catch(() => false);
    if (!managed) {
        return {
            answers,
            managed,
            queued: null,
            note: "The mail server no longer accepts Polaris's administrator account. Repair it from the administrator step."
        };
    }
    return { answers, managed, queued: await queuedMessages(server), note: null };
}

/** Where the world reaches the server: the mail name on a public resolver,
 *  else the machine's own address. */
async function publicAddress(server: MailServer): Promise<string | null> {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const resolved = await resolver.resolve4(server.hostname).catch(() => [] as string[]);
    if (resolved[0]) return resolved[0];
    if (server.placement === "local") return publicProbeHost();
    const host = await prisma.host.findUnique({ where: { id: server.placement }, select: { address: true } });
    return host && core.isPublicIpv4(host.address) ? host.address : null;
}

export async function checkPorts(server: MailServer): Promise<PortReport> {
    const address = await publicAddress(server);
    const at = new Date().toISOString();
    if (!address) {
        const report: PortReport = {
            at,
            address: null,
            results: [],
            note: `${server.hostname} does not resolve yet, and this network has no public address to check instead. Publish its DNS records first.`
        };
        await store(server.id, report);
        return report;
    }
    const ownIp = await detectPublicIp().catch(() => null);
    const throughOwnRouter = ownIp === address;
    const results = await Promise.all(
        core.MAIL_SERVER_PORTS.map(async (entry) => {
            const outcome = await probeTcpOutcome(address, entry.port);
            const { verdict, note } = core.portVerdict(entry.port, outcome, throughOwnRouter);
            return { port: entry.port, label: entry.label, purpose: entry.purpose, required: entry.required, outcome, verdict, note };
        })
    );
    const report: PortReport = { at, address, results, note: null };
    await store(server.id, report);
    return report;
}

async function store(serverId: string, report: PortReport): Promise<void> {
    await prisma.mailServer.update({ where: { id: serverId }, data: { lastPorts: JSON.stringify(report) } });
}

/** The certificate a mail app sees on the submission port, checked the way a
 *  mail app checks it: against the mail name, by the system's trust store. */
export function checkCertificate(hostname: string, address: string | null): Promise<CertificateCheck> {
    if (!address) {
        return Promise.resolve({ verdict: "unverified", issuer: null, expiresAt: null, note: "There is no address to check it at yet." });
    }
    return new Promise((resolve) => {
        const socket = tlsConnect({ host: address, port: 465, servername: hostname, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS });
        const settle = (check: CertificateCheck): void => {
            socket.destroy();
            resolve(check);
        };
        socket.once("secureConnect", () => {
            const certificate = socket.getPeerCertificate();
            const issuer = certificate.issuer ? (certificate.issuer.O ?? certificate.issuer.CN ?? null) : null;
            const expires = certificate.valid_to ? new Date(certificate.valid_to) : null;
            const expiresAt = expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : null;
            if (!socket.authorized) {
                settle({
                    verdict: "fail",
                    issuer: typeof issuer === "string" ? issuer : null,
                    expiresAt,
                    note: `Mail apps will refuse this certificate (${String(socket.authorizationError ?? "not trusted")}). It is usually the engine's own until its certificate for ${hostname} is issued.`
                });
                return;
            }
            const soon = expires ? expires.getTime() - Date.now() < EXPIRY_WARN_MS : false;
            settle({
                verdict: soon ? "warn" : "pass",
                issuer: typeof issuer === "string" ? issuer : null,
                expiresAt,
                note: soon ? "The certificate expires within two weeks and has not been renewed yet." : null
            });
        });
        socket.once("timeout", () =>
            settle({ verdict: "unverified", issuer: null, expiresAt: null, note: "Port 465 did not answer, so the certificate could not be read." })
        );
        socket.once("error", () =>
            settle({ verdict: "unverified", issuer: null, expiresAt: null, note: "Port 465 did not complete a secure connection." })
        );
    });
}

/** Everything at once, for the Overview. */
export async function mailHealth(server: MailServer): Promise<MailHealth> {
    const [engine, ports] = await Promise.all([engineHealth(server), checkPorts(server)]);
    const certificate = await checkCertificate(server.hostname, ports.address);
    return { engine, ports, certificate };
}

/**
 * The scheduled look at every running server: one that stopped answering is
 * marked down and its owner told once; one that answers again is marked ready
 * and they are told that too. A server still being set up is setup's business.
 */
export async function sweepMailServers(): Promise<{ checked: number; changed: number }> {
    const servers = await prisma.mailServer.findMany({ where: { status: { in: ["ready", "down"] } } });
    let changed = 0;
    for (const server of servers) {
        const engine = await engineHealth(server);
        const up = engine.answers && engine.managed;
        const status = up ? "ready" : "down";
        if (status === server.status) continue;
        changed += 1;
        await prisma.mailServer.update({ where: { id: server.id }, data: { status } });
        await notify({
            userId: server.ownerId,
            event: "mailserver.attention",
            level: up ? "success" : "warning",
            title: up ? `${server.hostname} is answering again` : `${server.hostname} stopped answering`,
            body: up ? null : (engine.note ?? "The mail server is not answering."),
            href: `/apps/mail-server/${server.id}`
        });
    }
    return { checked: servers.length, changed };
}

/** The last port check, as it was stored. */
export function storedPorts(server: MailServer): PortReport | null {
    if (!server.lastPorts) return null;
    try {
        const parsed = storedPortsSchema.safeParse(JSON.parse(server.lastPorts));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** A stored check is older than this code; one that no longer reads is dropped
 *  and the next check writes it again. */
const storedPortsSchema = z.object({
    at: z.string(),
    address: z.string().nullable(),
    note: z.string().nullable().catch(null),
    results: z.array(
        z.object({
            port: z.number(),
            label: z.string(),
            purpose: z.string().catch(""),
            required: z.boolean().catch(false),
            outcome: z.enum(["open", "refused", "timeout", "error"]),
            verdict: z.enum(["pass", "warn", "fail", "unverified"]),
            note: z.string().nullable().catch(null)
        })
    )
});
