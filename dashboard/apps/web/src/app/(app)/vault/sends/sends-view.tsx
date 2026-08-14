"use client";

/**
 * Sends: handing something out of the vault to somebody who has no vault.
 *
 * The key is minted here and goes in the link's fragment, so the server holds a
 * name and a payload it cannot read - the same trade as a sealed snippet, and
 * the reason the link is shown once with a copy button rather than kept on the
 * page. Losing it loses the Send.
 *
 * The derivation is Bitwarden's, so a link made here opens in their apps and a
 * Send made there appears in this list.
 */

import * as crypto from "@/lib/vault/crypto";
import { useVaultSession } from "../vault-session";
import type { SymmetricKey } from "@/lib/vault/crypto";
import { useConfirm } from "@/components/confirm-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { Check, Copy, Loader2, Plus, SendHorizontal, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, Input, Select, Textarea } from "@polaris/ui";
import { createSendAction, deleteSendAction, vaultContentsAction } from "../vault-actions";

/** How long a Send lasts unless somebody says otherwise. */
const EXPIRY_OPTIONS = [
    { value: "1", label: "1 day" },
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" }
];

interface SendRow {
    id: string;
    name: string;
    accessCount: number;
    maxAccessCount: number | null;
    deletionDate: string;
    disabled: boolean;
    hasPassword: boolean;
}

export function SendsView() {
    const format = useDisplayFormat();
    const { key } = useVaultSession();
    const [rows, setRows] = useState<SendRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [days, setDays] = useState("7");
    const [confirm, confirmDialog] = useConfirm();

    async function load(withKey: SymmetricKey): Promise<void> {
        setLoading(true);
        const contents = await vaultContentsAction();
        const opened: SendRow[] = [];
        for (const raw of contents.sends) {
            opened.push({
                id: String(raw.id ?? ""),
                name: (await crypto.decrypt(String(raw.name ?? ""), withKey)) ?? "",
                accessCount: Number(raw.accessCount ?? 0),
                maxAccessCount:
                    raw.maxAccessCount === null || raw.maxAccessCount === undefined
                        ? null
                        : Number(raw.maxAccessCount),
                deletionDate: String(raw.deletionDate ?? ""),
                disabled: raw.disabled === true,
                hasPassword: raw.password !== null
            });
        }
        setRows(opened);
        setLoading(false);
    }

    useEffect(() => {
        if (key) void load(key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    async function onCreate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!key) return;
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "").trim();
        const text = String(form.get("text") ?? "");
        const password = String(form.get("password") ?? "").trim();
        const lifetime = Number(days);
        const maxViews = String(form.get("maxViews") ?? "").trim();
        if (!name || !text) {
            setError("It needs a name and something to send.");
            return;
        }

        setCreating(true);
        setError(null);
        try {
            // 16 bytes: the whole secret of the link, and everything below is
            // derived from it.
            const urlKey = window.crypto.getRandomValues(new Uint8Array(16));
            const sendKey = await crypto.deriveSendKey(urlKey);
            const result = await createSendAction({
                type: 0,
                name: await crypto.encrypt(name, sendKey),
                notes: null,
                // The link key, wrapped under the vault key, so this account's
                // other devices can rebuild the link without being told it.
                key: await crypto.encryptBytes(urlKey, key),
                text: { text: await crypto.encrypt(text, sendKey), hidden: false },
                password: password ? await crypto.sendPasswordHash(password, urlKey) : null,
                maxAccessCount: maxViews ? Number(maxViews) : null,
                deletionDate: new Date(Date.now() + lifetime * 24 * 60 * 60 * 1000).toISOString(),
                disabled: false,
                hideEmail: true
            });
            if (result.error || !result.url) {
                setError(result.error ?? "That send could not be created.");
                return;
            }
            setLink(
                `${result.url}#${crypto.toBase64(urlKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`
            );
            setCopied(false);
            event.currentTarget.reset();
            await load(key);
        } finally {
            setCreating(false);
        }
    }

    async function onDelete(row: SendRow) {
        const confirmed = await confirm({
            title: `Delete "${row.name}"?`,
            description: "The link stops working immediately.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed || !key) return;
        await deleteSendAction(row.id);
        await load(key);
    }

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Sends</h1>
                <p className="text-sm text-muted-foreground">
                    Hand something to somebody who has no vault. The key rides in the link, so
                    Polaris cannot read it.
                </p>
            </div>

            {link ? (
                <Card>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm">
                            Copy this now. It is the only time it is shown, and the part after the #
                            is what opens it.
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
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardBody>
                    <form onSubmit={onCreate} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            What is it
                            <Input name="name" placeholder="Staging database password" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            The text
                            <Textarea name="text" rows={4} className="font-mono text-xs" />
                        </label>
                        <div className="grid grid-cols-3 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Lasts
                                <Select
                                    name="days"
                                    value={days}
                                    onValueChange={setDays}
                                    options={EXPIRY_OPTIONS}
                                    aria-label="How long it lasts"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Max views
                                <Input
                                    name="maxViews"
                                    type="number"
                                    min="1"
                                    placeholder="Unlimited"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Password
                                <Input
                                    name="password"
                                    type="password"
                                    placeholder="Optional"
                                    autoComplete="off"
                                />
                            </label>
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={creating}>
                                {creating ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Plus className="size-4" />
                                )}
                                Create a send
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>

            {loading ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        Loading...
                    </CardBody>
                </Card>
            ) : rows.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        Nothing out there yet.
                    </CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {rows.map((row) => (
                        <Card key={row.id}>
                            <CardBody className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                    <SendHorizontal className="size-4 shrink-0 text-primary" />
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">
                                            {row.name || "Untitled"}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {row.accessCount}
                                            {row.maxAccessCount !== null
                                                ? `/${row.maxAccessCount}`
                                                : ""}{" "}
                                            opened - until {format.date(row.deletionDate)}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    {row.hasPassword ? (
                                        <Badge variant="neutral">Password</Badge>
                                    ) : null}
                                    {row.disabled ? <Badge variant="warning">Off</Badge> : null}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        title="Delete"
                                        aria-label={`Delete ${row.name}`}
                                        onClick={() => onDelete(row)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}
            {confirmDialog}
        </div>
    );
}
