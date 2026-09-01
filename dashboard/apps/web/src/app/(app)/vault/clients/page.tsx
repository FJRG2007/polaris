/**
 * Connecting an app to this vault (/vault/clients).
 *
 * The point of implementing Bitwarden's API rather than inventing one is that
 * the apps already exist - the browser extension that fills a login, the phone
 * that has it on the lock screen, the CLI in a deploy script. This page is what
 * turns that into something somebody can actually do, which means the URL has to
 * be right and copyable, and the steps have to name what they will see.
 */

import Link from "next/link";
import { loadEnv } from "@polaris/config";
import { getVault } from "@/lib/vault/account";
import { requirePermission } from "@/lib/session";
import { sharingBaseUrl } from "@/lib/domain-service";
import { CopyButton } from "@/components/copy-button";
import { BitwardenMark } from "@/components/brand-icons";
import { ExternalLink, Terminal, TriangleAlert } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

export const dynamic = "force-dynamic";

export default async function VaultClientsPage() {
    const user = await requirePermission("vault.use");
    const vault = await getVault(user.id);
    // The configured sharing origin, not the tab's host: an address that only
    // works from inside the house is not one to paste into a phone.
    const base = await sharingBaseUrl();
    const serverUrl = `${base}/vault`;
    const insecure =
        !serverUrl.startsWith("https://") && !loadEnv().POLARIS_APP_URL.includes("localhost");

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Connect an app</h1>
                <p className="text-sm text-muted-foreground">
                    This vault speaks the Bitwarden protocol, so their apps work with it.
                </p>
            </div>

            {!vault ? (
                <Card>
                    <CardBody className="flex flex-col items-start gap-3 p-6">
                        <p className="text-sm text-muted-foreground">
                            Set your vault up first. There is nothing for an app to sign in to yet.
                        </p>
                        <Button asChild size="sm">
                            <Link href="/vault">Set up my vault</Link>
                        </Button>
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <BitwardenMark className="size-4" />
                        Your server address
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm">
                            {serverUrl}
                        </code>
                        <CopyButton value={serverUrl} label="the server address" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        On the app&apos;s sign-in screen, choose self-hosted and paste this in. Sign
                        in with the address on your Polaris account and your master password.
                    </p>
                    {insecure ? (
                        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                            <span>
                                This address is not HTTPS. Most clients refuse to sign in over a
                                plain connection, and they are right to - set up a certificate under
                                Management &gt; Domains first.
                            </span>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Where to put it</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    <div>
                        <p className="font-medium">Browser extension</p>
                        <p className="text-muted-foreground">
                            Open it, press the settings cog on the sign-in screen, pick
                            &quot;Self-hosted&quot; and paste the address into Server URL.
                        </p>
                    </div>
                    <div>
                        <p className="font-medium">Desktop and mobile</p>
                        <p className="text-muted-foreground">
                            Tap the region selector above the email field, choose
                            &quot;Self-hosted&quot;, and paste the address into Server URL.
                        </p>
                    </div>
                    <div>
                        <p className="font-medium">Command line</p>
                        <p className="text-muted-foreground">
                            Point the CLI at this server, then sign in as usual.
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs">
                                bw config server {serverUrl}
                            </code>
                            <CopyButton
                                value={`bw config server ${serverUrl}`}
                                label="the CLI command"
                            />
                        </div>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Terminal className="size-4" />
                        If an app asks for each address separately
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2 text-sm">
                    <p className="text-muted-foreground">
                        Some versions offer a custom environment with a field per service. These are
                        the values.
                    </p>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
                        <dt className="text-muted-foreground">Web vault</dt>
                        <dd className="truncate" title={serverUrl}>
                            {serverUrl}
                        </dd>
                        <dt className="text-muted-foreground">API</dt>
                        <dd
                            className="truncate"
                            title={`${serverUrl}/api`}
                        >{`${serverUrl}/api`}</dd>
                        <dt className="text-muted-foreground">Identity</dt>
                        <dd
                            className="truncate"
                            title={`${serverUrl}/identity`}
                        >{`${serverUrl}/identity`}</dd>
                        <dt className="text-muted-foreground">Icons</dt>
                        <dd
                            className="truncate"
                            title={`${serverUrl}/icons`}
                        >{`${serverUrl}/icons`}</dd>
                        <dt className="text-muted-foreground">Notifications</dt>
                        <dd
                            className="truncate"
                            title={`${serverUrl}/notifications`}
                        >{`${serverUrl}/notifications`}</dd>
                    </dl>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>What is different here</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>
                        Accounts are made in Polaris, not from a client - an app&apos;s &quot;create
                        account&quot; will be refused, and your master password is separate from the
                        one you sign in to Polaris with.
                    </p>
                    <p>
                        Two-step login uses the authenticator on your Polaris account, so a code
                        from it is what an app will ask for.
                    </p>
                    <p>
                        Icons for saved sites are fetched by this server rather than by Bitwarden,
                        so the list of sites you have accounts on stays here.
                    </p>
                    <p className="flex items-center gap-1">
                        <ExternalLink className="size-3" />
                        Bitwarden is a trademark of Bitwarden, Inc. Polaris is not affiliated with
                        them; it implements their published client protocol.
                    </p>
                </CardBody>
            </Card>
        </div>
    );
}
