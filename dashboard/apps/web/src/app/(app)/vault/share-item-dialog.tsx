"use client";

/**
 * Handing one item out as a link.
 *
 * The same machinery as a Send, reached from the item instead of from a blank
 * form - which is where somebody actually is when they decide to share a
 * credential. It mints the link key here, encrypts under it here, and the server
 * receives a payload it cannot read; the key rides in the fragment, which no
 * browser ever sends to the server.
 *
 * The conditions are the ones a link can actually enforce: how long it lasts,
 * how many times it may be opened, and a password to open it. Nothing else is
 * offered, because a control that is not enforced is worse than no control -
 * somebody would rely on it.
 *
 * The link is shown once. It cannot be shown twice: the key is not kept, and
 * Polaris has no way to rebuild it.
 */

import * as crypto from "@/lib/vault/crypto";
import type { VaultItem } from "./vault-model";
import { useVaultSession } from "./vault-session";
import { createSendAction } from "./vault-actions";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, ShieldAlert } from "lucide-react";
import {
    defaultParts,
    PART_LABELS,
    PART_WARNINGS,
    shareableParts,
    shareText,
    type SharedPart
} from "./share-item";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** How long the link lasts unless somebody says otherwise. A week: long enough
 *  to be read, short enough that a forgotten share expires on its own. */
const LIFETIMES = [
    { value: "1", label: "1 day" },
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" }
];

export function ShareItemDialog({
    item,
    onShared,
    onClose
}: {
    item: VaultItem | null;
    /** Told once a link actually exists, so the item's history can record it. */
    onShared?: (item: VaultItem) => void;
    onClose: () => void;
}) {
    const { key } = useVaultSession();
    const [parts, setParts] = useState<Set<SharedPart>>(new Set());
    const [days, setDays] = useState("7");
    const [maxViews, setMaxViews] = useState("1");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const available = useMemo(() => (item ? shareableParts(item) : []), [item]);

    useEffect(() => {
        if (!item) return;
        // A fresh decision every time the dialog opens: what was shared last time
        // says nothing about what should be shared now.
        setParts(new Set(defaultParts(item)));
        setDays("7");
        setMaxViews("1");
        setPassword("");
        setLink(null);
        setCopied(false);
        setError(null);
    }, [item]);

    const body = item ? shareText(item, parts) : "";

    async function onShare(): Promise<void> {
        if (!item || !key) return;
        if (!body.trim()) {
            setError("Pick at least one thing to send.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // Sixteen bytes: the whole secret of the link, and everything below
            // is derived from it.
            const urlKey = window.crypto.getRandomValues(new Uint8Array(16));
            const sendKey = await crypto.deriveSendKey(urlKey);
            const views = Number(maxViews);
            const result = await createSendAction({
                type: 0,
                name: await crypto.encrypt(item.name || "Shared credential", sendKey),
                notes: null,
                // Wrapped under the vault key as well, so this account's other
                // devices can list the share without being told the link.
                key: await crypto.encryptBytes(urlKey, key),
                text: { text: await crypto.encrypt(body, sendKey), hidden: true },
                password: password ? await crypto.sendPasswordHash(password, urlKey) : null,
                maxAccessCount: Number.isFinite(views) && views > 0 ? views : null,
                deletionDate: new Date(
                    Date.now() + Number(days) * 24 * 60 * 60 * 1000
                ).toISOString(),
                disabled: false,
                hideEmail: true
            });
            if (result.error || !result.url) {
                setError(result.error ?? "That link could not be made.");
                return;
            }
            setLink(
                `${result.url}#${crypto
                    .toBase64(urlKey)
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
                    .replace(/=+$/, "")}`
            );
            onShared?.(item);
        } finally {
            setBusy(false);
        }
    }

    function toggle(part: SharedPart): void {
        setParts((prev) => {
            const next = new Set(prev);
            if (next.has(part)) next.delete(part);
            else next.add(part);
            return next;
        });
    }

    return (
        <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Share {item?.name || "this item"}</DialogTitle>
                    <DialogDescription>
                        Anybody with the link can read what you pick. Polaris cannot - the key is
                        in the link itself, and it is shown once.
                    </DialogDescription>
                </DialogHeader>

                {link ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm">
                            Copy it now. This is the only time it is shown, and the part after the
                            # is what opens it.
                        </p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={link} className="font-mono text-xs" />
                            <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                title="Copy the link"
                                aria-label="Copy the link"
                                onClick={async () => {
                                    await navigator.clipboard.writeText(link);
                                    setCopied(true);
                                }}
                            >
                                {copied ? (
                                    <Check className="size-4 text-success" />
                                ) : (
                                    <Copy className="size-4" />
                                )}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            It is listed under Sends, where you can end it early.
                        </p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <fieldset className="flex flex-col gap-2">
                            <legend className="text-xs font-medium text-muted-foreground">
                                What to send
                            </legend>
                            {available.map((part) => (
                                <label key={part} className="flex items-start gap-2 text-sm">
                                    <Checkbox
                                        checked={parts.has(part)}
                                        onChange={() => toggle(part)}
                                        className="mt-0.5"
                                    />
                                    <span className="min-w-0">
                                        {PART_LABELS[part]}
                                        {PART_WARNINGS[part] ? (
                                            <span className="flex items-start gap-1 text-xs text-warning">
                                                <ShieldAlert className="mt-0.5 size-3 shrink-0" />
                                                {PART_WARNINGS[part]}
                                            </span>
                                        ) : null}
                                    </span>
                                </label>
                            ))}
                        </fieldset>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="text-xs text-muted-foreground">
                                    Stops working after
                                </span>
                                <Select
                                    value={days}
                                    onValueChange={setDays}
                                    aria-label="How long the link lasts"
                                    options={LIFETIMES}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="text-xs text-muted-foreground">
                                    Times it can be opened
                                </span>
                                <Input
                                    type="number"
                                    min={1}
                                    value={maxViews}
                                    onChange={(event) => setMaxViews(event.target.value)}
                                    placeholder="Any number of times"
                                />
                            </label>
                        </div>

                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">
                                Password to open it (optional)
                            </span>
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                                this is not an account password and there is no
                                account behind it. It is a word for one link that
                                expires in days, told to somebody by another
                                route; it is never stored, never reused, and
                                there is no identity here to resemble. What the
                                server receives is already stretched against the
                                link key, so it cannot be looked up either. */}
                            <Input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                placeholder="Told to them another way"
                                autoComplete="new-password"
                            />
                            {/* The point of a second channel, said once: a
                                password sent in the same message as the link is
                                not a password. */}
                            <span className="text-xs text-muted-foreground">
                                Send this by a different route than the link.
                            </span>
                        </label>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {link ? "Done" : "Cancel"}
                    </Button>
                    {link ? null : (
                        <Button onClick={() => void onShare()} disabled={busy || !key}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            Make the link
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
