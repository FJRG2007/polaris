"use client";

/**
 * Who can sign in to this server with a key: one login's `authorized_keys`, read
 * live over Polaris's own connection, with adding, removing, minting a new pair
 * and bringing in the keys already on the reader's GitHub account.
 *
 * Polaris's own key is shown and marked, never removable from here: taking it
 * away is taking the server out of Polaris, and that has its own button with its
 * own explanation.
 */

import Link from "next/link";
import { addServerKeysSchema } from "@polaris/core";
import { sshKeyIssueKey } from "./ssh-key-words";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useConnectionsHref } from "@/components/use-connections-href";
import { Download, Github, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AuthorizedKey, GithubKeyAccount, ServerKeysView } from "@/lib/server-ssh-keys";
import {
    Badge,
    Button,
    Checkbox,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Textarea
} from "@polaris/ui";
import {
    addServerKeysAction,
    generateServerKeyAction,
    removeServerKeyAction,
    serverKeysAction
} from "./ssh-key-actions";
import * as polls from "./servers-polls";

export function ServerSshKeys({ hostId }: { hostId: string }) {
    const t = useTranslations("servers");
    const [view, setView] = useState<ServerKeysView | null>(null);
    const [login, setLogin] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [removing, setRemoving] = useState<AuthorizedKey | null>(null);
    const [adding, setAdding] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [importing, setImporting] = useState(false);

    const load = useCallback(
        async (which?: string) => {
            setLoading(true);
            const result = await serverKeysAction({ hostId, login: which });
            setLoading(false);
            if (result.error || !result.view) {
                setError(result.error ?? t("sshKeys.problems.failed"));
                return;
            }
            setError(null);
            setView(result.view);
            setLogin(result.view.login);
        },
        [hostId, t]
    );

    useEffect(() => {
        void load();
    }, [load]);

    const current = login ?? view?.login ?? "";
    // The keys on screen, only while they are the chosen login's: a login whose
    // list failed to load shows the error, never the previous login's keys.
    const keys = view && view.login === current ? view.keys : null;
    // Memoized: the import dialog reloads GitHub whenever this set changes.
    const present = useMemo(() => new Set(keys?.map((key) => key.fingerprint) ?? []), [keys]);

    async function changed(message: string) {
        setNotice(message);
        await load(current);
    }

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">{t("sshKeys.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("sshKeys.intro")}</p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("sshKeys.login")}
                    <Select
                        value={current}
                        disabled={!view || loading}
                        onValueChange={(value) => {
                            setNotice(null);
                            setLogin(value);
                            void load(value);
                        }}
                        options={(view?.logins ?? [{ name: current, self: true }]).map((entry) => ({
                            value: entry.name,
                            label: entry.self
                                ? t("sshKeys.selfLogin", { name: entry.name })
                                : entry.name
                        }))}
                    />
                </label>
                <div className="ml-auto flex flex-wrap gap-2">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("sshKeys.refresh")}
                        title={t("sshKeys.refresh")}
                        disabled={loading}
                        onClick={() => void load(current)}
                    >
                        <RefreshCw className="size-4" />
                    </Button>
                    <Button variant="outline" disabled={!view} onClick={() => setImporting(true)}>
                        <Github className="size-4" />
                        {t("sshKeys.fromGithub")}
                    </Button>
                    <Button variant="outline" disabled={!view} onClick={() => setGenerating(true)}>
                        <KeyRound className="size-4" />
                        {t("sshKeys.generate")}
                    </Button>
                    <Button disabled={!view} onClick={() => setAdding(true)}>
                        <Plus className="size-4" />
                        {t("sshKeys.add")}
                    </Button>
                </div>
            </div>

            {view && !view.root ? (
                <p className="text-xs text-muted-foreground">{t("sshKeys.noRoot")}</p>
            ) : null}
            {notice ? <p className="text-sm text-success">{notice}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {loading && !view ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            ) : keys && keys.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("sshKeys.empty", { login: current })}
                </p>
            ) : keys ? (
                <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
                    {keys.map((key) => (
                        <li key={key.fingerprint} className="flex items-center gap-3 px-3 py-2">
                            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="flex min-w-0 items-center gap-2 text-sm">
                                    <span className="truncate" title={key.comment || key.type}>
                                        {key.comment || t("sshKeys.noComment")}
                                    </span>
                                    <Badge variant="neutral">{key.type}</Badge>
                                    {key.polaris ? (
                                        <Badge variant="primary">{t("sshKeys.polarisKey")}</Badge>
                                    ) : null}
                                    {key.options ? (
                                        <Badge variant="warning" title={key.options}>
                                            {t("sshKeys.limited")}
                                        </Badge>
                                    ) : null}
                                </span>
                                <span
                                    className="truncate font-mono text-xs text-muted-foreground"
                                    title={key.fingerprint}
                                >
                                    {key.fingerprint}
                                </span>
                            </div>
                            <CopyButton value={key.fingerprint} label={t("sshKeys.fingerprint")} />
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("sshKeys.remove")}
                                title={
                                    key.polaris ? t("sshKeys.polarisKeyHint") : t("sshKeys.remove")
                                }
                                disabled={key.polaris}
                                onClick={() => setRemoving(key)}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : null}

            <RemoveDialog
                hostId={hostId}
                login={current}
                target={removing}
                onClose={() => setRemoving(null)}
                onRemoved={() => void changed(t("sshKeys.removed"))}
            />
            <AddDialog
                hostId={hostId}
                login={current}
                open={adding}
                onClose={() => setAdding(false)}
                onAdded={(count) => void changed(t("sshKeys.addedCount", { count }))}
            />
            <GenerateDialog
                hostId={hostId}
                login={current}
                open={generating}
                onClose={() => setGenerating(false)}
                onCreated={() => void load(current)}
            />
            <GithubDialog
                hostId={hostId}
                login={current}
                present={present}
                open={importing}
                onClose={() => setImporting(false)}
                onAdded={(count) => void changed(t("sshKeys.addedCount", { count }))}
            />
        </section>
    );
}

function RemoveDialog(props: {
    hostId: string;
    login: string;
    target: AuthorizedKey | null;
    onClose: () => void;
    onRemoved: () => void;
}) {
    const t = useTranslations("servers");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const target = props.target;

    async function remove() {
        if (!target) return;
        setPending(true);
        const result = await removeServerKeyAction({
            hostId: props.hostId,
            login: props.login,
            fingerprint: target.fingerprint
        });
        setPending(false);
        if (result.error) return setError(result.error);
        props.onClose();
        props.onRemoved();
    }

    return (
        <Dialog
            open={target !== null}
            onOpenChange={(open) => {
                if (!open) {
                    setError(null);
                    props.onClose();
                }
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sshKeys.removeTitle")}</DialogTitle>
                    <DialogDescription>
                        {t("sshKeys.removeHint", {
                            login: props.login,
                            name: target?.comment || target?.fingerprint || ""
                        })}
                    </DialogDescription>
                </DialogHeader>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={props.onClose}>
                        {t("sshKeys.cancel")}
                    </Button>
                    <Button variant="danger" disabled={pending} onClick={() => void remove()}>
                        {pending ? t("sshKeys.removing") : t("sshKeys.remove")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AddDialog(props: {
    hostId: string;
    login: string;
    open: boolean;
    onClose: () => void;
    onAdded: (count: number) => void;
}) {
    const t = useTranslations("servers");
    const [text, setText] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    // Checked as it is typed, against the same schema the server applies. An
    // empty box is incomplete, not wrong, so it only disables the button.
    const check =
        lines.length === 0
            ? null
            : addServerKeysSchema.safeParse({
                  hostId: props.hostId,
                  login: props.login,
                  keys: lines
              });
    const issue = check && !check.success ? check.error.issues[0]?.message : null;

    async function add() {
        setPending(true);
        const result = await addServerKeysAction({
            hostId: props.hostId,
            login: props.login,
            keys: lines
        });
        setPending(false);
        if (result.error) return setError(result.error);
        setText("");
        props.onClose();
        props.onAdded(result.added ?? 0);
    }

    return (
        <Dialog
            open={props.open}
            onOpenChange={(open) => {
                if (!open) {
                    setError(null);
                    props.onClose();
                }
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sshKeys.addTitle", { login: props.login })}</DialogTitle>
                    <DialogDescription>{t("sshKeys.addHint")}</DialogDescription>
                </DialogHeader>
                <label className="flex flex-col gap-1 text-sm">
                    {t("sshKeys.publicKey")} *
                    <Textarea
                        value={text}
                        rows={5}
                        className="font-mono text-xs"
                        placeholder={t("sshKeys.publicKeyPlaceholder")}
                        aria-invalid={issue ? true : undefined}
                        onChange={(event) => {
                            setText(event.target.value);
                            setError(null);
                        }}
                    />
                </label>
                {issue ? <p className="text-sm text-danger">{t(sshKeyIssueKey(issue))}</p> : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={props.onClose}>
                        {t("sshKeys.cancel")}
                    </Button>
                    <Button disabled={pending || !check?.success} onClick={() => void add()}>
                        {pending ? t("sshKeys.adding") : t("sshKeys.add")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function GenerateDialog(props: {
    hostId: string;
    login: string;
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("servers");
    const [label, setLabel] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [key, setKey] = useState<{
        privateKey: string;
        publicKey: string;
        fingerprint: string;
    } | null>(null);

    function close() {
        // The private key is gone from the page as soon as the dialog closes.
        setKey(null);
        setLabel("");
        setError(null);
        props.onClose();
    }

    async function generate() {
        setPending(true);
        const result = await generateServerKeyAction({
            hostId: props.hostId,
            login: props.login,
            label
        });
        setPending(false);
        if (result.error || !result.key)
            return setError(result.error ?? t("sshKeys.problems.failed"));
        setKey(result.key);
        props.onCreated();
    }

    function download() {
        if (!key) return;
        const url = URL.createObjectURL(
            new Blob([key.privateKey], { type: "application/x-pem-file" })
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${props.login}-id_ed25519`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    return (
        <Dialog open={props.open} onOpenChange={(open) => (open ? undefined : close())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sshKeys.generateTitle", { login: props.login })}</DialogTitle>
                    <DialogDescription>
                        {key ? t("sshKeys.onceOnly") : t("sshKeys.generateHint")}
                    </DialogDescription>
                </DialogHeader>
                {key ? (
                    <div className="flex flex-col gap-2">
                        <Textarea
                            readOnly
                            value={key.privateKey}
                            rows={8}
                            className="font-mono text-xs"
                        />
                        <p
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={key.fingerprint}
                        >
                            {key.fingerprint}
                        </p>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={download}>
                                <Download className="size-4" />
                                {t("sshKeys.download")}
                            </Button>
                            <CopyButton value={key.privateKey} label={t("sshKeys.privateKey")} />
                        </div>
                    </div>
                ) : (
                    <label className="flex flex-col gap-1 text-sm">
                        {t("sshKeys.label")}
                        <Input
                            value={label}
                            maxLength={64}
                            placeholder={`${props.login}@polaris`} // i18n-ignore the comment a key gets by default
                            onChange={(event) => setLabel(event.target.value)}
                        />
                    </label>
                )}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    {key ? (
                        <Button onClick={close}>{t("sshKeys.savedIt")}</Button>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={close}>
                                {t("sshKeys.cancel")}
                            </Button>
                            <Button disabled={pending} onClick={() => void generate()}>
                                {pending ? t("sshKeys.generatingKey") : t("sshKeys.generate")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function GithubDialog(props: {
    hostId: string;
    login: string;
    present: Set<string>;
    open: boolean;
    onClose: () => void;
    onAdded: (count: number) => void;
}) {
    const t = useTranslations("servers");
    const connectionsLink = useConnectionsHref("github");
    const [state, setState] = useState<{ linked: boolean; accounts: GithubKeyAccount[] } | null>(
        null
    );
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { open, present } = props;

    useEffect(() => {
        if (!open) return;
        let live = true;
        setState(null);
        void polls.githubKeys().then((result) => {
            if (!live) return;
            setState(result);
            // Everything not already on the server starts ticked.
            setChosen(
                new Set(
                    result.accounts.flatMap((account) =>
                        account.keys
                            .filter((key) => !present.has(key.fingerprint))
                            .map((key) => key.key)
                    )
                )
            );
        });
        return () => {
            live = false;
        };
    }, [open, present]);

    async function add() {
        setPending(true);
        const result = await addServerKeysAction({
            hostId: props.hostId,
            login: props.login,
            keys: [...chosen]
        });
        setPending(false);
        if (result.error) return setError(result.error);
        props.onClose();
        props.onAdded(result.added ?? 0);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setError(null);
                    props.onClose();
                }
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sshKeys.githubTitle", { login: props.login })}</DialogTitle>
                    <DialogDescription>{t("sshKeys.githubHint")}</DialogDescription>
                </DialogHeader>
                {state === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : !state.linked ? (
                    <p className="text-sm text-muted-foreground">
                        {t("sshKeys.githubNotLinked")}{" "}
                        <Link href={connectionsLink} className="underline">
                            {t("sshKeys.githubLink")}
                        </Link>
                    </p>
                ) : (
                    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto overscroll-contain">
                        {state.accounts.map((account) => (
                            <div key={account.login} className="flex flex-col gap-1">
                                <span className="text-sm font-medium">{account.login}</span>
                                {account.failed ? (
                                    <span className="text-xs text-danger">
                                        {t("sshKeys.githubFailed")}
                                    </span>
                                ) : account.keys.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">
                                        {t("sshKeys.githubNone")}
                                    </span>
                                ) : (
                                    account.keys.map((key) => {
                                        const already = present.has(key.fingerprint);
                                        return (
                                            <label
                                                key={key.fingerprint}
                                                className="flex min-w-0 items-center gap-2 text-xs"
                                            >
                                                <Checkbox
                                                    checked={already || chosen.has(key.key)}
                                                    disabled={already}
                                                    aria-label={key.fingerprint}
                                                    onChange={(event) => {
                                                        const next = new Set(chosen);
                                                        if (event.target.checked) next.add(key.key);
                                                        else next.delete(key.key);
                                                        setChosen(next);
                                                    }}
                                                />
                                                <Badge variant="neutral">{key.type}</Badge>
                                                <span
                                                    className="min-w-0 truncate font-mono"
                                                    title={key.fingerprint}
                                                >
                                                    {key.fingerprint}
                                                </span>
                                                {already ? (
                                                    <span className="shrink-0 text-muted-foreground">
                                                        {t("sshKeys.alreadyThere")}
                                                    </span>
                                                ) : null}
                                            </label>
                                        );
                                    })
                                )}
                            </div>
                        ))}
                    </div>
                )}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={props.onClose}>
                        {t("sshKeys.cancel")}
                    </Button>
                    <Button disabled={pending || chosen.size === 0} onClick={() => void add()}>
                        {pending
                            ? t("sshKeys.adding")
                            : t("sshKeys.addChosen", { count: chosen.size })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
