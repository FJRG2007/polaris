"use client";

/**
 * Connecting a messaging channel. Opened either from the catalogue (pick a
 * platform, then a variant) or straight on one kind, which is how the channel
 * marketplace hands off to it.
 *
 * Three kinds of ending: token channels are live as soon as the credential is
 * accepted, whatsapp-web waits for a QR scan, and a Discord bot lands on its
 * setup panel - the token alone leaves it in no server and usually short an
 * intent, and that is far easier to fix while it is still in front of you.
 */

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import type { ChannelView } from "@/lib/messaging-service";
import { channelStateAction, connectChannelAction } from "./actions";
import {
    CHANNEL_META,
    CHANNEL_PLATFORM,
    CHANNEL_PROVIDER,
    PLATFORM_GROUPS,
    type ChannelKind,
    type PlatformGroup
} from "./channel-catalog";
import { DiscordSetupPanel } from "./discord-setup-panel";

export function ConnectChannelDialog({
    bridgeReady,
    initialKind,
    onClose,
    onConnected
}: {
    bridgeReady: boolean;
    /** Skip the picker and connect this kind straight away (the marketplace). */
    initialKind?: ChannelKind;
    onClose: () => void;
    onConnected: (channel: ChannelView) => void;
}) {
    const [phase, setPhase] = useState<"platform" | "variant" | "form" | "qr" | "setup">(
        initialKind ? "form" : "platform"
    );
    const [kind, setKind] = useState<ChannelKind>(initialKind ?? "telegram");
    const [group, setGroup] = useState<PlatformGroup | null>(
        initialKind
            ? (PLATFORM_GROUPS.find((item) => item.variants.includes(initialKind)) ?? null)
            : null
    );
    const [name, setName] = useState(initialKind ? CHANNEL_META[initialKind].name : "");
    const [token, setToken] = useState("");
    const [phoneNumberId, setPhoneNumberId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [connectedId, setConnectedId] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState("connecting");

    const meta = CHANNEL_META[kind];
    const isWeb = kind === "whatsapp-web";
    const isDiscordBot = kind === "discord";
    const needsToken = Boolean(meta.tokenLabel);
    const ready =
        bridgeReady &&
        name.trim() !== "" &&
        (!needsToken || token.trim() !== "") &&
        (!meta.needsPhoneNumberId || phoneNumberId.trim() !== "");

    /** What the caller gets back once the channel is live. */
    function connectedChannel(id: string, externalId: string | null = null): ChannelView {
        return {
            id,
            platform: CHANNEL_PLATFORM[kind],
            provider: CHANNEL_PROVIDER[kind],
            name: name.trim(),
            externalId,
            status: "connected",
            capabilities: null
        };
    }

    // Pick a platform: go straight to the form when it has a single variant, else
    // show its variants to choose from.
    function pickPlatform(next: PlatformGroup) {
        setError(null);
        setGroup(next);
        if (next.variants.length === 1) {
            pick(next.variants[0]!);
            return;
        }
        setPhase("variant");
    }

    // Pick a variant: seed the name and clear prior input, then show the form.
    function pick(next: ChannelKind) {
        setKind(next);
        setName(CHANNEL_META[next].name);
        setToken("");
        setPhoneNumberId("");
        setError(null);
        setPhase("form");
    }

    // While onboarding whatsapp-web, poll the bridge for the QR and connected state.
    useEffect(() => {
        if (phase !== "qr" || !connectedId) return;
        let active = true;
        const poll = async () => {
            const state = await channelStateAction(connectedId);
            if (!active) return;
            setQrStatus(state.status);
            if (state.qr) setQr(state.qr);
            if (state.status === "connected") {
                onConnected(connectedChannel(connectedId, state.externalId ?? null));
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 2500);
        return () => {
            active = false;
            clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, connectedId, name]);

    function submit() {
        setError(null);
        const provider = CHANNEL_PROVIDER[kind];
        const input = {
            platform: CHANNEL_PLATFORM[kind],
            ...(provider ? { provider } : {}),
            name: name.trim(),
            ...(needsToken ? { token: token.trim() } : {}),
            ...(meta.needsPhoneNumberId ? { config: { phoneNumberId: phoneNumberId.trim() } } : {})
        };
        startTransition(async () => {
            const result = await connectChannelAction(input);
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.channelId) setConnectedId(result.channelId);
            if (isWeb && result.channelId) {
                setPhase("qr");
                return;
            }
            if (isDiscordBot && result.channelId) {
                setPhase("setup");
                return;
            }
            onConnected(connectedChannel(result.channelId ?? crypto.randomUUID()));
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                {phase === "setup" && connectedId ? (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <span
                                    className="grid size-7 shrink-0 place-items-center rounded"
                                    style={{
                                        color: meta.color,
                                        backgroundColor: `${meta.color}1a`
                                    }}
                                >
                                    <meta.Logo className="size-4" />
                                </span>
                                {name.trim()} is connected
                            </DialogTitle>
                            <DialogDescription>
                                The token works. Finish the setup so the bot can reach people.
                            </DialogDescription>
                        </DialogHeader>
                        <DiscordSetupPanel channelId={connectedId} />
                        <DialogFooter>
                            <Button onClick={() => onConnected(connectedChannel(connectedId))}>
                                Done
                            </Button>
                        </DialogFooter>
                    </>
                ) : phase === "qr" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Scan to link WhatsApp</DialogTitle>
                            <DialogDescription>
                                On your phone: WhatsApp {">"} Linked devices {">"} Link a device,
                                then scan this code.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col items-center gap-3 py-2">
                            {qr ? (
                                // A data-URL QR; next/image does not handle these.
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={qr}
                                    alt="WhatsApp QR code"
                                    className="size-56 rounded-md border border-border"
                                />
                            ) : (
                                <div className="flex size-56 items-center justify-center rounded-md border border-border">
                                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {qrStatus === "connected"
                                    ? "Connected."
                                    : qrStatus === "error"
                                      ? "Connection failed - try again."
                                      : "Waiting for the scan..."}
                            </p>
                        </div>
                        <DialogFooter>
                            <Button variant="ghost" onClick={onClose}>
                                {qrStatus === "connected" ? "Done" : "Close"}
                            </Button>
                        </DialogFooter>
                    </>
                ) : phase === "platform" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Add a channel</DialogTitle>
                            <DialogDescription>
                                Pick a platform, then how to connect it. Add as many as you like and
                                handle them all from one inbox.
                            </DialogDescription>
                        </DialogHeader>
                        {!bridgeReady && (
                            <p className="text-sm text-danger">
                                The messaging bridge is not installed yet. Install it from the{" "}
                                <a className="underline" href="/apps/marketplace">
                                    marketplace
                                </a>{" "}
                                to enable channels.
                            </p>
                        )}
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {PLATFORM_GROUPS.map((item) => {
                                const Logo = item.Logo;
                                return (
                                    <button
                                        key={item.platform}
                                        type="button"
                                        disabled={!bridgeReady}
                                        onClick={() => pickPlatform(item)}
                                        className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <div
                                            className="grid size-10 shrink-0 place-items-center rounded-md"
                                            style={{
                                                color: item.color,
                                                backgroundColor: `${item.color}1a`
                                            }}
                                        >
                                            <Logo className="size-5" />
                                        </div>
                                        <div className="min-w-0">
                                            <span className="text-sm font-medium">{item.name}</span>
                                            <p className="text-xs text-muted-foreground">
                                                {item.tagline}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        <DialogFooter>
                            <Button variant="ghost" onClick={onClose}>
                                Cancel
                            </Button>
                        </DialogFooter>
                    </>
                ) : phase === "variant" ? (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                {group && (
                                    <span
                                        className="grid size-7 shrink-0 place-items-center rounded"
                                        style={{
                                            color: group.color,
                                            backgroundColor: `${group.color}1a`
                                        }}
                                    >
                                        <group.Logo className="size-4" />
                                    </span>
                                )}
                                Connect {group?.name}
                            </DialogTitle>
                            <DialogDescription>
                                Pick how to connect {group?.name}.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {(group?.variants ?? []).map((variantKind) => {
                                const item = CHANNEL_META[variantKind];
                                const Logo = item.Logo;
                                return (
                                    <button
                                        key={item.kind}
                                        type="button"
                                        onClick={() => pick(item.kind)}
                                        className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/30"
                                    >
                                        <div
                                            className="grid size-10 shrink-0 place-items-center rounded-md"
                                            style={{
                                                color: item.color,
                                                backgroundColor: `${item.color}1a`
                                            }}
                                        >
                                            <Logo className="size-5" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium">
                                                    {item.name}
                                                </span>
                                                {item.badge && <Badge>{item.badge}</Badge>}
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                {item.tagline}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex justify-start">
                            <Button variant="ghost" onClick={() => setPhase("platform")}>
                                Back
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <span
                                    className="grid size-7 shrink-0 place-items-center rounded"
                                    style={{
                                        color: meta.color,
                                        backgroundColor: `${meta.color}1a`
                                    }}
                                >
                                    <meta.Logo className="size-4" />
                                </span>
                                Connect {meta.name}
                            </DialogTitle>
                            <DialogDescription>{meta.help}</DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Name</span>
                                <Input
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder="Support bot"
                                />
                            </label>
                            {needsToken && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">{meta.tokenLabel}</span>
                                    <Input
                                        type="password"
                                        value={token}
                                        onChange={(event) => setToken(event.target.value)}
                                        placeholder={meta.tokenPlaceholder}
                                    />
                                </label>
                            )}
                            {meta.needsPhoneNumberId && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Phone number id</span>
                                    <Input
                                        value={phoneNumberId}
                                        onChange={(event) => setPhoneNumberId(event.target.value)}
                                        placeholder="From the WhatsApp > API setup page"
                                    />
                                </label>
                            )}
                            {error && <p className="text-sm text-danger">{error}</p>}
                            <div className="flex items-center justify-between gap-2">
                                <Button
                                    variant="ghost"
                                    onClick={() => {
                                        setError(null);
                                        if (initialKind) {
                                            onClose();
                                            return;
                                        }
                                        setPhase(
                                            group && group.variants.length > 1
                                                ? "variant"
                                                : "platform"
                                        );
                                    }}
                                    disabled={pending}
                                >
                                    {initialKind ? "Cancel" : "Back"}
                                </Button>
                                <Button onClick={submit} disabled={pending || !ready}>
                                    {pending && <Loader2 className="size-4 animate-spin" />}
                                    {isWeb ? "Show QR" : "Connect"}
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
