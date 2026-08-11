import { redirect } from "next/navigation";
import { hasAnyUser } from "@polaris/auth";
import { CONNECTION_PROVIDERS } from "@polaris/core";
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

export default async function LoginPage() {
    // A sign-in already half done belongs on the challenge screen, not back at the
    // password field. An emailed link lands here for that reason: the link stands
    // in for the password, so what is left to answer is the second factor. The
    // challenge screen can send somebody back here deliberately, which drops the
    // challenge first so this does not bounce them straight into it again.
    if (await pendingTwoFactorUserId()) redirect("/oauth/2fa");
    // Where to get an account from is only worth saying while there is no way in
    // at all. Once the instance has its first account the answer is "ask whoever
    // runs it", and the setup command has stopped working anyway.
    const [awaitingSetup, providers] = await Promise.all([
        hasAnyUser().then((exists) => !exists),
        signInProviders()
    ]);
    return <LoginForm awaitingSetup={awaitingSetup} providers={providers} />;
}
