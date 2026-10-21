"use client";

/**
 * The Stream Deck on the downloads screen: the installer, what it does, and the
 * decks connected to this account with the button that disconnects each.
 *
 * A connected deck is an API key of kind "streamdeck", so disconnecting is the
 * API keys screen's own revoke - the same write, the same audit line.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import type { AppDownload } from "@/lib/app-releases";
import { Download, Grid3x3, Unplug } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { revokeApiKeyAction } from "../api-keys/actions";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

/** One connected deck, in the fields the list draws. */
export interface ConnectedDeck {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
}

/** The installer, or the fact that none has been published. */
export function StreamDeckFile({ download }: { download: AppDownload | null }) {
    const t = useTranslations("account");
    const file = download?.files.find((entry) => entry.name.endsWith(".streamDeckPlugin"));
    if (download && file) {
        return (
            <div>
                <Button asChild variant="secondary">
                    {/* A plain link: a router link would prefetch the file. */}
                    <a href={file.url} rel="noreferrer">
                        <Download className="size-4" />
                        {t("downloads.streamdeck.download", { version: download.version })}
                    </a>
                </Button>
            </div>
        );
    }
    return (
        <>
            <div>
                <Button variant="secondary" disabled>
                    <Download className="size-4" /> {t("downloads.streamdeck.downloadNone")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("downloads.streamdeck.notReleased")}</p>
        </>
    );
}

export function StreamDeckSection({
    decks,
    file
}: {
    decks: readonly ConnectedDeck[];
    /** The installer row; waits on GitHub, so it comes in its own boundary. */
    file: React.ReactNode;
}) {
    const t = useTranslations("account");
    const [list, setList] = useState(decks);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [confirm, confirmElement] = useConfirm();

    const disconnect = async (deck: ConnectedDeck): Promise<void> => {
        const ok = await confirm({
            title: t("downloads.streamdeck.disconnectTitle", { name: deck.name }),
            description: t("downloads.streamdeck.disconnectHint"),
            confirmLabel: t("downloads.streamdeck.disconnect"),
            danger: true
        });
        if (!ok) return;
        setBusy(deck.id);
        setError("");
        // Taken off at once and put back if the server refuses.
        const before = list;
        setList((rows) => rows.filter((row) => row.id !== deck.id));
        const result = await runAction(() => revokeApiKeyAction(deck.id), setError);
        setBusy(null);
        if (!result || result.error) {
            setList(before);
            if (result?.error) setError(result.error);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Grid3x3 className="size-4" />
                    {t("downloads.streamdeck.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 text-sm">
                <p className="text-muted-foreground">{t("downloads.streamdeck.description")}</p>
                {file}
                <p className="text-xs text-muted-foreground">
                    {t("downloads.streamdeck.connectHint")}
                </p>

                <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
                    <p className="font-medium">{t("downloads.streamdeck.connected")}</p>
                    {list.length === 0 ? (
                        <p className="text-muted-foreground">
                            {t("downloads.streamdeck.noneConnected")}
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                            {list.map((deck) => (
                                <li key={deck.id} className="flex items-center gap-3 py-2">
                                    <div className="min-w-0 flex-1">
                                        <Link
                                            href={`/account/api-keys/${deck.id}`}
                                            className="block truncate font-medium"
                                            title={deck.name}
                                        >
                                            {deck.name}
                                        </Link>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {deck.lastUsedAt
                                                ? t.rich("downloads.streamdeck.lastUsed", {
                                                      time: () => (
                                                          <RelativeTime
                                                              key="time"
                                                              iso={deck.lastUsedAt!}
                                                          />
                                                      )
                                                  })
                                                : t("downloads.streamdeck.notUsedYet")}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy === deck.id}
                                        onClick={() => void disconnect(deck)}
                                    >
                                        <Unplug className="size-4" />
                                        {t("downloads.streamdeck.disconnect")}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                </div>
            </CardBody>
            {confirmElement}
        </Card>
    );
}
