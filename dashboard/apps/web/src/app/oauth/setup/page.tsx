import { redirect } from "next/navigation";
import { loadEnv } from "@polaris/config";
import { hasAnyUser } from "@polaris/auth";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Setup is a one-time action: once an account exists, send people to sign in.
    if (await hasAnyUser()) redirect("/oauth/login");
    const params = await searchParams;
    const initialToken = typeof params.token === "string" ? params.token : "";
    const tokenConfigured = Boolean(loadEnv().POLARIS_SETUP_TOKEN);
    return <SetupForm tokenConfigured={tokenConfigured} initialToken={initialToken} />;
}
