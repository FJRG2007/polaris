"use client";

/**
 * The marketplace grid. Every entry is a card in the same shape the Integrations
 * page uses, and picking one opens that channel's own connect flow - the
 * messaging dialog for a platform, the sender dialog for a mail provider. Both
 * land back on the channels list once the channel exists.
 *
 * Messaging entries are disabled while the bridge is missing, rather than hidden:
 * a platform that quietly is not on the page reads as unsupported.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactElement } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { EmailChannelView } from "@/lib/mail-service";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { EmailChannelDialog } from "../email-channel-dialog";
import { EMAIL_CHANNEL_MARK } from "@/app/(app)/inbox/platform-meta";
import { ConnectChannelDialog } from "@/app/(app)/inbox/connect-channel-dialog";
import { CHANNEL_CATALOG, type ChannelKind } from "@/app/(app)/inbox/channel-catalog";
import { MAIL_PROVIDER_INFO, MAIL_PROVIDERS, type MailProvider } from "@polaris/core";

export function ConnectChannelView({ bridgeReady }: { bridgeReady: boolean }) {
    const router = useRouter();
    const [kind, setKind] = useState<ChannelKind | null>(null);
    const [provider, setProvider] = useState<MailProvider | null>(null);
    // The sender that was just added, so the dialog stays on it: a sender is not
    // proven until a test message arrives, and that is the step worth not skipping.
    const [added, setAdded] = useState<EmailChannelView | null>(null);

    /** Everything is set up to be used, so a finished connect goes to the list. */
    function done() {
        setKind(null);
        setProvider(null);
        setAdded(null);
        router.push("/inbox/channels");
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <div className="flex flex-col gap-1">
                <Link
                    href="/inbox/channels"
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-3" /> Channels
                </Link>
                <h1 className="text-[17px] font-semibold tracking-tight">Connect a channel</h1>
                <p className="text-sm text-muted-foreground">
                    Pick what to connect. Add as many as you like and handle them all from one inbox.
                </p>
            </div>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Messaging</h2>
                    <p className="text-xs text-muted-foreground">
                        Two-way chat in the Inbox, and where Watch sends its alerts.
                        {bridgeReady ? null : (
                            <>
                                {" "}
                                Needs the messaging bridge, which installs from the{" "}
                                <Link href="/apps/marketplace" className="text-primary hover:underline">
                                    Apps marketplace
                                </Link>
                                .
                            </>
                        )}
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {CHANNEL_CATALOG.map((entry) => (
                        <MarketplaceCard
                            key={entry.kind}
                            Logo={entry.Logo}
                            color={entry.color}
                            name={entry.name}
                            badge={entry.badge}
                            summary={entry.tagline}
                            disabled={!bridgeReady}
                            onPick={() => setKind(entry.kind)}
                        />
                    ))}
                </div>
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Email</h2>
                    <p className="text-xs text-muted-foreground">
                        How Polaris sends its own mail: address verification, password resets,
                        sign-in links and codes.
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {MAIL_PROVIDERS.map((id) => {
                        const info = MAIL_PROVIDER_INFO[id];
                        return (
                            <MarketplaceCard
                                key={id}
                                Logo={EMAIL_CHANNEL_MARK.Logo}
                                color={EMAIL_CHANNEL_MARK.color}
                                name={info.label}
                                summary={info.summary}
                                docsUrl={info.docsUrl}
                                onPick={() => setProvider(id)}
                            />
                        );
                    })}
                </div>
            </section>

            {kind && (
                <ConnectChannelDialog
                    bridgeReady={bridgeReady}
                    initialKind={kind}
                    onClose={() => setKind(null)}
                    onConnected={done}
                />
            )}
            {provider && (
                <EmailChannelDialog
                    channel={added}
                    initialProvider={provider}
                    onClose={() => (added ? done() : setProvider(null))}
                    onSaved={setAdded}
                    onRemoved={() => {
                        setProvider(null);
                        setAdded(null);
                    }}
                />
            )}
        </div>
    );
}

function MarketplaceCard({
    Logo,
    color,
    name,
    badge,
    summary,
    docsUrl,
    disabled,
    onPick
}: {
    Logo: (props: { className?: string }) => ReactElement;
    color: string;
    name: string;
    badge?: string;
    summary: string;
    docsUrl?: string;
    disabled?: boolean;
    onPick: () => void;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div
                        className="grid size-10 shrink-0 place-items-center rounded-md"
                        style={{ color, backgroundColor: `${color}1a` }}
                    >
                        <Logo className="size-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h3 className="truncate text-sm font-medium">{name}</h3>
                            {badge ? <Badge variant="neutral">{badge}</Badge> : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
                    </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                    {docsUrl ? (
                        <a
                            href={docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mr-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            Docs
                            <ExternalLink className="size-3" />
                        </a>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={onPick} disabled={disabled}>
                        Set up
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
