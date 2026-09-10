/**
 * Setting a mail server up, one resumable step at a time.
 *
 * The engine runs as an ordinary Deploy service, so everything Deploy already
 * does for a service - the queue, the log, the registry, the ports, the volumes,
 * the edge route for its web address - is what brings it up, and the operator
 * can open it there like any other. What this adds is the part only a mail
 * server has: leaving the engine's bootstrap mode, making the account Polaris
 * manages it with, taking the setup credential back out, wiring incoming-mail
 * events, and making Polaris able to send its own mail through it.
 *
 * Each step is safe to run twice and records itself when it finishes, so a
 * setup that stopped half way (a restart, a port somebody else holds) resumes
 * from where it was, and "repair" is the same run from an earlier step. The run
 * is in the background: the screen reads `log` and `step` back while it goes.
 *
 * The engine is never deployed onto a swarm. Swarm publishes ports through its
 * ingress mesh, which hides the address every incoming connection came from - and
 * a mail server needs that address for its spam filter, its sender checks and
 * its rate limits. A server whose deploys go through a swarm is refused, by name.
 */

import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { appBaseUrl } from "@/lib/domain-service";
import { recordAudit } from "@/lib/audit-service";
import { prisma, type MailServer } from "@polaris/db";
import { createEmailChannel } from "@/lib/mail-service";
import { createVolume } from "@/lib/deploy-volume-service";
import { deleteEnvVar, listEnvVars, setEnvVar } from "@/lib/env-var-service";
import { RECOVERY_USERNAME, seal, unseal, type MailServerActor } from "./access";
import { ensureReportsMailbox } from "./dmarc-report";
import { endpointFor, MailServerUnreachable, type MailEndpoint } from "./transport";
import { call, engineAnswers, forgetEndpoint, type StalwartCredentials } from "./stalwart";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { nextStep, reached, SETUP_STEP_LABELS, SETUP_STEPS, type SetupStep } from "./steps";
import { addApplicationDomain, createApplication, createProject, deployAndWait } from "@/lib/deploy-service";

/** A step that cannot go on, in words the operator can act on. */
export class MailSetupRefusal extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MailSetupRefusal";
    }
}

/** The environment variable the engine reads its recovery administrator from. */
const RECOVERY_ENV = "STALWART_RECOVERY_ADMIN";

/** How long the engine is given to come up, or to come back after a restart. */
const ENGINE_WAIT_MS = 4 * 60_000;
const ENGINE_POLL_MS = 3000;

/** The most of the setup log a row keeps. */
const LOG_LIMIT = 20_000;

/** Runs in this process, so two clicks cannot start two runs of one server. */
const running = new Set<string>();

function generatedSecret(): string {
    return randomBytes(24).toString("base64url");
}

async function appendLog(serverId: string, line: string): Promise<void> {
    const row = await prisma.mailServer.findUnique({ where: { id: serverId }, select: { log: true } });
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}\n`;
    await prisma.mailServer.update({
        where: { id: serverId },
        data: { log: `${row?.log ?? ""}${stamped}`.slice(-LOG_LIMIT) }
    });
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `ready` says yes, or give up with the sentence given. */
async function waitUntil(ready: () => Promise<boolean>, failure: string): Promise<void> {
    const deadline = Date.now() + ENGINE_WAIT_MS;
    while (Date.now() < deadline) {
        if (await ready().catch(() => false)) return;
        await sleep(ENGINE_POLL_MS);
    }
    throw new MailSetupRefusal(failure);
}

/** Whether a credential is accepted for management, which is also how normal
 *  mode is told apart from bootstrap mode: a domain query only works in it. */
async function managementWorks(endpoint: MailEndpoint, credentials: StalwartCredentials): Promise<boolean> {
    forgetEndpoint(endpoint);
    const response = await call(endpoint, credentials, [["x:Domain/query", {}, "q"]]);
    core.answerOf(response, "q");
    return true;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * Start setting a server up: check where it is to run, record it, and begin the
 * run in the background. Answers the row at once; the screen follows the log.
 */
export async function startSetup(
    actor: MailServerActor,
    input: core.MailServerSetup,
    shelfOrgId: string | null
): Promise<MailServer> {
    const ownerId = actor.id;
    const placement = input.serverId === "local" ? "local" : input.serverId;
    if (placement !== "local") {
        const host = await prisma.host.findFirst({ where: { id: placement, ownerId }, select: { id: true } });
        if (!host) throw new MailSetupRefusal("That server was not found among yours.");
        const target = await prisma.deployTarget.findFirst({
            where: { ownerId, kind: "host", hostId: placement },
            select: { runtime: true }
        });
        if (target?.runtime === "swarm") {
            throw new MailSetupRefusal(
                "That server deploys through a swarm, which hides the address every incoming connection comes from. A mail server needs it for spam filtering and sender checks, so choose a server that runs plain containers."
            );
        }
    }
    const taken = await prisma.mailServer.findFirst({ where: { hostname: input.hostname }, select: { id: true } });
    if (taken) throw new MailSetupRefusal(`${input.hostname} already has a mail server here.`);

    const admin = seal(generatedSecret());
    const hook = seal(generatedSecret());
    const row = await prisma.mailServer.create({
        data: {
            ownerId,
            orgId: shelfOrgId,
            placement,
            hostname: input.hostname,
            primaryDomain: input.domain,
            adminSecret: admin.ciphertext,
            adminSecretNonce: admin.nonce,
            adminSecretKeyId: admin.keyId,
            hookSecret: hook.ciphertext,
            hookSecretNonce: hook.nonce,
            hookSecretKeyId: hook.keyId
        }
    });
    await recordAudit({
        actorId: actor.id,
        action: "mailserver.create",
        targetType: "mail-server",
        targetId: row.id,
        orgId: shelfOrgId ?? undefined
    });
    void runSetup(row.id, actor.id);
    return row;
}

/**
 * Run setup again: from where it stopped, or - for a repair - from an earlier
 * step, which puts the service back, redeploys it and checks every credential
 * and connection after it again.
 */
export async function resumeSetup(actor: MailServerActor, server: MailServer, from?: SetupStep): Promise<void> {
    if (running.has(server.id)) return;
    const restartAt = from ? SETUP_STEPS.indexOf(from) : -1;
    const recorded = restartAt > 0 ? SETUP_STEPS[restartAt - 1] : restartAt === 0 ? "" : server.step;
    await prisma.mailServer.update({
        where: { id: server.id },
        data: { step: recorded, status: "setting-up", error: null }
    });
    await recordAudit({
        actorId: actor.id,
        action: from ? "mailserver.repair" : "mailserver.resume",
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined
    });
    void runSetup(server.id, actor.id);
}

/** Whether a run for this server is going on in this process. */
export function isRunning(serverId: string): boolean {
    return running.has(serverId);
}

async function runSetup(serverId: string, userId: string): Promise<void> {
    if (running.has(serverId)) return;
    running.add(serverId);
    try {
        for (;;) {
            const server = await prisma.mailServer.findUnique({ where: { id: serverId } });
            if (!server) return;
            const step = nextStep(server.step);
            if (step === "done" && reached(server.step, "reports")) {
                await prisma.mailServer.update({ where: { id: serverId }, data: { step: "done", status: "ready" } });
                await appendLog(serverId, "The mail server is ready.");
                return;
            }
            await appendLog(serverId, `${SETUP_STEP_LABELS[step]}...`);
            await STEPS[step](server, userId);
            await prisma.mailServer.update({ where: { id: serverId }, data: { step } });
        }
    } catch (error) {
        const said =
            error instanceof MailSetupRefusal || error instanceof MailServerUnreachable || error instanceof core.StalwartRefusal
                ? error.message
                : "Setup stopped on something unexpected. Run it again to resume from here.";
        if (!(error instanceof MailSetupRefusal)) console.error("polaris: mail server setup failed:", error);
        await prisma.mailServer.update({ where: { id: serverId }, data: { status: "failed", error: said } });
        await appendLog(serverId, `Stopped: ${said}`);
    } finally {
        running.delete(serverId);
    }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

type StepRunner = (server: MailServer, userId: string) => Promise<void>;

function adminPassword(server: MailServer): string {
    const password = unseal(server.adminSecret, server.adminSecretNonce, server.adminSecretKeyId);
    if (!password) throw new MailSetupRefusal("The administrator credential is missing. Remove this server and set it up again.");
    return password;
}

/** The administrator account setup creates, by its address. */
function ownCredentials(server: MailServer): StalwartCredentials {
    return { username: `${core.MAIL_ADMIN_NAME}@${server.primaryDomain}`, password: adminPassword(server) };
}

function recoveryCredentials(server: MailServer): StalwartCredentials {
    return { username: RECOVERY_USERNAME, password: adminPassword(server) };
}

function requireService(server: MailServer): string {
    if (!server.applicationId) throw new MailSetupRefusal("The mail server's service is missing. Repair from the start.");
    return server.applicationId;
}

/** The Deploy service: a project of its own, the engine image, the mail ports
 *  published as themselves, the configuration and data volumes, the setup
 *  credential and the web address. */
const service: StepRunner = async (server) => {
    const existing = server.applicationId
        ? await prisma.application.findUnique({ where: { id: server.applicationId }, select: { id: true } })
        : null;
    if (existing) {
        // A repair from the start: the setup credential goes back in, so the
        // steps after this can reach the engine however its own account fares,
        // and `recovery-off` takes it out again once that account is proved.
        await setEnvVar("application", existing.id, server.ownerId, {
            key: RECOVERY_ENV,
            value: `${RECOVERY_USERNAME}:${adminPassword(server)}`,
            isSecret: true
        });
        return;
    }

    const ownerId = server.ownerId;
    let target;
    if (server.placement === "local") {
        target = await getOrCreateLocalTarget(ownerId);
    } else {
        const host = await prisma.host.findFirst({ where: { id: server.placement, ownerId }, select: { id: true, name: true } });
        if (!host) throw new MailSetupRefusal("The server this was to run on is no longer connected.");
        target = await getOrCreateHostTarget(host.id, ownerId, host.name, "compose");
        if (target.runtime === "swarm") {
            throw new MailSetupRefusal("That server deploys through a swarm, which a mail server cannot run behind.");
        }
    }

    const project = await createProject(ownerId, `Mail ${server.hostname}`, server.orgId);
    const environment = project.environments[0];
    if (!environment) throw new MailSetupRefusal("The mail server's project has no environment.");
    const app = await createApplication(ownerId, {
        environmentId: environment.id,
        targetId: target.id,
        name: "Mail server",
        sourceType: "image",
        sourceConfig: {
            imageRef: core.STALWART_IMAGE,
            port: core.STALWART_HTTP_PORT,
            // Published as themselves: another mail server knocks on 25 and a
            // mail app on 465 and 993, and no other number would be found.
            extraPorts: core.MAIL_SERVER_PORTS.map((entry) => ({ host: entry.port, container: entry.port }))
        },
        autoDeploy: false,
        keepReleases: false
    });
    await prisma.mailServer.update({ where: { id: server.id }, data: { applicationId: app.id } });

    await createVolume(ownerId, {
        applicationId: app.id,
        name: "stalwart-config",
        mountPath: core.STALWART_CONFIG_PATH,
        kind: "volume"
    });
    await createVolume(ownerId, {
        applicationId: app.id,
        name: "stalwart-data",
        mountPath: core.STALWART_DATA_PATH,
        kind: "volume"
    });
    await setEnvVar("application", app.id, ownerId, {
        key: RECOVERY_ENV,
        value: `${RECOVERY_USERNAME}:${adminPassword(server)}`,
        isSecret: true
    });
    await setEnvVar("application", app.id, ownerId, {
        key: "STALWART_PUBLIC_URL",
        value: `https://${server.hostname}`,
        isSecret: false
    });
    // The web address mail apps and the engine's own certificate request use.
    // Best-effort: a name already routed elsewhere is said in the log, and mail
    // still flows on its own ports.
    await addApplicationDomain(app.id, ownerId, {
        hostname: server.hostname,
        targetPort: core.STALWART_HTTP_PORT,
        cert: "le"
    }).catch(async (error: unknown) => {
        await appendLog(server.id, `The web address was not routed: ${error instanceof Error ? error.message : "unknown"}`);
    });
};

const deploy: StepRunner = async (server, userId) => {
    const reason = await deployAndWait(requireService(server), server.ownerId, userId);
    if (reason) throw new MailSetupRefusal(`The mail server did not start: ${reason}`);
};

/** Leave bootstrap mode, unless the engine already has. */
const bootstrap: StepRunner = async (server) => {
    const endpoint = await endpointFor(requireService(server));
    await waitUntil(() => engineAnswers(endpoint), "The mail server did not start answering.");
    // Already in normal service and managed by Polaris's own account: a repair
    // that got here has nothing to name.
    if (await managementWorks(endpoint, ownCredentials(server)).catch(() => false)) return;
    const credentials = recoveryCredentials(server);

    forgetEndpoint(endpoint);
    let inBootstrap = true;
    try {
        core.answerOf(await call(endpoint, credentials, [["x:Bootstrap/get", { ids: ["singleton"] }, "get"]]), "get");
    } catch {
        // Only bootstrap mode serves the Bootstrap object: an engine that
        // refuses it has already been through this step.
        inBootstrap = false;
    }
    if (inBootstrap) {
        const response = await call(endpoint, credentials, [
            core.bootstrapCall({ hostname: server.hostname, domain: server.primaryDomain })
        ]);
        core.assertApplied(response, "bootstrap", "singleton");
        await appendLog(server.id, "The engine is restarting into normal service.");
    }
    await waitUntil(
        () => managementWorks(endpoint, credentials),
        "The mail server did not come back after naming itself."
    );
};

/** Polaris's own administrator: an Admin account at the first domain, with the
 *  sealed password - reset if it already exists, so it is always the one held. */
const admin: StepRunner = async (server) => {
    const endpoint = await endpointFor(requireService(server));
    // The setup credential while it is in the container; Polaris's own account
    // on a repair that started after it was taken out.
    const credentials = (await managementWorks(endpoint, recoveryCredentials(server)).catch(() => false))
        ? recoveryCredentials(server)
        : ownCredentials(server);
    const domains = core.listOfAnswer<{ id: string; name: string }>(
        await call(endpoint, credentials, core.domainListCalls()),
        "domains"
    );
    let domainId = domains.find((domain) => domain.name === server.primaryDomain)?.id;
    if (!domainId) {
        domainId = core.createdId(
            await call(endpoint, credentials, [core.domainCreateCall(server.primaryDomain)]),
            "domain",
            "domain"
        );
    }
    const accounts = core.listOfAnswer<{ id: string; name: string; domainId: string }>(
        await call(endpoint, credentials, core.accountListCalls()),
        "accounts"
    );
    const existing = accounts.find((account) => account.name === core.MAIL_ADMIN_NAME && account.domainId === domainId);
    if (existing) {
        core.assertApplied(
            await call(endpoint, credentials, [core.accountPasswordCall(existing.id, adminPassword(server))]),
            "password",
            existing.id
        );
    } else {
        core.createdId(
            await call(endpoint, credentials, [
                core.accountCreateCall({
                    name: core.MAIL_ADMIN_NAME,
                    domainId,
                    password: adminPassword(server),
                    quotaBytes: null,
                    admin: true,
                    description: "Polaris manages this mail server with this account."
                })
            ]),
            "account",
            "account"
        );
    }
    // Proved before the setup credential is taken away in the next step.
    const own = ownCredentials(server);
    await waitUntil(() => managementWorks(endpoint, own), "The mail server did not accept Polaris's administrator account.");
};

/** Take the setup credential back out of the container, restart, and prove the
 *  administrator account still works. If it does not, the credential is put
 *  back so the server is never left unmanageable. */
const recoveryOff: StepRunner = async (server, userId) => {
    const appId = requireService(server);
    const vars = await listEnvVars("application", appId, server.ownerId);
    const recovery = vars.find((variable) => variable.key === RECOVERY_ENV);
    if (!recovery) return;
    await deleteEnvVar(recovery.id, server.ownerId);
    const reason = await deployAndWait(appId, server.ownerId, userId);
    const endpoint = await endpointFor(appId);
    const own = ownCredentials(server);
    const works = reason
        ? false
        : await waitUntil(() => managementWorks(endpoint, own), "").then(
              () => true,
              () => false
          );
    if (!works) {
        await setEnvVar("application", appId, server.ownerId, {
            key: RECOVERY_ENV,
            value: `${RECOVERY_USERNAME}:${adminPassword(server)}`,
            isSecret: true
        });
        await deployAndWait(appId, server.ownerId, userId);
        throw new MailSetupRefusal(
            "After the restart the mail server did not accept Polaris's administrator account, so the setup credential was put back. Run setup again."
        );
    }
};

/** Ask the engine to post incoming-mail events to Polaris, signed. */
const webhook: StepRunner = async (server) => {
    const endpoint = await endpointFor(requireService(server));
    const credentials = ownCredentials(server);
    const url = `${(await appBaseUrl()).replace(/\/$/, "")}/api/mail-server/${server.id}/events`;
    const listed = await call(endpoint, credentials, [
        ["x:WebHook/query", {}, "q"],
        ["x:WebHook/get", { "#ids": { resultOf: "q", name: "x:WebHook/query", path: "/ids" }, properties: ["id", "url"] }, "hooks"]
    ]);
    if (core.listOfAnswer<{ url?: string }>(listed, "hooks").some((hook) => hook.url === url)) return;
    const secret = unseal(server.hookSecret, server.hookSecretNonce, server.hookSecretKeyId);
    if (!secret) throw new MailSetupRefusal("The event signing key is missing. Remove this server and set it up again.");
    core.createdId(await call(endpoint, credentials, [core.webhookCreateCall(url, secret)]), "webhook", "hook");
    if (server.placement !== "local" && /\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url)) {
        await appendLog(
            server.id,
            `Polaris is at ${url.split("/api/")[0]}, which the mail server's machine may not reach. Rules on incoming mail only fire once it can.`
        );
    }
};

/** Polaris's own sending mailbox, and the email channel that sends through it. */
const sender: StepRunner = async (server) => {
    if (server.channelId && (await prisma.channel.findUnique({ where: { id: server.channelId }, select: { id: true } }))) return;
    const endpoint = await endpointFor(requireService(server));
    const credentials = ownCredentials(server);
    const domains = core.listOfAnswer<{ id: string; name: string }>(await call(endpoint, credentials, core.domainListCalls()), "domains");
    const domainId = domains.find((domain) => domain.name === server.primaryDomain)?.id;
    if (!domainId) throw new MailSetupRefusal(`${server.primaryDomain} is missing from the mail server. Repair from the start.`);
    const accounts = core.listOfAnswer<{ id: string; name: string; domainId: string }>(
        await call(endpoint, credentials, core.accountListCalls()),
        "accounts"
    );
    const password = generatedSecret();
    const existing = accounts.find((account) => account.name === core.MAIL_SENDER_NAME && account.domainId === domainId);
    if (existing) {
        core.assertApplied(await call(endpoint, credentials, [core.accountPasswordCall(existing.id, password)]), "password", existing.id);
    } else {
        core.createdId(
            await call(endpoint, credentials, [
                core.accountCreateCall({
                    name: core.MAIL_SENDER_NAME,
                    domainId,
                    password,
                    quotaBytes: 256 * 1024 * 1024,
                    description: "Polaris sends its own mail from this mailbox."
                })
            ]),
            "account",
            "account"
        );
    }
    const address = `${core.MAIL_SENDER_NAME}@${server.primaryDomain}`;
    const created = await createEmailChannel(server.ownerId, {
        provider: "smtp",
        name: server.hostname,
        secret: password,
        settings: { host: server.hostname, port: 587, user: address, from: address, fromName: "Polaris" }
    });
    if (!created.channel) throw new MailSetupRefusal(created.error ?? "The email channel could not be created.");
    await prisma.mailServer.update({ where: { id: server.id }, data: { channelId: created.channel.id } });
    if (created.channel.status !== "connected") {
        await appendLog(
            server.id,
            "Polaris will send through it once its DNS is published and its certificate issued; the channel is under Management > Email."
        );
    }
};


const done: StepRunner = async (server) => {
    await prisma.mailServer.update({ where: { id: server.id }, data: { status: "ready" } });
};

const STEPS: Readonly<Record<SetupStep, StepRunner>> = {
    service,
    deploy,
    bootstrap,
    admin,
    "recovery-off": recoveryOff,
    webhook,
    sender,
    // The mailbox DMARC aggregate reports arrive in (see `ensureReportsMailbox`).
    reports: (server) => ensureReportsMailbox(server),
    done
};
