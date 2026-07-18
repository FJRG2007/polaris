import { redirect } from "next/navigation";
import { loadEnv } from "@polaris/config";
import { hasAnyUser } from "@polaris/auth";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
    // Setup is a one-time action: once an account exists, send people to sign in.
    if (await hasAnyUser()) redirect("/login");
    const tokenConfigured = Boolean(loadEnv().POLARIS_SETUP_TOKEN);
    return <SetupForm tokenConfigured={tokenConfigured} />;
}
