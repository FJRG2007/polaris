"use client";

/**
 * Connectors on Polar permissions: the MCP servers this person connected,
 * each with its tools and what Polar may do with each one.
 *
 * Every change is optimistic and put back when the server refuses it. The
 * server answers a connector without its secret (`ConnectorView`), so nothing
 * typed into the token fields ever comes back to the page. A new one is added
 * from a dialog, as ChatGPT and Claude do, rather than a form on the page.
 */

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Plug, RefreshCw, Trash2, LogIn, ChevronDown } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Switch,
    cn
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ConnectorView } from "@/lib/polar/connectors/store";

type Policy = ConnectorView["tools"][number]["policy"];
type Auth = ConnectorView["auth"];
type Transport = ConnectorView["transport"];

const AUTHS: Auth[] = ["none", "bearer", "oauth"];
const TRANSPORTS: Transport[] = ["http", "sse"];
const POLICIES: Policy[] = ["allow", "ask", "block"];
const ERRORS = [
    "failed",
    "invalid",
    "limit",
    "duplicate",
    "address",
    "host",
    "rate_limited",
    "connectors_off",
    "no_metadata",
    "no_pkce",
    "no_registration",
    "insecure",
    "token_refused",
    "invalid_answer",
    "refused",
    "unreachable"
] as const;
type ErrorCode = (typeof ERRORS)[number];
const isErrorCode = (code: unknown): code is ErrorCode =>
    typeof code === "string" && (ERRORS as readonly string[]).includes(code);

/** Whether a typed address can be a server at all; the server decides the rest. */
function looksLikeServer(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username;
    } catch {
        return false;
    }
}

async function send(path: string, init: RequestInit): Promise<{ ok: boolean; body: any }> {
    const response = await fetch(path, {
        ...init,
        headers: init.body ? { "content-type": "application/json" } : undefined
    }).catch(() => null);
    if (!response) return { ok: false, body: { error: "unreachable" } };
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
}

export function PolarConnectors({
    initial,
    returned
}: {
    initial: ConnectorView[];
    /** How a sign-in that just came back went, from the callback. */
    returned: "signed_in" | "failed" | null;
}) {
    const t = useTranslations("account");
    const [rows, setRows] = useState(initial);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(
        returned === "failed" ? t("polarConnectors.errors.signInFailed") : null
    );
    const [busy, setBusy] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ConnectorView | null>(null);
    const [open, setOpen] = useState<string | null>(null);

    const say = (code: unknown) =>
        setError(t(`polarConnectors.errors.${isErrorCode(code) ? code : "failed"}`));
    const replace = (view: ConnectorView) =>
        setRows((current) => current.map((row) => (row.id === view.id ? view : row)));

    async function patch(row: ConnectorView, optimistic: ConnectorView, body: unknown) {
        setError(null);
        replace(optimistic);
        const answer = await send(`/api/polar/connectors/${row.id}`, {
            method: "PATCH",
            body: JSON.stringify(body)
        });
        if (answer.ok) replace(answer.body.connector);
        else {
            replace(row);
            say(answer.body.error);
        }
    }

    async function test(row: ConnectorView) {
        setError(null);
        setBusy(row.id);
        const answer = await send(`/api/polar/connectors/${row.id}/test`, { method: "POST" });
        setBusy(null);
        if (answer.ok) {
            replace(answer.body.connector);
            setOpen(row.id);
        } else say(answer.body.error);
    }

    async function signIn(row: ConnectorView) {
        setError(null);
        setBusy(row.id);
        const answer = await send(`/api/polar/connectors/${row.id}/sign-in`, { method: "POST" });
        if (answer.ok && typeof answer.body.url === "string") {
            window.location.assign(answer.body.url);
            return;
        }
        setBusy(null);
        say(answer.body.error);
    }

    async function remove(row: ConnectorView) {
        setError(null);
        setRemoving(null);
        setRows((current) => current.filter((entry) => entry.id !== row.id));
        const answer = await send(`/api/polar/connectors/${row.id}`, { method: "DELETE" });
        if (!answer.ok && answer.body.error !== "not_found") {
            setRows((current) => [...current, row]);
            say(answer.body.error);
        }
    }

    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{t("polarConnectors.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("polarConnectors.intro")}</p>
                    <p className="text-xs text-foreground-subtle">
                        {t("polarConnectors.reverse")}{" "}
                        <Link href="/account/assistants" className="text-primary hover:underline">
                            {t("polarConnectors.reverseLink")}
                        </Link>
                    </p>
                </div>
                {rows.length > 0 ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setAdding(true)}
                    >
                        <Plug className="h-3.5 w-3.5 shrink-0" />
                        {t("polarConnectors.add")}
                    </Button>
                ) : null}
            </div>
            {returned === "signed_in" ? (
                <p role="status" className="text-sm text-success-ink">
                    {t("polarConnectors.signedIn")}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <AddConnector
                open={adding}
                onOpenChange={setAdding}
                onAdded={(view) => {
                    setError(null);
                    setRows((current) => [...current, view]);
                    setAdding(false);
                    setOpen(view.id);
                    if (view.auth === "oauth" && !view.signedIn) void signIn(view);
                }}
            />
            {rows.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                            {t("polarConnectors.empty")}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setAdding(true)}
                        >
                            <Plug className="h-3.5 w-3.5 shrink-0" />
                            {t("polarConnectors.add")}
                        </Button>
                    </CardBody>
                </Card>
            ) : null}
            {rows.map((row) => (
                <Card key={row.id}>
                    <CardBody className="flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                aria-expanded={open === row.id}
                                onClick={() => setOpen(open === row.id ? null : row.id)}
                            >
                                <ChevronDown
                                    className={cn(
                                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                                        open === row.id ? "" : "-rotate-90"
                                    )}
                                />
                                <span className="min-w-0">
                                    <span
                                        className="block truncate text-sm font-medium"
                                        title={row.name}
                                    >
                                        {row.name}
                                    </span>
                                    <span
                                        className="block truncate text-xs text-muted-foreground"
                                        title={row.url}
                                    >
                                        {row.url}
                                    </span>
                                </span>
                            </button>
                            <StatusBadge row={row} />
                            <Switch
                                checked={row.enabled}
                                aria-label={t("polarConnectors.enabled", { name: row.name })}
                                onChange={(enabled) =>
                                    void patch(row, { ...row, enabled }, { enabled })
                                }
                            />
                        </div>
                        {row.status === "error" ? (
                            <p role="status" className="text-xs text-danger">
                                {t(
                                    `polarConnectors.errors.${isErrorCode(row.lastError) ? row.lastError : "failed"}`
                                )}
                            </p>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                            {row.auth === "oauth" && (!row.signedIn || row.status === "sign_in") ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={busy === row.id}
                                    onClick={() => void signIn(row)}
                                >
                                    <LogIn className="h-3.5 w-3.5 shrink-0" />
                                    {t("polarConnectors.signIn")}
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy === row.id}
                                onClick={() => void test(row)}
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-3.5 w-3.5 shrink-0",
                                        busy === row.id && "animate-spin"
                                    )}
                                />
                                {t("polarConnectors.test")}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={t("polarConnectors.removeLabel", { name: row.name })}
                                title={t("polarConnectors.removeLabel", { name: row.name })}
                                onClick={() => setRemoving(row)}
                            >
                                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            </Button>
                        </div>
                        {open === row.id ? (
                            row.tools.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("polarConnectors.noTools")}
                                </p>
                            ) : (
                                <ul className="flex flex-col divide-y divide-border">
                                    {row.tools.map((tool) => (
                                        <li
                                            key={tool.name}
                                            className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="flex items-center gap-2 text-sm">
                                                    <span className="truncate" title={tool.name}>
                                                        {tool.title}
                                                    </span>
                                                    {!tool.readOnly ? (
                                                        <Badge
                                                            variant={
                                                                tool.destructive
                                                                    ? "warning"
                                                                    : "neutral"
                                                            }
                                                        >
                                                            {t("polarConnectors.writes")}
                                                        </Badge>
                                                    ) : null}
                                                </p>
                                                {tool.description ? (
                                                    <p
                                                        className="line-clamp-2 text-xs text-muted-foreground"
                                                        title={tool.description}
                                                    >
                                                        {tool.description}
                                                    </p>
                                                ) : null}
                                            </div>
                                            <SegmentedControl<Policy>
                                                size="sm"
                                                value={tool.policy}
                                                aria-label={t("polarConnectors.policyLabel", {
                                                    tool: tool.title
                                                })}
                                                options={POLICIES.map((value) => ({
                                                    value,
                                                    label: t(`polarConnectors.policy.${value}`)
                                                }))}
                                                onValueChange={(policy) =>
                                                    void patch(
                                                        row,
                                                        {
                                                            ...row,
                                                            tools: row.tools.map((entry) =>
                                                                entry.name === tool.name
                                                                    ? { ...entry, policy }
                                                                    : entry
                                                            )
                                                        },
                                                        { tool: { name: tool.name, policy } }
                                                    )
                                                }
                                            />
                                        </li>
                                    ))}
                                </ul>
                            )
                        ) : null}
                    </CardBody>
                </Card>
            ))}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={t("polarConnectors.kind")}
                description={t("polarConnectors.removeHint")}
                onConfirm={() => removing && void remove(removing)}
            />
        </section>
    );
}

function StatusBadge({ row }: { row: ConnectorView }) {
    const t = useTranslations("account");
    const status = row.auth === "oauth" && !row.signedIn ? "sign_in" : row.status;
    const variant =
        status === "ok"
            ? "success"
            : status === "error"
              ? "danger"
              : status === "sign_in"
                ? "warning"
                : "neutral";
    return (
        <Badge variant={variant} className="shrink-0">
            {t(`polarConnectors.status.${status}`)}
        </Badge>
    );
}

function AddConnector({
    open,
    onOpenChange,
    onAdded
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (view: ConnectorView) => void;
}) {
    const t = useTranslations("account");
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [auth, setAuth] = useState<Auth>("none");
    const [transport, setTransport] = useState<Transport>("http");
    const [token, setToken] = useState("");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [advanced, setAdvanced] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const urlBad = url.trim() !== "" && !looksLikeServer(url);
    const complete =
        name.trim() !== "" && looksLikeServer(url) && (auth !== "bearer" || token.trim() !== "");

    // Closing starts over: a secret typed into a dialog that was put away does
    // not wait in the page for the next one.
    function reset() {
        setName("");
        setUrl("");
        setAuth("none");
        setTransport("http");
        setToken("");
        setClientId("");
        setClientSecret("");
        setAdvanced(false);
        setError(null);
    }

    function close() {
        if (pending) return;
        reset();
        onOpenChange(false);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!complete || pending) return;
        setPending(true);
        setError(null);
        const answer = await send("/api/polar/connectors", {
            method: "POST",
            body: JSON.stringify({
                name,
                url,
                auth,
                transport,
                ...(auth === "bearer" ? { token } : {}),
                ...(auth === "oauth" && clientId.trim()
                    ? { clientId, ...(clientSecret.trim() ? { clientSecret } : {}) }
                    : {})
            })
        });
        setPending(false);
        if (answer.ok) {
            reset();
            onAdded(answer.body.connector);
            return;
        }
        const code: unknown = answer.body.error;
        setError(t(`polarConnectors.errors.${isErrorCode(code) ? code : "failed"}`));
    }

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("polarConnectors.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("polarConnectors.dialogBody")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.name")} *</span>
                        <Input
                            value={name}
                            maxLength={40}
                            autoFocus
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("polarConnectors.namePlaceholder")}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.url")} *</span>
                        <Input
                            value={url}
                            maxLength={2048}
                            inputMode="url"
                            aria-invalid={urlBad || undefined}
                            onChange={(event) => setUrl(event.target.value)}
                            placeholder={t("polarConnectors.urlPlaceholder")}
                        />
                        {urlBad ? (
                            <span className="text-xs text-danger">
                                {t("polarConnectors.urlInvalid")}
                            </span>
                        ) : null}
                    </label>
                    <div className="flex flex-col gap-1 text-sm">
                        <span>{t("polarConnectors.auth")}</span>
                        <SegmentedControl<Auth>
                            size="sm"
                            value={auth}
                            aria-label={t("polarConnectors.auth")}
                            options={AUTHS.map((value) => ({
                                value,
                                label: t(`polarConnectors.authKind.${value}`)
                            }))}
                            onValueChange={setAuth}
                        />
                    </div>
                    {auth === "bearer" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("polarConnectors.token")} *</span>
                            <Input
                                type="password"
                                autoComplete="off"
                                value={token}
                                maxLength={4096}
                                onChange={(event) => setToken(event.target.value)}
                            />
                        </label>
                    ) : null}
                    {auth === "oauth" ? (
                        <p className="text-xs text-muted-foreground">
                            {t("polarConnectors.oauthHint")}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
                        aria-expanded={advanced}
                        onClick={() => setAdvanced(!advanced)}
                    >
                        <ChevronDown
                            className={cn(
                                "h-3.5 w-3.5 shrink-0 transition-transform",
                                advanced ? "" : "-rotate-90"
                            )}
                        />
                        {t("polarConnectors.advanced")}
                    </button>
                    {advanced ? (
                        <div className="flex flex-col gap-3">
                            {auth === "oauth" ? (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span>{t("polarConnectors.clientId")}</span>
                                    <Input
                                        value={clientId}
                                        maxLength={512}
                                        autoComplete="off"
                                        onChange={(event) => setClientId(event.target.value)}
                                    />
                                </label>
                            ) : null}
                            {auth === "oauth" && clientId.trim() ? (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span>{t("polarConnectors.clientSecret")}</span>
                                    <Input
                                        type="password"
                                        autoComplete="off"
                                        value={clientSecret}
                                        maxLength={4096}
                                        onChange={(event) => setClientSecret(event.target.value)}
                                    />
                                </label>
                            ) : null}
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("polarConnectors.transport")}</span>
                                <SegmentedControl<Transport>
                                    size="sm"
                                    value={transport}
                                    aria-label={t("polarConnectors.transport")}
                                    options={TRANSPORTS.map((value) => ({
                                        value,
                                        label: t(`polarConnectors.transportKind.${value}`)
                                    }))}
                                    onValueChange={setTransport}
                                />
                            </div>
                        </div>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={close}>
                            {t("polarConnectors.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!complete || pending} disabled={pending}>
                            {auth === "oauth"
                                ? t("polarConnectors.addAndSignIn")
                                : t("polarConnectors.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
