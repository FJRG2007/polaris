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
import { extensionDownload } from "@/lib/app-releases";
import { listVaultClients } from "@/lib/vault/devices";
import { BitwardenMark } from "@/components/brand-icons";
import { RelativeTime } from "@/components/relative-time";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { Download, ExternalLink, Puzzle, Terminal, TriangleAlert } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function VaultClientsPage() {
    const user = await requirePermission("vault.use");
    const vault = await getVault(user.id);
    // The configured sharing origin, not the tab's host: an address that only
    // works from inside the house is not one to paste into a phone.
    const base = await sharingBaseUrl();
    // Beside each other: one is a database read and the other a lookup that answers
    // from memory for ten minutes at a time, and neither should queue behind the
    // other to draw one page.
    const [clients, extension] = await Promise.all([
        listVaultClients(user.id),
        extensionDownload(loadEnv().POLARIS_REPO)
    ]);
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
                        <div className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm">
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
                        <Puzzle className="size-4" />
                        Polaris&apos; own extension
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    <p className="text-muted-foreground">
                        Built for this vault rather than adapted to it: it asks the browser for
                        permission to talk to this address and no other, fills a login without
                        holding any standing access to the pages you open, and locks itself again
                        when you stop using it.
                    </p>

                    <div>
                        <p className="font-medium">From your browser&apos;s store</p>
                        <p className="text-muted-foreground">
                            Not published yet. This is where it will be, and it is the one that
                            keeps itself up to date.
                        </p>
                        <div className="mt-2">
                            <Button size="sm" variant="secondary" disabled>
                                Get it from the store
                            </Button>
                        </div>
                    </div>

                    <div>
                        <p className="font-medium">Load it yourself</p>
                        <p className="text-muted-foreground">
                            Unpack the file for your browser and load it: Chrome and Edge at
                            chrome://extensions with Developer mode turned on, then Load unpacked.
                            Firefox at about:debugging, This Firefox, then Load Temporary Add-on.
                            Loaded this way it does not update itself, and Firefox lets it go when
                            it closes.
                        </p>
                        <div className="mt-2">
                            {extension ? (
                                <Button asChild size="sm">
                                    <a href={extension.url} target="_blank" rel="noreferrer">
                                        <Download className="size-4" /> Download {extension.version}
                                    </a>
                                </Button>
                            ) : (
                                <Button size="sm" disabled>
                                    <Download className="size-4" /> Download the extension
                                </Button>
                            )}
                        </div>
                        {!extension ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                                No package has been published yet, so there is nothing to load. It
                                is built from this repository and released on a tag of its own.
                            </p>
                        ) : null}
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Apps signed in to this vault</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3 text-sm">
                    {clients.length === 0 ? (
                        <p className="text-muted-foreground">
                            Nothing has signed in yet. An app appears here the first time it does.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {clients.map((client) => (
                                <li
                                    key={client.id}
                                    className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate" title={client.name}>
                                            {client.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {client.label} - last used{" "}
                                            <RelativeTime iso={client.lastSeenAt} />
                                        </p>
                                    </div>
                                    {client.kind === "extension" ? (
                                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                                            Extension
                                        </span>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="text-xs text-muted-foreground">
                        The name and the kind are what each app said about itself, not something
                        Polaris checked. If you do not recognise one, change your master password:
                        removing a row cannot shut out something that already holds the vault key.
                    </p>
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
