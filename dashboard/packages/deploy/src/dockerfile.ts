/**
 * A Dockerfile written for a repository that does not have one.
 *
 * This exists because the alternative kept failing. Handing the job to the
 * machine's auto-detecting builder means the runtimes available depend on when
 * that machine was set up: a build from last year pins Node 22 to an early
 * release, so a project needing >=22.12 is refused, and asking it for a newer
 * major does not error - it silently drops to Node 18. Three separate attempts to
 * steer it from the outside each made something else worse.
 *
 * An image tag does not have that problem. `node:22-slim` is the current 22.x,
 * today and next month, so a project that says what it needs gets it. This is also
 * how Vercel-alikes actually do it - the reference implementations in this repo
 * generate a Dockerfile rather than negotiating with a builder.
 *
 * Only for what is recognized. Anything this does not understand is still built by
 * the auto-detecting builder exactly as before, which is what keeps a working
 * Python or Go deploy working.
 */

import { INSTALL_ENV } from "./install-env.js";

/** How the image is assembled for one recognized project. */
export interface DockerfilePlan {
    /** Base image for the stage that installs and builds. */
    readonly buildImage: string;
    /** Base image the result runs in. Equal to buildImage for a single stage. */
    readonly runtimeImage: string;
    /** The app's directory relative to the repository root. Empty is the root. */
    readonly appDirectory: string;
    /** Run once at the repository root before the app's own steps - a workspace
     *  installs from there, because that is where its lockfile is. */
    readonly workspaceInstall: string | null;
    readonly install: string | null;
    readonly build: string | null;
    readonly start: string | null;
    /** Built files to serve rather than a process to start, relative to the app. */
    readonly staticDirectory: string | null;
    /** The port the container listens on. */
    readonly port: number;
}

/** Where the repository lands in the build stage. */
const WORKSPACE = "/workspace";

/** The file Polaris writes into the build context. Not `Dockerfile`: a repository
 *  may have one of its own that it deliberately does not build with, and clobbering
 *  it inside the context would be an edit nobody asked for. */
export const GENERATED_DOCKERFILE = "Dockerfile.polaris";

/** The app's directory inside the build stage. */
function sourceDir(appDirectory: string): string {
    return appDirectory ? `${WORKSPACE}/${appDirectory}` : WORKSPACE;
}

/**
 * Make the package manager available before it is used. The Node images ship
 * corepack but leave it off, so a pnpm or yarn project fails on its first command
 * with "not found" - which reads as a broken image rather than a disabled shim.
 *
 * Every fallback is tried and the whole thing is swallowed, because this line must
 * never be what fails a build: corepack can be absent on an old base, refused
 * without permissions, or already satisfied. If none of it works the install that
 * follows says so properly, which is a better error than this one.
 *
 * npm needs nothing (the image has it) and bun is its own image.
 */
function ensurePackageManager(command: string | null): string | null {
    if (!command) return null;
    // Anywhere in the command, not only at the front: an install is a compound
    // shell command, so the manager's name is not necessarily the first word.
    const manager = /\b(pnpm|yarn)\b/.exec(command)?.[1];
    if (!manager) return null;
    return `(corepack enable ${manager} || corepack enable || npm i -g ${manager}) >/dev/null 2>&1 || true`;
}

/** One RUN with the install and build chained, so the image does not commit a
 *  layer between two halves of the same step. */
function buildStep(plan: DockerfilePlan): string | null {
    const steps: string[] = [];
    const ensure = ensurePackageManager(plan.install ?? plan.build);
    if (ensure) steps.push(ensure);
    if (plan.install) steps.push(plan.install);
    if (plan.build) steps.push(plan.build);
    return steps.length > 0 ? `RUN ${steps.join(" && ")}` : null;
}

/** The nginx server for a built site: everything falls back to index.html, which
 *  is what makes a client-routed app survive a refresh on a deep link. */
function nginxConfig(port: number): string {
    const lines = [
        "server {",
        `    listen ${port} default_server;`,
        "    root /usr/share/nginx/html;",
        "    index index.html;",
        "    location / { try_files $uri $uri/ /index.html; }",
        "}"
    ];
    return lines.map((line) => `'${line}'`).join(" ");
}

/**
 * A built site is files, not a process, so it is served by nginx rather than
 * started - and the toolchain that built it is left behind in the builder stage
 * instead of shipping to production.
 */
function staticDockerfile(plan: DockerfilePlan): string[] {
    const source = sourceDir(plan.appDirectory);
    const output = plan.staticDirectory ? `${source}/${plan.staticDirectory}` : source;
    return [
        `FROM ${plan.buildImage} AS builder`,
        `WORKDIR ${WORKSPACE}`,
        ...installEnv(),
        "COPY . .",
        ...workspaceStep(plan),
        // Only when the app is not the root, which is already the working directory.
        ...(source === WORKSPACE ? [] : [`WORKDIR ${source}`]),
        ...[buildStep(plan)].filter((line): line is string => line !== null),
        "",
        "FROM nginx:alpine",
        "RUN rm -f /etc/nginx/conf.d/default.conf",
        `COPY --from=builder ${output} /usr/share/nginx/html`,
        `RUN printf '%s\\n' ${nginxConfig(plan.port)} > /etc/nginx/conf.d/app.conf`,
        `EXPOSE ${plan.port}`,
        'CMD ["nginx", "-g", "daemon off;"]'
    ];
}

/** The environment every install here runs under, set before anything installs.
 *  Declared rather than folded into the command so it also covers an install
 *  command the service set by hand, which Polaris never rewrites. */
function installEnv(): string[] {
    return Object.entries(INSTALL_ENV).map(([name, value]) => `ENV ${name}=${value}`);
}

/** The workspace-level install, as its own layer so it survives a change that
 *  only touches the app. */
function workspaceStep(plan: DockerfilePlan): string[] {
    if (!plan.workspaceInstall) return [];
    const ensure = ensurePackageManager(plan.workspaceInstall);
    const body = ensure ? `${ensure} && ${plan.workspaceInstall}` : plan.workspaceInstall;
    return [`RUN ${body}`];
}

/** A project that serves itself: one stage, since the sources it was built from
 *  are what it runs. */
function serverDockerfile(plan: DockerfilePlan): string[] {
    const source = sourceDir(plan.appDirectory);
    return [
        `FROM ${plan.runtimeImage}`,
        `WORKDIR ${WORKSPACE}`,
        ...installEnv(),
        "COPY . .",
        ...workspaceStep(plan),
        // Only when the app is not the root, which is already the working directory.
        ...(source === WORKSPACE ? [] : [`WORKDIR ${source}`]),
        ...[buildStep(plan)].filter((line): line is string => line !== null),
        `ENV PORT=${plan.port}`,
        `EXPOSE ${plan.port}`,
        ...(plan.start ? [`CMD ["sh", "-c", ${JSON.stringify(plan.start)}]`] : [])
    ];
}

/** Render the Dockerfile for a plan. */
export function generateDockerfile(plan: DockerfilePlan): string {
    const lines = plan.staticDirectory !== null ? staticDockerfile(plan) : serverDockerfile(plan);
    return [
        "# Written by Polaris from what it found in this repository.",
        "# Not part of the repository - it exists only inside the build context.",
        "",
        ...lines
    ]
        .join("\n")
        .trimEnd()
        .concat("\n");
}
