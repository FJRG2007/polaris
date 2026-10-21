"use client";

/**
 * The marketplace grid. Every entry is a card in the same shape the Integrations
 * page uses, and picking one opens that platform's connect dialog, which lands
 * back on the channels list once the channel exists.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactElement } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { ConnectChannelDialog } from "@/app/(app)/admin/inbox/connect-channel-dialog";
import { channelCatalog, type ChannelKind } from "@/app/(app)/admin/inbox/channel-catalog";

export function ConnectChannelView({ bridgeReady }: { bridgeReady: boolean }) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [kind, setKind] = useState<ChannelKind | null>(null);

    /** Everything is set up to be used, so a finished connect goes to the list. */
    function done() {
        setKind(null);
        router.push("/admin/inbox/channels");
    }

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <div className="flex flex-col gap-1">
                <Link
                    href="/admin/inbox/channels"
                    className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-3" /> {t("inboxChannels.title")}
                </Link>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("inboxChannels.connect")}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t("inboxChannels.connectPage.intro")}
                </p>
            </div>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">
                        {t("inboxChannels.connectPage.messaging")}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        {t("inboxChannels.connectPage.messagingHint")}
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {channelCatalog(t).map((entry) => (
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

            {kind && (
                <ConnectChannelDialog
                    bridgeReady={bridgeReady}
                    initialKind={kind}
                    onClose={() => setKind(null)}
                    onConnected={done}
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
    disabled,
    onPick
}: {
    Logo: (props: { className?: string }) => ReactElement;
    color: string;
    name: string;
    badge?: string;
    summary: string;
    disabled?: boolean;
    onPick: () => void;
}) {
    const t = useTranslations("admin");
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
                    <Button size="sm" variant="secondary" onClick={onPick} disabled={disabled}>
                        {t("inboxChannels.connectPage.setUp")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
