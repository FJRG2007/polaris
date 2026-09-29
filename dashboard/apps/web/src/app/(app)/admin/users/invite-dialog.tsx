"use client";

/**
 * Inviting someone. The plain form is an address and a role; everything that
 * narrows the invite - how it travels, a one-time password, and where it may be
 * accepted from - sits behind Advanced options, because most invites need none
 * of it and an operator who does need it knows what they are looking for.
 *
 * What comes back is shown once and cannot be retrieved afterwards: the link and
 * the code are stored only as hashes, which is what makes a database dump
 * useless for joining an instance.
 */

import { useRouter } from "next/navigation";
import { createInviteAction } from "./actions";
import { useZodForm } from "@/lib/use-zod-form";
import { useState, type FormEvent } from "react";
import type { RoleOption } from "@/lib/role-service";
import { CopyButton } from "@/components/copy-button";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronDown, Mail, Wand2 } from "lucide-react";
import { createInviteSchema, formatInviteCode, type InviteMethod } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    cn
} from "@polaris/ui";
import {
    AccessRulesEditor,
    accessRulesAreEmpty,
    EMPTY_ACCESS_RULES,
    type AccessGroupOption,
    type AccessRulesValue
} from "@/components/access-rules-editor";

/** How an invite can travel, in the order an operator is likely to want them. */
const METHODS: readonly InviteMethod[] = ["link", "magic", "code"];

/** What was created, held only until the dialog closes. */
interface Issued {
    url?: string;
    code?: string;
    sendError?: string;
}

export function InviteDialog({
    groups,
    roles,
    canSendMail,
    onOpenChange
}: {
    groups: AccessGroupOption[];
    /** The roles this instance defines, and whether each opens anything. */
    roles: RoleOption[];
    /** Whether this deployment can send mail at all, which gates the magic link. */
    canSendMail: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const form = useZodForm(createInviteSchema);
    const [values, setValues] = useState({ email: "", role: "member" });
    const [method, setMethod] = useState<InviteMethod>("link");
    const [advanced, setAdvanced] = useState(false);
    const [usePassword, setUsePassword] = useState(false);
    const [oneTimePassword, setOneTimePassword] = useState("");
    const [rules, setRules] = useState<AccessRulesValue>(EMPTY_ACCESS_RULES);
    const [issued, setIssued] = useState<Issued | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    function update(field: "email" | "role", value: string) {
        const next = { ...values, [field]: value };
        setValues(next);
        form.revalidate({ ...next, ...rules, method });
    }

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        const parsed = form.submit({
            ...values,
            ...rules,
            method,
            oneTimePassword: usePassword ? oneTimePassword : undefined
        });
        if (!parsed) return;
        setPending(true);
        setError(null);
        const result = await createInviteAction(parsed);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setIssued({
            url: result.url,
            code: result.code ? formatInviteCode(result.code) : undefined,
            sendError: result.sendError
        });
        router.refresh();
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("usersInvite.title")}</DialogTitle>
                    <DialogDescription>{t("usersInvite.description")}</DialogDescription>
                </DialogHeader>

                {issued ? (
                    <IssuedInvite issued={issued} onDone={() => onOpenChange(false)} />
                ) : (
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-1">
                                <label className="text-sm">{t("usersInvite.email")}</label>
                                <Input
                                    type="email"
                                    placeholder={t("usersInvite.emailPlaceholder")}
                                    value={values.email}
                                    onChange={(event) => update("email", event.target.value)}
                                    onBlur={() => form.markTouched("email")}
                                    aria-invalid={Boolean(form.error("email"))}
                                />
                                {form.error("email") ? (
                                    <p className="text-xs text-danger">{form.error("email")}</p>
                                ) : null}
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-sm">{t("usersInvite.role")}</label>
                                <Select
                                    aria-label={t("usersInvite.role")}
                                    value={values.role}
                                    onValueChange={(value) => update("role", value)}
                                    options={roles.map((role) => ({
                                        value: role.name,
                                        label: role.name
                                    }))}
                                />
                                <p className="text-xs text-muted-foreground">
                                    {roles.find((role) => role.name === values.role)?.grants === 0
                                        ? t("usersInvite.roleNoApp")
                                        : t("usersInvite.roleHint")}
                                </p>
                            </div>
                        </div>

                        <fieldset className="flex flex-col gap-2">
                            <legend className="pb-1 text-sm">{t("usersInvite.method")}</legend>
                            {METHODS.map((option) => {
                                const unavailable = option === "magic" && !canSendMail;
                                return (
                                    <label
                                        key={option}
                                        className={cn(
                                            "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm transition-colors",
                                            method === option
                                                ? "border-primary bg-primary/5"
                                                : "border-border hover:bg-muted",
                                            unavailable && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <input
                                            type="radio"
                                            name="invite-method"
                                            className="mt-1"
                                            checked={method === option}
                                            disabled={unavailable}
                                            onChange={() => setMethod(option)}
                                        />
                                        <span className="min-w-0">
                                            <span className="block">
                                                {t(`usersInvite.methods.${option}.label`)}
                                            </span>
                                            <span className="block text-xs text-muted-foreground">
                                                {unavailable
                                                    ? t("usersInvite.noMail")
                                                    : t(`usersInvite.methods.${option}.hint`)}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </fieldset>

                        <div className="flex flex-col gap-3 border-t border-border pt-3">
                            <button
                                type="button"
                                onClick={() => setAdvanced((open) => !open)}
                                aria-expanded={advanced}
                                className="flex items-center gap-1 text-left text-sm text-muted-foreground hover:text-foreground"
                            >
                                <ChevronDown
                                    className={cn(
                                        "size-4 transition-transform",
                                        advanced && "rotate-180"
                                    )}
                                />
                                {t("usersInvite.advanced")}
                            </button>

                            {advanced ? (
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-sm">{t("usersInvite.otp.title")}</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {t("usersInvite.otp.hint")}
                                                </p>
                                            </div>
                                            <Switch
                                                checked={usePassword}
                                                aria-label={t("usersInvite.otp.switchLabel")}
                                                onChange={setUsePassword}
                                            />
                                        </div>
                                        {usePassword ? (
                                            <Input
                                                type="text"
                                                autoComplete="off"
                                                placeholder={t("usersInvite.otp.placeholder")}
                                                value={oneTimePassword}
                                                onChange={(event) =>
                                                    setOneTimePassword(event.target.value)
                                                }
                                            />
                                        ) : null}
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <div>
                                            <p className="text-sm">{t("usersInvite.where.title")}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {t("usersInvite.where.hint")}
                                            </p>
                                        </div>
                                        <AccessRulesEditor
                                            value={rules}
                                            groups={groups}
                                            onChange={setRules}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {accessRulesAreEmpty(rules) && !usePassword
                                        ? t("usersInvite.summaryNone")
                                        : t("usersInvite.summarySet")}
                                </p>
                            )}
                        </div>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                            >
                                {tc("actions.cancel")}
                            </Button>
                            <Button
                                type="submit"
                                disabled={
                                    pending || (usePassword && oneTimePassword.trim().length < 6)
                                }
                            >
                                {pending ? t("usersInvite.creating") : t("usersInvite.create")}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** The one and only sight of what was issued. */
function IssuedInvite({ issued, onDone }: { issued: Issued; onDone: () => void }) {
    const t = useTranslations("admin");
    return (
        <div className="flex flex-col gap-3">
            {issued.code ? (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="mb-1 text-xs text-muted-foreground">
                        {t("usersInvite.issued.readCode")}
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-lg tracking-widest">
                            {issued.code}
                        </code>
                        <CopyButton value={issued.code} label={t("usersInvite.issued.codeLabel")} />
                    </div>
                </div>
            ) : null}
            {issued.url ? (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {issued.sendError ? (
                            <Mail className="size-3.5" />
                        ) : (
                            <Wand2 className="size-3.5" />
                        )}
                        {issued.sendError
                            ? t("usersInvite.issued.sendYourself")
                            : t("usersInvite.issued.link")}
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate text-xs">{issued.url}</code>
                        <CopyButton value={issued.url} label={t("usersInvite.issued.linkLabel")} />
                    </div>
                </div>
            ) : null}
            {issued.sendError ? (
                <p className="text-sm text-warning">
                    {t("usersInvite.issued.sendError", { error: issued.sendError })}
                </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
                {t("usersInvite.issued.shownOnce")}
            </p>
            <div className="flex justify-end">
                <Button onClick={onDone}>{t("usersInvite.issued.done")}</Button>
            </div>
        </div>
    );
}
