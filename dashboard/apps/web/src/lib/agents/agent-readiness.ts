/**
 * Whether a person can actually start a session with a given tool.
 *
 * The question a screen has to answer BEFORE the button is pressed. Everything
 * needed to answer it was already in Polaris - the catalogue says what each tool
 * reads, the key store says what this account holds - and nothing was asking. A
 * session was therefore started with an empty environment, the agent came up at
 * its own login prompt inside a container nobody is looking at, and the session
 * sat there reporting nothing until the silence sweep called it failed six hours
 * later. That is the failure this module exists to make impossible.
 *
 * It answers for a PERSON rather than for the deployment, because that is what
 * the person in front of the screen is about to spend: their own linked account
 * first, and the deployment's where an administrator has chosen to share it.
 */

import * as core from "@polaris/core";
import { MODEL_PROVIDERS } from "@/lib/agents/agent-providers";
import { keySourcesFor, signinAccountsFor, signinEnvsFor } from "@/lib/agents/model-keys";

/**
 * Variables every session is handed whether or not anybody linked anything.
 *
 * The GitHub App installation token that checked the repository out is exported
 * for the agent's own git and GitHub tools, so a tool that signs in with it is
 * signed in already. Kept as a set here as well as in `agent-signins.ts` for
 * different reasons: there it decides what is worth asking for, here it decides
 * what counts as present.
 */
const ALWAYS_PRESENT = ["GH_TOKEN", "GITHUB_TOKEN"];

/** Every credential variable this person's sessions would actually be given. */
export async function credentialsHeldBy(userId: string | null): Promise<Set<string>> {
    const held = new Set<string>(ALWAYS_PRESENT);
    if (userId) {
        const sources = await keySourcesFor(userId);
        for (const provider of MODEL_PROVIDERS) {
            if (sources.has(provider.slug)) held.add(provider.envVar);
        }
    }
    for (const env of await signinEnvsFor(userId)) held.add(env);
    return held;
}

/** One tool, as the picker draws it. */
export interface AgentChoice {
    readonly id: string;
    readonly label: string;
    readonly vendor: string;
    readonly install: string | null;
    readonly docs: string;
    readonly readiness: core.AgentReadiness;
    /** What would sign it in, when nothing has. Empty otherwise, so the screen
     *  has nothing to say about a tool that is ready. */
    readonly missing: readonly { env: string; label: string; url: string; howto: string | null }[];
    /**
     * Which account it would actually use, named.
     *
     * The question a screen handing work to an agent was not answering at all.
     * A deployment can hold accounts of its own and a person can hold several,
     * so "ready" on its own leaves somebody unable to tell whose subscription is
     * about to do the work - or whether it is theirs at all.
     *
     * Null where nothing signs it in, and null for a tool Polaris holds no
     * sourced credential for, where saying anything would be inventing it.
     */
    readonly signedInAs: { label: string; mine: boolean } | null;
}

/** The catalogue, answered for this person. */
export async function agentChoicesFor(userId: string | null): Promise<AgentChoice[]> {
    const [held, accounts] = await Promise.all([credentialsHeldBy(userId), signinAccountsFor(userId)]);
    const present = (env: string): boolean => held.has(env);
    return core.AGENT_CLIS.map((cli) => {
        const readiness = core.agentReadiness(cli, present);
        // The credential it would actually pick, which is the first of its own
        // that is held - the same order the runtime resolves in, so the screen
        // cannot name one account and the session use another.
        const using = readiness === "ready" ? core.credentialInPlace(cli, present) : null;
        const account = using ? (accounts.get(using.env) ?? null) : null;
        return {
            id: cli.id,
            label: cli.label,
            vendor: cli.vendor,
            install: cli.install,
            docs: cli.docs,
            readiness,
            signedInAs: account
                ? {
                      // The address where the login gave one, since that is what
                      // tells two subscriptions apart; the name its owner chose
                      // otherwise.
                      label: account.identity ?? account.name,
                      mine: account.source === "own"
                  }
                : null,
            missing:
                readiness === "missing"
                    ? cli.credentials.map((credential) => ({
                          env: credential.env,
                          label: credential.label,
                          url: credential.url,
                          howto: credential.howto
                      }))
                    : []
        };
    });
}

/**
 * The environment a session's agent is started with, narrowed to what its own
 * tool reads.
 *
 * Narrowed on purpose, and it is the one place this differs from a run. A run is
 * handed every provider key the account holds, because the runtime substitutes a
 * model itself when one is unreachable and a single key would turn a recoverable
 * substitution into a failed run. A session is a person's own terminal on a
 * machine, running a tool that will not substitute anything - so it gets the
 * credential it signs in with and not the other eleven, and an account's OpenAI
 * key never reaches a container running Claude Code.
 *
 * A tool with no sourced credentials gets nothing, which is right: Polaris does
 * not know what it reads, so anything it passed would be a guess.
 */
export function credentialsForAgent(
    cli: core.AgentCli,
    available: Record<string, string>
): Record<string, string> {
    const chosen: Record<string, string> = {};
    for (const credential of cli.credentials) {
        const value = available[credential.env];
        if (value) chosen[credential.env] = value;
    }
    return chosen;
}
