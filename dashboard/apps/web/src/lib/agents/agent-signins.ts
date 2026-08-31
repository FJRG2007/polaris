/**
 * Signing an agent in, for the sessions that have nobody to sign them in.
 *
 * A session on somebody's own server runs the agent as they already have it: the
 * tool's own configuration is sitting in that machine's home directory, it is
 * already signed in, and Polaris neither reads nor replaces it. That case needs
 * nothing from this file.
 *
 * A session on this box does not have that. It is a container Polaris made a
 * minute ago from a stock image: nothing has ever been signed in to anything in
 * it, and the agent it starts comes up at a login prompt that nobody will ever
 * answer, because nobody is watching a container. Orca does not have this problem
 * because Orca runs on your laptop, next to the login you already did. A web
 * control plane has to carry the credential there, which means somebody has to
 * have linked one, which means a screen has to ask.
 *
 * What this file is NOT is a second credential store. Polaris already holds model
 * provider keys per account, with encryption, ordering, expiry and instance
 * sharing, and a session is handed exactly those. This covers only the credentials
 * that no model provider serves - a subscription token, a vendor whose CLI bills
 * on its own account - and it works out which those are by subtracting rather
 * than by listing them again.
 */

import * as core from "@polaris/core";
import { MODEL_PROVIDERS } from "@/lib/agents/agent-providers";

/**
 * The prefix every sign-in row's `provider` column carries.
 *
 * Namespaced so a sign-in and a model provider can never collide in the one table
 * both live in, and so the providers screen can leave these out of a list they do
 * not belong on by asking one question about the string.
 *
 * Lower case and hyphens because that is the shape the stored slug is validated
 * against, and that validation guards every other credential in the table. A
 * variable's own name is upper case with underscores, so it is folded on the way
 * in rather than the rule being widened for this one caller.
 */
export const SIGNIN_PREFIX = "agent-signin-";

/** The row slug a credential is stored under. Keyed by the VARIABLE rather than
 *  by the tool, because two tools reading the same variable are two tools that
 *  one linked account should satisfy at once. */
export function signinSlug(env: string): string {
    return SIGNIN_PREFIX + env.toLowerCase().replace(/_/g, "-");
}

/**
 * The variable a sign-in slug is for, or null when the slug is not one.
 *
 * Looked up rather than transformed back. The fold above is reversible today -
 * a variable's name holds nothing but capitals, digits and underscores - but a
 * reader deriving a variable name by string surgery would be one unusual name
 * away from handing a container a variable that does not exist, silently.
 */
export function signinEnv(slug: string): string | null {
    if (!slug.startsWith(SIGNIN_PREFIX)) return null;
    return agentSignins().find((signin) => signin.slug === slug)?.env ?? null;
}

/**
 * Variables a session is handed without anybody linking anything.
 *
 * `GH_TOKEN` is the interesting one: every session is checked out with a GitHub
 * App installation token which is exported under that name for the agent's own
 * git and GitHub tools, so the one tool that signs in with it - Copilot CLI - is
 * already signed in by the time it starts. Asking somebody to link a GitHub
 * account for it would be asking for something they already gave.
 */
const SUPPLIED_BY_THE_SESSION = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

/** Variables the model key store already fills, from the providers a person may
 *  hold a key for. Derived rather than restated: a provider added there stops
 *  being asked for here on the same commit. */
function servedByModelKeys(): Set<string> {
    return new Set(MODEL_PROVIDERS.map((provider) => provider.envVar));
}

/** One credential somebody can link, and the tools it would sign in. */
export interface AgentSignin {
    readonly env: string;
    readonly slug: string;
    readonly label: string;
    readonly url: string;
    readonly howto: string | null;
    readonly subscription: boolean;
    /** Which catalogued tools this one signs in. Carries the id as well as the
     *  label so a screen can draw the tool's mark without matching on words. */
    readonly serves: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Every credential that has no home but this one.
 *
 * Subtraction, as above: the catalogue names what each tool reads, the model key
 * store already answers for its own providers, and the session already answers
 * for GitHub. Whatever is left over is what a person would otherwise have no way
 * at all to give Polaris - and every one of them arrived here by a tool being
 * added to the catalogue rather than by anybody maintaining a second list.
 */
export function agentSignins(): AgentSignin[] {
    const served = servedByModelKeys();
    const found = new Map<string, AgentSignin>();
    for (const cli of core.AGENT_CLIS) {
        for (const credential of cli.credentials) {
            if (served.has(credential.env) || SUPPLIED_BY_THE_SESSION.has(credential.env)) continue;
            const existing = found.get(credential.env);
            if (existing) {
                found.set(credential.env, {
                    ...existing,
                    serves: [...existing.serves, { id: cli.id, label: cli.label }]
                });
                continue;
            }
            found.set(credential.env, {
                env: credential.env,
                slug: signinSlug(credential.env),
                label: credential.label,
                url: credential.url,
                howto: credential.howto,
                subscription: credential.subscription,
                serves: [{ id: cli.id, label: cli.label }]
            });
        }
    }
    return [...found.values()];
}

/** Whether a slug names a sign-in somebody may store NOW. What the write path
 *  asks: a variable no catalogued tool reads is not one to start holding. */
export function isSigninSlug(slug: string): boolean {
    return agentSignins().some((signin) => signin.slug === slug);
}

/**
 * Whether a stored row IS a sign-in, whatever the catalogue says today.
 *
 * The reading question rather than the writing one, and they have to be
 * different. A tool leaving the catalogue leaves its rows behind, and a listing
 * that asked `isSigninSlug` would stop recognising them - which would not lose
 * them, it would show them on the provider table as a credential for a provider
 * that does not exist. The prefix is what a row is, and it never changes.
 */
export function isSigninRow(slug: string): boolean {
    return slug.startsWith(SIGNIN_PREFIX);
}

/** What to call a sign-in row on a screen, given its slug. Falls back to the
 *  variable, which is still the truest thing that can be said about a row whose
 *  tool is gone. */
export function signinLabel(slug: string): string {
    return agentSignins().find((signin) => signin.slug === slug)?.label ?? slug;
}

/**
 * The two kinds, told apart, because they are not the same offer.
 *
 * A subscription is a plan somebody already pays a flat rate for, and signing it
 * in costs nothing extra. An API key is a meter that starts on the first token -
 * and for a coding agent, which reads a repository and writes to it all day,
 * that is the expensive way round by a wide margin. Presenting them in one list
 * as interchangeable ways to fill the same slot is how somebody ends up paying
 * per token for work their plan already covers.
 *
 * So the screens group them and say which is which, and the assisted sign-in is
 * only ever offered for the first: there is a login to walk somebody through
 * because there is an account to log into. An API key is copied off a page.
 */
export function agentSubscriptions(): AgentSignin[] {
    return agentSignins().filter((signin) => signin.subscription);
}

export function agentApiKeys(): AgentSignin[] {
    return agentSignins().filter((signin) => !signin.subscription);
}

/**
 * The sign-ins as the keys table needs them.
 *
 * So they are listed the way the provider keys are listed, in the same table,
 * with the same renaming, reordering, expiry and last-used - rather than in a
 * card of their own that would have had to grow every one of those separately
 * and would still have looked like a different feature.
 *
 * `checkable` is false throughout: none of these has an endpoint that refuses an
 * unknown credential, and a check that accepts anything is worse than no check,
 * because the dialog would report it as verified.
 */
export function signinProviderRows(): Array<{
    slug: string;
    name: string;
    aliases: string[];
    apiKeyLabel: string;
    apiKeyHelp: string | null;
    createUrl: string | null;
    isGateway: boolean;
    checkable: boolean;
    freeTier: null;
}> {
    return agentSignins().map((signin) => ({
        slug: signin.slug,
        name: signin.label,
        // What somebody types looking for it is the tool's name, not the
        // credential's: "claude" finds the Claude subscription token.
        aliases: signin.serves.map((tool) => tool.label),
        apiKeyLabel: signin.label,
        apiKeyHelp: `Signs in ${signin.serves.map((tool) => tool.label).join(", ")}.`,
        createUrl: signin.url,
        isGateway: false,
        checkable: false,
        freeTier: null
    }));
}
