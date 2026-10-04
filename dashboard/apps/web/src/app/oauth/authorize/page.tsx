/**
 * The consent screen (/oauth/authorize): an app asking to act for the person
 * signed in, and the person deciding what it may do.
 *
 * Signed in first, then checked. An anonymous visitor is sent to sign in and
 * brought back here, so nothing about the request - including reading an app's
 * metadata document from its own server - happens on behalf of somebody who has
 * not proved who they are.
 *
 * A request that names no app this instance can identify, or a return address
 * the app never registered, is answered on this screen and never redirected:
 * those are the two cases where redirecting is how an attacker would use it.
 * Every other problem is sent back to the app, as RFC 6749 says.
 *
 * Never framed by anybody (next.config.mjs), so the Allow button cannot be
 * placed under somebody else's page.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { ConsentView } from "./consent-view";
import { scopesAvailableTo } from "@polaris/auth";
import { isLoopback } from "@/lib/mcp/oauth/urls";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { rateLimit } from "@/lib/rate-limit-service";
import { Messages } from "@/components/i18n/messages";
import { currentOrigin } from "@/lib/mcp/oauth/origin";
import { guardedUser, requireUser, resolveSession } from "@/lib/session";
import { Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { checkAuthorizationRequest, readParams } from "@/lib/mcp/oauth/authorize";

export const dynamic = "force-dynamic";

/** How many times one person may open the screen in ten minutes. Each opening
 *  can read an app's metadata from its own server, so it is bounded. */
const OPENINGS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function ConsentError({
    reason
}: {
    reason: "client" | "redirect" | "viewingAs" | "tooMany";
}) {
    const t = await getTranslations("mcp");
    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("consent.errorTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col items-center gap-3 text-center">
                    <ShieldAlert className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t(`consent.errors.${reason}`)}</p>
                    <Link href="/" className="text-sm underline underline-offset-2">
                        {t("consent.home")}
                    </Link>
                </CardBody>
            </Card>
        </main>
    );
}

export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
    const raw = await searchParams;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(raw)) {
        for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            search.append(key, entry);
        }
    }
    const query = search.toString();

    const user = await guardedUser();
    if (!user) {
        if (!(await resolveSession())) {
            redirect(`/oauth/login?redirect=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
        }
        // Signed in but held at a gate (a lock, an approval, a second factor):
        // requireUser sends them to it.
        await requireUser();
        return null;
    }
    if (user.viewingAs) return <ConsentError reason="viewingAs" />;
    const throttle = await rateLimit(`oauth-authorize:${user.id}`, OPENINGS_PER_WINDOW, WINDOW_MS);
    if (!throttle.ok) return <ConsentError reason="tooMany" />;

    const origin = await currentOrigin();
    const check = await checkAuthorizationRequest(readParams(search), origin, mcpScopes());
    if (check.kind === "unsafe") return <ConsentError reason={check.reason} />;
    if (check.kind === "redirect") redirect(check.url);

    const { request } = check;
    const held = new Set(await scopesAvailableTo(user.id, user.isAdmin));
    const redirectUrl = new URL(request.redirectUri);
    let website: string | null = null;
    try {
        website = request.client.clientUri ? new URL(request.client.clientUri).host : null;
    } catch {
        website = null;
    }

    return (
        <Messages namespaces={["mcp"]}>
            <ConsentView
                query={query}
                app={{
                    name: request.client.name,
                    website,
                    returnsTo: redirectUrl.host,
                    loopback: isLoopback(redirectUrl)
                }}
                person={user.name || user.email}
                offered={request.scopes.filter((scope) => held.has(scope))}
                withheld={request.scopes.filter((scope) => !held.has(scope))}
            />
        </Messages>
    );
}
