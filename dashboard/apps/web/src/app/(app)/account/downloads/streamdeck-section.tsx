"use client";

/**
 * The Stream Deck card on the downloads screen: what it does, the Marketplace
 * row, one row per app a deck runs on with its steps a press away, and the decks
 * connected to this account with the button that disconnects each.
 *
 * A connected deck is an API key of kind "streamdeck", so disconnecting is the
 * API keys screen's own revoke - the same write, the same audit line.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Unplug } from "lucide-react";
import { STREAMDECK_MARKETPLACE_URL } from "@/lib/deck/marketplace";
import { useConfirm } from "@/components/confirm-dialog";
import { revokeApiKeyAction } from "../api-keys/actions";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button } from "@polaris/ui";
import { DeckCard, DeckFile } from "@polaris/ui/account-downloads/deck-card";

/** One connected deck, in the fields the list draws. */
export interface ConnectedDeck {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
}

export { DeckFile };

export function StreamDeckSection({
    decks,
    address,
    repo,
    pluginFile,
    moduleFile
}: {
    decks: readonly ConnectedDeck[];
    /** This Polaris's address for the steps, or null to use the one the page is on. */
    address: string | null;
    /** The repository the plugin's releases and install scripts come from. */
    repo: string;
    /** The plugin's download, which waits on GitHub in a boundary of its own. */
    pluginFile: React.ReactNode;
    /** The Companion module's download, in a boundary of its own. */
    moduleFile: React.ReactNode;
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
        <DeckCard
            address={address}
            repo={repo}
            storeUrl={STREAMDECK_MARKETPLACE_URL || null}
            pluginFile={pluginFile}
            moduleFile={moduleFile}
        >
            <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">
                    {t("downloads.streamdeck.connected")}
                </p>
                {list.length === 0 ? (
                    <p className="text-muted-foreground">
                        {t("downloads.streamdeck.noneConnected")}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60 border-y border-border/60">
                        {list.map((deck) => (
                            <li key={deck.id} className="flex min-w-0 items-center gap-3 py-2">
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
            {confirmElement}
        </DeckCard>
    );
}
