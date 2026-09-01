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
import { keySourcesFor, signinAccountsFor, signinEnvsFor, signinOptionsFor } from "@/lib/agents/model-keys";

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

/**
 * One thing somebody can pick when handing work to an agent.
 *
 * A tool AND an account, because those are not one choice. Somebody can hold
 * three Claude subscriptions and the deployment can hold a fourth, and a list of
 * tools shows one row for all four with no way to say which it means - which is
 * exactly what a picker that named the winning account still did, since it named
 * one and hid three.
 *
 * A tool with no account of its own still appears once, with `accountId` null:
 * that is a tool signed in on the machine it will run on, or one Polaris holds
 * no sourced credential for, and refusing to offer it would be Polaris deciding
 * it does not work on evidence it does not have.
 */
export interface AgentOption {
    readonly key: string;
    readonly cli: string;
    readonly label: string;
    readonly vendor: string;
    readonly docs: string;
    readonly readiness: core.AgentReadiness;
    /** The stored account this option means, or null for "whatever resolves". */
    readonly accountId: string | null;
    /** What to call that account: its address where the login gave one, and the
     *  name its owner chose otherwise. Null when there is no account. */
    readonly account: string | null;
    /** True when it belongs to the person choosing, false when the deployment
     *  provides it. Null when there is no account. */
    readonly mine: boolean | null;
    /** True for the row that means "sign it in with nothing and let the machine
     *  answer". Not an account, so `accountId` stays null - but a different
     *  answer from null on its own, which means "whichever of mine resolves". */
    readonly machine: boolean;
    readonly missing: AgentChoice["missing"];
}

/** The catalogue crossed with the accounts, as the picker lists it. */
export async function agentOptionsFor(userId: string | null): Promise<AgentOption[]> {
    const [choices, accounts] = await Promise.all([agentChoicesFor(userId), signinOptionsFor(userId)]);
    const options: AgentOption[] = [];
    for (const choice of choices) {
        const cli = core.agentCliById(choice.id);
        const envs = new Set((cli?.credentials ?? []).map((credential) => credential.env));
        const mine = accounts.filter((account) => envs.has(account.env));
        // Offered for every tool Polaris could sign in itself, because it is the
        // only true answer for a machine somebody signed in themselves - and the
        // only way to stop a stored token that was revoked months ago being
        // injected over a login that works. Its readiness is `unknown` rather
        // than `ready`: Polaris cannot see inside that home, and claiming
        // otherwise would be inventing evidence.
        // A tool the catalogue names no credential for is handed nothing
        // already, so its plain row means exactly this - and a second row saying
        // it again is one tool listed twice with nothing to tell the two apart.
        if (envs.size > 0) {
            options.push({
                key: `${choice.id}:${core.MACHINE_LOGIN_KEY}`,
                cli: choice.id,
                label: choice.label,
                vendor: choice.vendor,
                docs: choice.docs,
                readiness: "unknown",
                accountId: null,
                account: "This machine's own login",
                mine: null,
                machine: true,
                missing: []
            });
        }
        if (mine.length === 0) {
            options.push({
                key: choice.id,
                cli: choice.id,
                label: choice.label,
                vendor: choice.vendor,
                docs: choice.docs,
                readiness: choice.readiness,
                accountId: null,
                account: null,
                mine: null,
                machine: false,
                missing: choice.missing
            });
            continue;
        }
        for (const account of mine) {
            options.push({
                key: `${choice.id}:${account.id}`,
                cli: choice.id,
                label: choice.label,
                vendor: choice.vendor,
                docs: choice.docs,
                // An account exists for it, so it is signed in whatever the
                // catalogue-wide answer was.
                readiness: "ready",
                accountId: account.id,
                account: account.identity ?? account.name,
                mine: account.source === "own",
                machine: false,
                missing: []
            });
        }
    }
    return options;
}
