import { LoginForm } from "./login-form";
import { hasAnyUser } from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
    // Where to get an account from is only worth saying while there is no way in
    // at all. Once the instance has its first account the answer is "ask whoever
    // runs it", and the setup command has stopped working anyway.
    return <LoginForm awaitingSetup={!(await hasAnyUser())} />;
}
