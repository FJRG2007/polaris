"use client";

/**
 * What somebody has offered you, and your answer.
 *
 * Deliberately not a notification. An offer is a thing that is waiting, and a
 * list of things waiting is what somebody comes back to - a notification is
 * something you either catch or lose, and losing one here means losing a file
 * somebody meant to give you.
 *
 * Every offer says what it is before it is accepted: the name, whether it is a
 * folder, how big it is, who sent it and what they said. Being told the size
 * after agreeing to hold it is the wrong way round.
 */

import { formatBytes } from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { AlertTriangle, File, Folder, Inbox } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import type { TransferView } from "@/lib/drive-transfer-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import {
    acceptTransferAction,
    cancelTransferAction,
    declineTransferAction,
    dismissTransferNoticeAction,
    sentTransfersAction,
    waitingTransfersAction
} from "./transfer-actions";

export function TransfersPanel() {
    const [waiting, setWaiting] = useState<TransferView[] | null>(null);
    const [sent, setSent] = useState<TransferView[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    const reload = () => {
        void Promise.all([waitingTransfersAction(), sentTransfersAction()])
            .then(([incoming, outgoing]) => {
                setWaiting(incoming);
                setSent(outgoing);
            })
            .catch(() => setWaiting([]));
    };

    useEffect(reload, []);

    const answer = (run: () => Promise<{ error?: string }>) => {
        startTransition(() => {
            void runAction(run, setError).then((result) => {
                if (result?.error) setError(result.error);
                else reload();
            });
        });
    };

    // The sent list carries two different things: offers nobody has answered,
    // which can still be taken back, and ones that went wrong, which are a
    // sentence the sender has to read.
    const wrong = sent.filter((offer) => offer.failure !== null);
    const waitingToBeAnswered = sent.filter((offer) => offer.status === "pending");

    // Nothing waiting and nothing sent is not an empty state worth a card. The
    // panel is only there when it has something to say.
    if (waiting !== null && waiting.length === 0 && sent.length === 0) return null;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Inbox className="size-4 shrink-0" />
                    Files on the way
                </CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
                {error ? <p className="text-sm text-red-400">{error}</p> : null}

                {(waiting ?? []).map((offer) => (
                    <div
                        key={offer.id}
                        className="flex flex-wrap items-center gap-3 rounded-md bg-surface-sunken p-3"
                    >
                        {offer.isFolder ? (
                            <Folder className="size-5 shrink-0 text-primary" />
                        ) : (
                            <File className="size-5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={offer.name}>
                                {offer.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {offer.senderName} · {formatBytes(Number(offer.size))}
                                {offer.mode === "move" ? " · they are giving it up" : null}
                                {offer.recipientOrg ? " · to your organization" : null}
                            </p>
                            {offer.note ? (
                                <p className="mt-1 text-xs text-muted-foreground">{offer.note}</p>
                            ) : null}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => answer(() => acceptTransferAction(offer.id))}
                            >
                                Accept
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => answer(() => declineTransferAction(offer.id))}
                            >
                                Decline
                            </Button>
                        </div>
                    </div>
                ))}

                {/* What went wrong, before what is still waiting. A move whose
                    copy landed but whose delete failed leaves the sender holding
                    a duplicate of a file they asked to give away, and it leaves
                    the waiting list without a word - so this is the only place
                    they would ever learn it. */}
                {wrong.length > 0 ? (
                    <div className="space-y-2 pt-1">
                        {wrong.map((offer) => (
                            <div
                                key={offer.id}
                                className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
                            >
                                <AlertTriangle className="size-4 shrink-0 text-amber-400" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium" title={offer.name}>
                                        {offer.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground">{offer.failure}</p>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                        answer(() => dismissTransferNoticeAction(offer.id))
                                    }
                                >
                                    Got it
                                </Button>
                            </div>
                        ))}
                    </div>
                ) : null}

                {waitingToBeAnswered.length > 0 ? (
                    <div className="space-y-2 pt-1">
                        <p className="text-xs text-muted-foreground">
                            Waiting to be answered. Nothing has left your Drive.
                        </p>
                        {waitingToBeAnswered.map((offer) => (
                            <div key={offer.id} className="flex items-center gap-3 text-sm">
                                <span className="min-w-0 flex-1 truncate" title={offer.name}>
                                    {offer.name}
                                </span>
                                <Badge variant="neutral" className="shrink-0">
                                    {offer.mode === "move" ? "Sending it" : "Copy"}
                                </Badge>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => answer(() => cancelTransferAction(offer.id))}
                                >
                                    Take back
                                </Button>
                            </div>
                        ))}
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
