"use client";

/**
 * Channels page: every connected messaging channel with its live status, plus the
 * connect flow. Reuses the Inbox's ChannelCard and ConnectChannelDialog so channel
 * management is identical wherever it appears. These channels are what the Watch app
 * targets for alerts and what the Inbox sends through.
 */

import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button, Card, CardBody } from "@polaris/ui";
import type { ChannelView } from "@/lib/messaging-service";
import { ChannelCard, ConnectChannelDialog } from "../inbox-view";

export function ChannelsView({
    initialChannels,
    bridgeReady
}: {
    initialChannels: ChannelView[];
    bridgeReady: boolean;
}) {
    const [channels, setChannels] = useState(initialChannels);
    const [connecting, setConnecting] = useState(false);

    return (
        <div className="flex max-w-4xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold">Channels</h1>
                    <p className="text-sm text-muted-foreground">
                        Messaging channels connected to Polaris. The Inbox and Watch alerts send through these.
                    </p>
                </div>
                <Button onClick={() => setConnecting(true)} disabled={!bridgeReady}>
                    <Plus className="size-4" /> Connect a channel
                </Button>
            </div>

            {!bridgeReady && (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        The messaging bridge is not running yet. Install it from the{" "}
                        <Link href="/apps/marketplace" className="text-primary hover:underline">
                            Apps marketplace
                        </Link>{" "}
                        to connect channels.
                    </CardBody>
                </Card>
            )}

            {channels.length === 0 ? (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        No channels connected yet. Connect one to start messaging and to target it from Watch alerts.
                    </CardBody>
                </Card>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {channels.map((channel) => (
                        <ChannelCard
                            key={channel.id}
                            channel={channel}
                            onUpdated={(id, patch) =>
                                setChannels((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
                            }
                            onRemoved={(id) => setChannels((prev) => prev.filter((item) => item.id !== id))}
                        />
                    ))}
                </div>
            )}

            {connecting && (
                <ConnectChannelDialog
                    bridgeReady={bridgeReady}
                    onClose={() => setConnecting(false)}
                    onConnected={(channel) => {
                        setChannels((prev) => [...prev.filter((item) => item.id !== channel.id), channel]);
                        setConnecting(false);
                    }}
                />
            )}
        </div>
    );
}
