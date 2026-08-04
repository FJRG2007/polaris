/**
 * Running an agent on the box Polaris itself runs on, without GitHub Actions.
 *
 * This is the execution that makes private repositories cheap: nothing is
 * scheduled by GitHub, so nothing is metered, and the repository needs no
 * workflow file at all. What it costs instead is that Polaris has to do the parts
 * a runner would otherwise do - fetch the code, fetch the runtime, and hold the
 * job.
 *
 * One run is one compose project of one container, the same shape a runner pool
 * uses on this machine and for the same reason: the web container reaches the box
 * only through polaris-hostd, which starts validated compose projects and
 * forwards a short allowlist of read calls. There is no shell on the host here,
 * and a run gets a container or it gets nothing.
 *
 * Two things ride in through the environment rather than the command line. A
 * container's command is readable by anything that can list processes on the box,
 * and both the clone credential and the run token are credentials.
 */

import { appBaseUrl } from "@/lib/domain-service";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { markRunStarted } from "@/lib/agents/agent-run-service";
import { cloneAuthHeader, githubAppInstallationToken } from "@/lib/github-service";

/**
 * The image a run happens in.
 *
 * The full Node image rather than a slim one: the agent clones with git, fetches
 * its runtime with curl, and installs its own CLI with npm, and an image missing
 * any of those turns into an apt-get on every single run. It is pulled once and
 * cached by the engine after that.
 */
const IMAGE = "node:24";

/** Stamped on every container a run starts, so the sweep finds them by label
 *  rather than by matching names it does not own. */
const LABEL_KEY = "polaris.agent-run";

/** How much of a container's log is read back at once. */
const MAX_LOG = 200_000;

/** The project, and therefore the container, one run gets. */
export function containerNameFor(runId: string): string {
    return `polaris-agent-${runId}`;
}

export interface StartServerRunInput {
    runId: string;
    /** Handed to the container once, through the environment. */
    runToken: string;
    repoFullName: string;
    prompt: string;
}

/**
 * Start the container a run happens in.
 *
 * Returns as soon as the container is up: the run reports its own progress
 * through the control plane from inside, and holding this call open for an hour
 * would tie a request to the length of a run.
 */
export async function startServerRun(input: StartServerRunInput): Promise<void> {
    const owner = input.repoFullName.split("/")[0] ?? "";
    const token = await githubAppInstallationToken(owner);
    if (!token) {
        throw new Error(
            `Polaris has no GitHub App installation for ${owner}, so it cannot check the repository out.`
        );
    }

    const apiUrl = (await appBaseUrl()).replace(/\/+$/, "");
    const name = containerNameFor(input.runId);
    const ports = new HostdPorts();

    await ports.composeUp({
        project: name,
        services: [
            {
                name,
                image: IMAGE,
                env: {
                    POLARIS_API_URL: apiUrl,
                    POLARIS_RUN_ID: input.runId,
                    // The runtime reads its inputs the way a GitHub Action does, so
                    // one entrypoint serves all three executions.
                    INPUT_PROMPT: input.prompt,
                    // What the run authenticates its callbacks with. It arrives as
                    // INPUT_TOKEN because that is the first place the runtime looks
                    // for the credential it presents to its control plane, which on
                    // a GitHub-scheduled job is the job's own token. This is the
                    // whole reason the command below is a fixed script and the
                    // credentials are environment: a command line is readable.
                    INPUT_TOKEN: input.runToken,
                    GIT_AUTH_HEADER: cloneAuthHeader(token) ?? "",
                    GITHUB_REPOSITORY: input.repoFullName,
                    // The runtime's git tooling reads this for pushes; it is the
                    // same installation token the clone uses.
                    GH_TOKEN: token
                },
                ports: [],
                volumes: [],
                labels: { [LABEL_KEY]: input.runId },
                command: ["sh", "-c", BOOT],
                networks: [],
                // Never restarted. A run exists once; bringing it back would replay
                // whatever it had already done with a token that no longer works.
                restart: "no"
            }
        ],
        volumes: [],
        networks: []
    });

    await markRunStarted(input.runId, { containerId: name });
}

/**
 * What the container does.
 *
 * Fixed rather than assembled per run, so nothing from a repository name or a
 * prompt is ever interpolated into a shell. Every value it needs is read from the
 * environment, and the credentials are unset before the agent starts so the
 * process it runs cannot read them back out of its own environment.
 */
const BOOT = [
    "set -eu",
    // The clone credential goes to git through a config value read from the
    // environment, never as part of the URL, which would put it in the reflog and
    // in every error message git prints.
    'git clone --depth 1 -c http.extraHeader="$GIT_AUTH_HEADER" "https://github.com/$GITHUB_REPOSITORY.git" /workspace',
    "cd /workspace",
    // The runtime comes from the instance the run reports to, and its digest is
    // checked before it is executed.
    'curl -fsSL --retry 3 -D /tmp/headers -o /tmp/agent.mjs "$POLARIS_API_URL/api/agents/runtime/bundle"',
    'expected=$(awk \'tolower($1) == "x-content-sha256:" { print $2 }\' /tmp/headers | tr -d "\\r")',
    'actual=$(sha256sum /tmp/agent.mjs | cut -d " " -f 1)',
    '[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "runtime digest mismatch"; exit 1; }',
    // The clone is done, so the credential that did it goes away before the agent
    // starts. GH_TOKEN stays: the agent's own git and GitHub tools need it.
    "unset GIT_AUTH_HEADER",
    "exec node /tmp/agent.mjs"
].join("\n");

/** What the container has printed so far. Polled by the run screen while a run is
 *  in flight; the same call answers after it ends, which is what makes a finished
 *  run's log readable at all. */
export async function serverRunLog(runId: string): Promise<string> {
    const ports = new HostdPorts();
    let collected = "";
    await ports
        .logs(
            containerNameFor(runId),
            (chunk) => {
                if (collected.length < MAX_LOG) collected += chunk.toString("utf8");
            },
            { tail: 2000 }
        )
        .catch(() => undefined);
    return collected.slice(0, MAX_LOG);
}

/** Stop a run and take its container with it. */
export async function stopServerRun(runId: string): Promise<void> {
    await new HostdPorts().composeDown(containerNameFor(runId)).catch(() => undefined);
}
