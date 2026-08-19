import { redirect } from "next/navigation";
import { hasAnyUser } from "@polaris/auth";
import { resolveSession } from "@/lib/session";
import { CONNECTION_PROVIDERS } from "@polaris/core";
import { safeRedirect } from "./post-login-target";
import { LoginForm, type SignInProvider } from "./login-form";
import { connectionSignInOffered } from "@/lib/connections/oauth";
import { pendingTwoFactorUserId } from "@/lib/two-factor-challenge";

export const dynamic = "force-dynamic";

/**
 * The outside services this deployment can sign somebody in with right now: the
 * operator allows them, there is an application to authorize against, and that
 * application has taken somebody through at least once - a button that leads to a
 * consent screen refusing everybody reads as "your account is not welcome here"
 * rather than as a setup nobody finished.
 *
 * Says nothing about any account. A button appears for a service the deployment
 * supports whether or not the person at the screen has one - a list that shrank
 * to what a given browser could use would be a list of who has linked what.
 */
async function signInProviders(): Promise<SignInProvider[]> {
    const offered = await Promise.all(
        CONNECTION_PROVIDERS.map(async (provider): Promise<SignInProvider | null> =>
            (await connectionSignInOffered(provider.slug)) ? { slug: provider.slug, name: provider.name } : null
        )
    );
    return offered.filter((provider): provider is SignInProvider => provider !== null);
}

export default async function LoginPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // A sign-in already half done belongs on the challenge screen, not back at the
    // password field. An emailed link lands here for that reason: the link stands
    // in for the password, so what is left to answer is the second factor. The
    // challenge screen can send somebody back here deliberately, which drops the
    // challenge first so this does not bounce them straight into it again.
    if (await pendingTwoFactorUserId()) redirect("/oauth/2fa");

    // Already signed in. Asking again is not a safe default, it is a dead end:
    // there is nothing this screen can do that has not been done, and the person
    // typing has no way to tell that the session they already have is the answer.
    // Sent where the sign-in would have sent them, so a link with a destination
    // on it - the one a bookmark or a shared address carries - still lands there
    // rather than dropping them on the dashboard root.
    //
    // Checked after the challenge above, which is the more specific state: a
    // session plus a live challenge is somebody deliberately signing in as
    // somebody else, and that belongs at the challenge.
    const params = await searchParams;
    const session = await resolveSession().catch(() => null);
    if (session) {
        redirect(safeRedirect(typeof params.redirect === "string" ? params.redirect : null));
    }
    // Where to get an account from is only worth saying while there is no way in
    // at all. Once the instance has its first account the answer is "ask whoever
    // runs it", and the setup command has stopped working anyway.
    const [awaitingSetup, providers] = await Promise.all([
        hasAnyUser().then((exists) => !exists),
        signInProviders()
    ]);
    return <LoginForm awaitingSetup={awaitingSetup} providers={providers} />;
}
