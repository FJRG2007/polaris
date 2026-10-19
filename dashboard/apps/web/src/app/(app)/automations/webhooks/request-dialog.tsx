"use client";

/**
 * An endpoint's extra headers and sign-in. Secrets are write-only: one already
 * stored shows as set, with Replace; a field left alone keeps it, and nothing
 * stored is ever sent back to this page.
 */

import * as actions from "./actions";
import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { IconAction } from "@/components/icon-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OutboundHookView } from "@/lib/notifications/outbound-hooks";
import {
    MAX_WEBHOOK_HEADERS,
    WEBHOOK_REQUEST_ISSUES,
    webhookRequestInputSchema,
    type WebhookRequestIssue
} from "@polaris/core";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

type AuthType = "none" | "bearer" | "basic" | "header";

/** A write-only field: what was typed, and whether a stored value stands in for it. */
interface SecretField {
    value: string;
    stored: boolean;
    replacing: boolean;
}

interface HeaderRow {
    key: number;
    name: string;
    /** The name it was stored under: a stored secret only stands while it is kept. */
    storedName: string | null;
    secret: boolean;
    value: string;
    replacing: boolean;
}

const secretField = (stored: boolean): SecretField => ({ value: "", stored, replacing: false });

/** What a write-only field sends: nothing while the stored value stands. */
const sent = (field: SecretField) => (field.stored && !field.replacing ? undefined : field.value);

export function RequestDialog({
    hook,
    onClose,
    onSaved
}: {
    hook: OutboundHookView;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations("accountNotifications");
    const tc = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const initial = hook.request;
    const [authType, setAuthType] = useState<AuthType>(initial.auth.type);
    const [token, setToken] = useState(
        secretField(initial.auth.type === "bearer" && initial.auth.tokenSet)
    );
    const [username, setUsername] = useState(
        initial.auth.type === "basic" ? initial.auth.username : ""
    );
    const [password, setPassword] = useState(
        secretField(initial.auth.type === "basic" && initial.auth.passwordSet)
    );
    const [authName, setAuthName] = useState(
        initial.auth.type === "header" ? initial.auth.name : ""
    );
    const [authValue, setAuthValue] = useState(
        secretField(initial.auth.type === "header" && initial.auth.valueSet)
    );
    const [rows, setRows] = useState<HeaderRow[]>(() =>
        initial.headers.map((header, index) => ({
            key: index,
            name: header.name,
            storedName: header.secret && header.set ? header.name : null,
            secret: header.secret,
            value: header.value ?? "",
            replacing: false
        }))
    );
    const [nextKey, setNextKey] = useState(initial.headers.length);

    const rowKeeps = (row: HeaderRow) =>
        row.secret && !row.replacing && row.storedName !== null && row.storedName === row.name;
    const auth =
        authType === "bearer"
            ? { type: authType, token: sent(token) }
            : authType === "basic"
              ? { type: authType, username, password: sent(password) }
              : authType === "header"
                ? { type: authType, name: authName, value: sent(authValue) }
                : { type: authType };
    const input = {
        auth,
        headers: rows.map((row) => ({
            name: row.name,
            secret: row.secret,
            value: rowKeeps(row) ? undefined : row.value
        }))
    };
    const checked = webhookRequestInputSchema.safeParse(input);
    const baseline = JSON.stringify({
        auth:
            initial.auth.type === "basic"
                ? { type: "basic", username: initial.auth.username }
                : initial.auth.type === "header"
                  ? { type: "header", name: initial.auth.name }
                  : { type: initial.auth.type },
        headers: initial.headers.map((header) => ({
            name: header.name,
            secret: header.secret,
            value: header.secret ? undefined : (header.value ?? "")
        }))
    });
    const unchanged = JSON.stringify(input) === baseline;

    /** The issue on one field, in words - but not while it is still empty. */
    function issue(path: (string | number)[], typed: string): string | null {
        if (checked.success || typed.trim() === "") return null;
        const found = checked.error.issues.find((entry) => entry.path.join(".") === path.join("."));
        if (!found) return null;
        const code = WEBHOOK_REQUEST_ISSUES.includes(found.message as WebhookRequestIssue)
            ? (found.message as WebhookRequestIssue)
            : "required";
        return t(`webhooks.request.errors.${code}`);
    }

    function patch(key: number, change: Partial<HeaderRow>) {
        setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
    }

    function save() {
        if (!checked.success) return;
        setError(null);
        startTransition(async () => {
            const result = await actions.setOutboundHookRequestAction(hook.id, checked.data);
            if (result.error) return setError(result.error);
            onSaved();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("webhooks.request.title", { name: hook.name })}</DialogTitle>
                    <DialogDescription>{t("webhooks.request.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("webhooks.request.auth")}</span>
                        <Select
                            value={authType}
                            onValueChange={(value) => setAuthType(value as AuthType)}
                            options={[
                                { value: "none", label: t("webhooks.request.authNone") },
                                { value: "bearer", label: t("webhooks.request.authBearer") },
                                { value: "basic", label: t("webhooks.request.authBasic") },
                                { value: "header", label: t("webhooks.request.authHeader") }
                            ]}
                        />
                    </label>
                    {authType === "bearer" ? (
                        <SecretInput
                            label={t("webhooks.request.token")}
                            field={token}
                            onChange={setToken}
                            error={issue(["auth", "token"], token.value)}
                        />
                    ) : null}
                    {authType === "basic" ? (
                        <>
                            <Field
                                label={t("webhooks.request.username")}
                                error={issue(["auth", "username"], username)}
                            >
                                <Input
                                    value={username}
                                    maxLength={200}
                                    autoComplete="off"
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </Field>
                            <SecretInput
                                label={t("webhooks.request.password")}
                                field={password}
                                onChange={setPassword}
                                error={issue(["auth", "password"], password.value)}
                            />
                        </>
                    ) : null}
                    {authType === "header" ? (
                        <>
                            <Field
                                label={t("webhooks.request.headerName")}
                                error={issue(["auth", "name"], authName)}
                            >
                                <Input
                                    value={authName}
                                    maxLength={100}
                                    autoComplete="off"
                                    placeholder="X-Api-Key" // i18n-ignore a header name
                                    onChange={(event) => setAuthName(event.target.value)}
                                />
                            </Field>
                            <SecretInput
                                label={t("webhooks.request.headerValue")}
                                field={authValue}
                                onChange={setAuthValue}
                                error={issue(["auth", "value"], authValue.value)}
                            />
                        </>
                    ) : null}

                    <div className="flex flex-col gap-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{t("webhooks.request.headers")}</span>
                            <Button
                                size="xs"
                                variant="ghost"
                                disabled={rows.length >= MAX_WEBHOOK_HEADERS}
                                onClick={() => {
                                    setRows((current) => [
                                        ...current,
                                        {
                                            key: nextKey,
                                            name: "",
                                            storedName: null,
                                            secret: false,
                                            value: "",
                                            replacing: false
                                        }
                                    ]);
                                    setNextKey((key) => key + 1);
                                }}
                            >
                                <Plus className="size-4" />
                                {t("webhooks.request.addHeader")}
                            </Button>
                        </div>
                        {rows.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {t("webhooks.request.noHeaders")}
                            </p>
                        ) : (
                            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain">
                                {rows.map((row, index) => {
                                    const keeps = rowKeeps(row);
                                    const nameError = issue(["headers", index, "name"], row.name);
                                    const valueError = issue(
                                        ["headers", index, "value"],
                                        row.value
                                    );
                                    return (
                                        <li
                                            key={row.key}
                                            className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-2"
                                        >
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <Input
                                                    className="min-w-0 flex-1 basis-32"
                                                    value={row.name}
                                                    maxLength={100}
                                                    autoComplete="off"
                                                    aria-label={t("webhooks.request.headerName")}
                                                    placeholder={t("webhooks.request.headerName")}
                                                    onChange={(event) =>
                                                        patch(row.key, { name: event.target.value })
                                                    }
                                                />
                                                {keeps ? (
                                                    <span className="flex min-w-0 flex-1 basis-32 items-center gap-2 text-xs text-muted-foreground">
                                                        <span className="truncate">
                                                            {t("webhooks.request.secretSet")}
                                                        </span>
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() =>
                                                                patch(row.key, { replacing: true })
                                                            }
                                                        >
                                                            {t("webhooks.request.replace")}
                                                        </Button>
                                                    </span>
                                                ) : (
                                                    <Input
                                                        className="min-w-0 flex-1 basis-32"
                                                        type={row.secret ? "password" : "text"}
                                                        value={row.value}
                                                        autoComplete="off"
                                                        aria-label={t(
                                                            "webhooks.request.headerValue"
                                                        )}
                                                        placeholder={t(
                                                            "webhooks.request.headerValue"
                                                        )}
                                                        onChange={(event) =>
                                                            patch(row.key, {
                                                                value: event.target.value
                                                            })
                                                        }
                                                    />
                                                )}
                                                <label className="flex shrink-0 items-center gap-1 text-xs">
                                                    <Checkbox
                                                        checked={row.secret}
                                                        onChange={(change) =>
                                                            patch(row.key, {
                                                                secret: change.target.checked
                                                            })
                                                        }
                                                    />
                                                    {t("webhooks.request.secret")}
                                                </label>
                                                <IconAction
                                                    label={t("webhooks.request.removeHeader")}
                                                    danger
                                                    className="shrink-0"
                                                    onClick={() =>
                                                        setRows((current) =>
                                                            current.filter(
                                                                (entry) => entry.key !== row.key
                                                            )
                                                        )
                                                    }
                                                >
                                                    <Trash2 className="size-4" />
                                                </IconAction>
                                            </div>
                                            {nameError || valueError ? (
                                                <span className="text-xs text-danger">
                                                    {nameError ?? valueError}
                                                </span>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={save} disabled={pending || !checked.success || unchanged}>
                            {t("webhooks.form.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    error,
    children
}: {
    label: string;
    error: string | null;
    children: React.ReactNode;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">{label} *</span>
            {children}
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

/**
 * A write-only value: set and hidden with Replace, or a password field.
 *
 * enigma:allow-no-breach-check enigma:allow-identity-password - this is a
 * credential for somebody else's endpoint, typed as that endpoint issued it,
 * never a password for a Polaris account; refusing one would only break the
 * receiver it signs in to.
 */
function SecretInput({
    label,
    field,
    onChange,
    error
}: {
    label: string;
    field: SecretField;
    onChange: (next: SecretField) => void;
    error: string | null;
}) {
    const t = useTranslations("accountNotifications");
    if (field.stored && !field.replacing) {
        return (
            <div className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium">{label} *</span>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{t("webhooks.request.secretSet")}</span>
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onChange({ ...field, replacing: true })}
                    >
                        {t("webhooks.request.replace")}
                    </Button>
                </div>
            </div>
        );
    }
    return (
        <Field label={label} error={error}>
            <div className="flex min-w-0 items-center gap-2">
                <Input
                    className="min-w-0 flex-1"
                    type="password"
                    value={field.value}
                    autoComplete="new-password"
                    onChange={(event) => onChange({ ...field, value: event.target.value })}
                />
                {field.stored ? (
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onChange({ ...field, value: "", replacing: false })}
                    >
                        {t("webhooks.request.keep")}
                    </Button>
                ) : null}
            </div>
        </Field>
    );
}
