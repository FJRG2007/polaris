/**
 * The Deploy commands, over the same `/api/v1/deploy` API the server's own
 * script and the MCP tools use: list what you can reach, read a service, its
 * deployments and logs, deploy it again, restart it.
 *
 * A service is named the way the dashboard names it - `project/service` (the
 * default environment), `project/environment/service` - or by its id. The name
 * is resolved by the server once, exactly as the API matches it, and the id is
 * used from then on.
 */

import { call, refusalMessage, requireCompatible, send } from "../api.js";
import type { Flags } from "../args.js";
import { CliError, usage } from "../errors.js";
import { line, printJson, table } from "../output.js";
import { fancy, spinning, type Ui } from "../ui.js";
import { requireSession, type Context, type Session } from "../context.js";
import {
    buildLogSchema,
    deployStartedSchema,
    deploymentsSchema,
    projectsSchema,
    restartedSchema,
    runtimeLogSchema,
    serviceSchema,
    type ServiceDetail
} from "../schemas.js";

/** How long `--follow` waits between reads of a running service's log. */
export const FOLLOW_MS = 2000;

/** The default number of log lines. */
const DEFAULT_TAIL = 200;

/** A Docker log line starts with its RFC 3339 timestamp; it is what `since` takes. */
const STAMP = /^(\d{4}-\d{2}-\d{2}T\S+)\s/;

/**
 * Choose a service from every one this sign-in reaches: the project, then the
 * environment, then the service, each asked only when there is more than one.
 * The reference it returns is the one the command line takes, so what was
 * picked can be typed next time.
 */
export async function pickService(context: Context, session: Session, ui: Ui): Promise<string> {
    const { projects: found } = await spinning(
        ui,
        {
            start: "Reading your projects",
            done: () => "Projects read",
            failed: "Could not read them"
        },
        () =>
            call(session.connection, "GET", "/api/v1/deploy/projects", projectsSchema, {
                fetch: context.fetch
            })
    );
    const reachable = found.filter((project) =>
        project.environments.some((environment) => environment.services.length > 0)
    );
    if (reachable.length === 0)
        throw new CliError(
            "No services you can reach yet. Create one under Deploy in the dashboard (plr dashboard open deploy)."
        );
    const project =
        reachable.length === 1
            ? reachable[0]!
            : await ui.select(
                  "Which project?",
                  reachable.map((each) => ({ value: each, label: each.name, hint: each.slug }))
              );
    const environments = project.environments.filter((each) => each.services.length > 0);
    const environment =
        environments.length === 1
            ? environments[0]!
            : await ui.select(
                  "Which environment?",
                  environments.map((each) => ({
                      value: each,
                      label: each.name,
                      hint: each.isDefault ? "default" : each.slug
                  }))
              );
    const service =
        environment.services.length === 1
            ? environment.services[0]!
            : await ui.select(
                  "Which service?",
                  environment.services.map((each) => ({
                      value: each,
                      label: each.name,
                      hint: each.status
                  }))
              );
    const ref = `${project.slug}/${environment.slug}/${service.slug}`;
    ui.info(`Service: ${ref}`);
    return ref;
}

/** The service a reference names, asked of the server. With nothing named and
 *  a person at the terminal, they choose it from a list. */
export async function resolveService(
    context: Context,
    session: Session,
    ref: string | undefined,
    ui: Ui | null = null
): Promise<ServiceDetail> {
    const named =
        ref ??
        context.host.env.POLARIS_SERVICE ??
        (ui ? await pickService(context, session, ui) : undefined);
    if (!named)
        throw usage(
            "Name a service: project/service, project/environment/service or its id (or set POLARIS_SERVICE)."
        );
    const { service } = await call(
        session.connection,
        "GET",
        `/api/v1/deploy/services?ref=${encodeURIComponent(named)}`,
        serviceSchema,
        { fetch: context.fetch }
    );
    return service;
}

/** How a service is named in output: the way it is typed. */
export function refOf(service: ServiceDetail): string {
    return `${service.project.slug}/${service.environment.slug}/${service.slug}`;
}

export async function projects(context: Context, flags: Flags): Promise<void> {
    const session = await requireSession(context, flags);
    const { projects: found } = await call(
        session.connection,
        "GET",
        "/api/v1/deploy/projects",
        projectsSchema,
        {
            fetch: context.fetch
        }
    );
    if (flags.json) return printJson(context.io, found);
    const rows = found.flatMap((project) =>
        project.environments.flatMap((environment) =>
            environment.services.map((service) => [
                `${project.slug}/${environment.slug}/${service.slug}`,
                service.status,
                service.id
            ])
        )
    );
    if (rows.length === 0) {
        line(
            context.io,
            "No services you can reach yet. Create one under Deploy in the dashboard (plr dashboard open deploy)."
        );
        return;
    }
    context.io.out(table(["SERVICE", "STATUS", "ID"], rows));
}

export async function service(
    context: Context,
    flags: Flags,
    ref: string | undefined
): Promise<void> {
    const session = await requireSession(context, flags);
    const ui = await fancy(context, flags);
    const found = await resolveService(context, session, ref, ui);
    if (flags.json) return printJson(context.io, found);
    const source =
        found.source.image ??
        (found.source.repository
            ? `${found.source.repository}${found.source.branch ? `#${found.source.branch}` : ""}`
            : found.source.kind);
    if (ui) {
        const domains = found.domains.map(
            (domain) =>
                `Domain:      ${domain.hostname} -> :${domain.targetPort} (${domain.enabled ? domain.health : "disabled"})`
        );
        ui.note(
            [
                `Status:      ${found.status}`,
                `Source:      ${source}`,
                `Auto-deploy: ${found.autoDeploy ? "on" : "off"}`,
                `Deployment:  ${found.currentDeploymentId ?? "none yet"}`,
                ...(domains.length ? domains : ["Domains:     none"]),
                `Id:          ${found.id}`
            ].join("\n"),
            refOf(found)
        );
        return;
    }
    line(context.io, `${refOf(found)}  (${found.id})`);
    line(context.io, `Status:      ${found.status}`);
    line(context.io, `Source:      ${source}`);
    line(context.io, `Auto-deploy: ${found.autoDeploy ? "on" : "off"}`);
    line(context.io, `Deployment:  ${found.currentDeploymentId ?? "none yet"}`);
    if (found.domains.length === 0) line(context.io, "Domains:     none");
    for (const domain of found.domains) {
        line(
            context.io,
            `Domain:      ${domain.hostname} -> :${domain.targetPort} (${domain.enabled ? domain.health : "disabled"})`
        );
    }
}

export async function deployments(
    context: Context,
    flags: Flags,
    ref: string | undefined
): Promise<void> {
    const session = await requireSession(context, flags);
    const found = await resolveService(context, session, ref, await fancy(context, flags));
    const { deployments: list } = await call(
        session.connection,
        "GET",
        `/api/v1/deploy/services/${found.id}/deployments`,
        deploymentsSchema,
        { fetch: context.fetch }
    );
    if (flags.json) return printJson(context.io, list);
    if (list.length === 0) {
        line(
            context.io,
            `${refOf(found)} has not been deployed yet. Run plr service deploy ${refOf(found)}.`
        );
        return;
    }
    context.io.out(
        table(
            ["DEPLOYMENT", "STATUS", "CREATED", "COMMIT", "MESSAGE"],
            list.map((entry) => [
                entry.id,
                entry.isCurrent ? `${entry.status}*` : entry.status,
                entry.createdAt,
                entry.commitSha?.slice(0, 7) ?? "",
                entry.commitMessage?.slice(0, 72) ?? ""
            ])
        )
    );
}

/** The last timestamp in a chunk of log, or the one there was. */
export function lastStamp(log: string, previous: string | null): string | null {
    let found = previous;
    for (const entry of log.split("\n")) {
        const stamp = STAMP.exec(entry)?.[1];
        if (stamp) found = stamp;
    }
    return found;
}

export async function logs(context: Context, flags: Flags, ref: string | undefined): Promise<void> {
    const session = await requireSession(context, flags);
    const found = await resolveService(context, session, ref, await fancy(context, flags));
    const path = `/api/v1/deploy/services/${found.id}/logs`;
    const tail = flags.tail ?? DEFAULT_TAIL;
    const first = await call(session.connection, "GET", `${path}?tail=${tail}`, runtimeLogSchema, {
        fetch: context.fetch
    });
    if (flags.json && !flags.follow) return printJson(context.io, first);
    if (first.log) line(context.io, first.log);
    if (!flags.follow) return;

    // Each read asks for the lines after the last timestamp already printed, so
    // a line is shown once however many reads it spans.
    let since = lastStamp(first.log, null);
    for (;;) {
        await context.sleep(FOLLOW_MS);
        const query = since ? `?tail=1000&since=${encodeURIComponent(since)}` : `?tail=${tail}`;
        const next = await call(session.connection, "GET", `${path}${query}`, runtimeLogSchema, {
            fetch: context.fetch
        });
        if (!next.log) continue;
        line(context.io, next.log);
        since = lastStamp(next.log, since);
    }
}

/** Print a deployment's build log as it is written, until the build ends. */
async function followBuild(
    context: Context,
    session: Session,
    deploymentId: string
): Promise<void> {
    const response = await send(
        session.connection,
        "GET",
        `/api/v1/deploy/deployments/${encodeURIComponent(deploymentId)}?follow=1`,
        // A build can run for a long time; the stream ends when it does.
        { fetch: context.fetch, timeoutMs: 6 * 60 * 60 * 1000 }
    );
    requireCompatible(session.connection, response);
    if (!response.ok) {
        const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new CliError(
            refusalMessage(
                session.connection.url,
                response.status,
                refusal?.error ? { error: refusal.error } : null
            )
        );
    }
    if (!response.body)
        throw new CliError(
            `Polaris sent no log for ${deploymentId}. Read it with plr deployment logs ${deploymentId}.`
        );
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        context.io.out(decoder.decode(chunk, { stream: true }));
    }
    context.io.out(decoder.decode());
}

export async function buildLog(
    context: Context,
    flags: Flags,
    deploymentId: string | undefined
): Promise<void> {
    if (!deploymentId)
        throw usage("Name a deployment id; plr deployment list <service> lists them.");
    const session = await requireSession(context, flags);
    if (flags.follow) return followBuild(context, session, deploymentId);
    const found = await call(
        session.connection,
        "GET",
        `/api/v1/deploy/deployments/${encodeURIComponent(deploymentId)}?tail=${flags.tail ?? DEFAULT_TAIL}`,
        buildLogSchema,
        { fetch: context.fetch }
    );
    if (flags.json) return printJson(context.io, found);
    if (found.log) line(context.io, found.log);
    line(context.io, `Status: ${found.status}${found.error ? ` - ${found.error}` : ""}`);
}

export async function deploy(
    context: Context,
    flags: Flags,
    ref: string | undefined
): Promise<void> {
    const session = await requireSession(context, flags);
    const ui = await fancy(context, flags);
    if (ui) {
        ui.intro("plr service deploy");
        const found = await resolveService(context, session, ref, ui);
        // Asked only when the service was chosen from the list: one named on
        // the command line is already the decision.
        if (!ref && !(await ui.confirm(`Deploy ${refOf(found)} again?`, true))) {
            ui.outro("Nothing was deployed.");
            return;
        }
        const { deploymentId } = await spinning(
            ui,
            {
                start: `Starting a deployment of ${refOf(found)}`,
                done: (started) => `Deployment ${started.deploymentId} started`,
                failed: "Polaris did not start it"
            },
            () => startDeploy(context, session, found)
        );
        if (flags.follow) {
            ui.info("Build log:");
            return followBuild(context, session, deploymentId);
        }
        ui.outro(`Watch it with plr deployment logs ${deploymentId} --follow`);
        return;
    }
    const found = await resolveService(context, session, ref);
    const { deploymentId } = await startDeploy(context, session, found);
    if (flags.json) return printJson(context.io, { deploymentId });
    line(context.io, `Deploying ${refOf(found)}: deployment ${deploymentId}.`);
    if (flags.follow) return followBuild(context, session, deploymentId);
    line(context.io, `Watch it with plr deployment logs ${deploymentId} --follow`);
}

/** Ask Polaris for a new deployment of a service. */
export function startDeploy(context: Context, session: Session, found: { id: string }) {
    return call(
        session.connection,
        "POST",
        `/api/v1/deploy/services/${found.id}/deploy`,
        deployStartedSchema,
        { fetch: context.fetch }
    );
}

export async function restart(
    context: Context,
    flags: Flags,
    ref: string | undefined
): Promise<void> {
    const session = await requireSession(context, flags);
    const ui = await fancy(context, flags);
    if (ui) {
        ui.intro("plr service restart");
        const found = await resolveService(context, session, ref, ui);
        if (!(await ui.confirm(`Restart ${refOf(found)}? It is briefly unavailable.`))) {
            ui.outro("Nothing was restarted.");
            return;
        }
        await spinning(
            ui,
            {
                start: `Restarting ${refOf(found)}`,
                done: () => `Restarted ${refOf(found)}`,
                failed: "Polaris did not restart it"
            },
            () => restartService(context, session, found)
        );
        ui.outro("Done.");
        return;
    }
    const found = await resolveService(context, session, ref);
    await restartService(context, session, found);
    if (flags.json) return printJson(context.io, { restarted: true, service: found.id });
    line(context.io, `Restarted ${refOf(found)}.`);
}

/** Ask Polaris to restart a service. */
export function restartService(context: Context, session: Session, found: { id: string }) {
    return call(
        session.connection,
        "POST",
        `/api/v1/deploy/services/${found.id}/restart`,
        restartedSchema,
        { fetch: context.fetch }
    );
}
