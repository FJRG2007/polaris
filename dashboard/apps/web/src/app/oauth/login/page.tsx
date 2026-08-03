import { LoginForm } from "./login-form";
import { redirect } from "next/navigation";
import { hasAnyUser } from "@polaris/auth";
import { pendingTwoFactorUserId } from "@/lib/two-factor-challenge";

export const dynamic = "force-dynamic";

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
    return <LoginForm awaitingSetup={!(await hasAnyUser())} />;
}
