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
const METHODS: { value: InviteMethod; label: string; hint: string }[] = [
    { value: "link", label: "Invite link", hint: "You copy the link and send it however you like." },
    { value: "magic", label: "Magic link by email", hint: "Polaris emails the link to the address you invited." },
    { value: "code", label: "Invitation code", hint: "A short code they type in at the sign-in page." }
];

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
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Invite someone</DialogTitle>
                    <DialogDescription>
                        They set their own name and password when they join. The invite is good for 7 days.
                    </DialogDescription>
                </DialogHeader>

                {issued ? (
                    <IssuedInvite issued={issued} onDone={() => onOpenChange(false)} />
                ) : (
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-1">
                                <label className="text-sm">Email</label>
                                <Input
                                    type="email"
                                    placeholder="teammate@example.com"
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
                                <label className="text-sm">Role</label>
                                <Select
                                    aria-label="Role"
                                    value={values.role}
                                    onValueChange={(value) => update("role", value)}
                                    options={roles.map((role) => ({ value: role.name, label: role.name }))}
                                />
                                <p className="text-xs text-muted-foreground">
                                    {roles.find((role) => role.name === values.role)?.grants === 0
                                        ? "Opens no app. The account exists so they can be identified - at a share link, a drop point, or anywhere that asks for a Polaris sign-in."
                                        : "What each role may do is set under Management > Roles."}
                                </p>
                            </div>
                        </div>

                        <fieldset className="flex flex-col gap-2">
                            <legend className="pb-1 text-sm">How it reaches them</legend>
                            {METHODS.map((option) => {
                                const unavailable = option.value === "magic" && !canSendMail;
                                return (
                                    <label
                                        key={option.value}
                                        className={cn(
                                            "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm transition-colors",
                                            method === option.value
                                                ? "border-primary bg-primary/5"
                                                : "border-border hover:bg-muted",
                                            unavailable && "cursor-not-allowed opacity-60"
                                        )}
                                    >
                                        <input
                                            type="radio"
                                            name="invite-method"
                                            className="mt-1"
                                            checked={method === option.value}
                                            disabled={unavailable}
                                            onChange={() => setMethod(option.value)}
                                        />
                                        <span className="min-w-0">
                                            <span className="block">{option.label}</span>
                                            <span className="block text-xs text-muted-foreground">
                                                {unavailable
                                                    ? "Needs an email channel: nominate one under Integrations."
                                                    : option.hint}
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
                                <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} />
                                Advanced options
                            </button>

                            {advanced ? (
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-sm">One-time password</p>
                                                <p className="text-xs text-muted-foreground">
                                                    Asked for on top of the link or code. Send it another way, so a
                                                    misdelivered invite is not enough on its own.
                                                </p>
                                            </div>
                                            <Switch
                                                checked={usePassword}
                                                aria-label="Require a one-time password"
                                                onChange={setUsePassword}
                                            />
                                        </div>
                                        {usePassword ? (
                                            <Input
                                                type="text"
                                                autoComplete="off"
                                                placeholder="At least 6 characters"
                                                value={oneTimePassword}
                                                onChange={(event) => setOneTimePassword(event.target.value)}
                                            />
                                        ) : null}
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <div>
                                            <p className="text-sm">Where they may connect from</p>
                                            <p className="text-xs text-muted-foreground">
                                                Bounds the invite and stays on the account afterwards, as a limit they
                                                cannot lift themselves. Leave empty for no restriction.
                                            </p>
                                        </div>
                                        <AccessRulesEditor value={rules} groups={groups} onChange={setRules} />
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {accessRulesAreEmpty(rules) && !usePassword
                                        ? "No one-time password, no address or country limits."
                                        : "One-time password or connection limits are set."}
                                </p>
                            )}
                        </div>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={pending || (usePassword && oneTimePassword.trim().length < 6)}
                            >
                                {pending ? "Creating..." : "Create invite"}
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
    return (
        <div className="flex flex-col gap-3">
            {issued.code ? (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="mb-1 text-xs text-muted-foreground">Read this code out to them:</p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 font-mono text-lg tracking-widest">{issued.code}</code>
                        <CopyButton value={issued.code} label="invitation code" />
                    </div>
                </div>
            ) : null}
            {issued.url ? (
                <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {issued.sendError ? <Mail className="size-3.5" /> : <Wand2 className="size-3.5" />}
                        {issued.sendError ? "Send it yourself:" : "The invite link:"}
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 truncate text-xs">{issued.url}</code>
                        <CopyButton value={issued.url} label="invite link" />
                    </div>
                </div>
            ) : null}
            {issued.sendError ? (
                <p className="text-sm text-warning">
                    The invite was created, but Polaris could not email it: {issued.sendError}
                </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
                This is shown once. Polaris keeps only a hash of it, so it cannot be looked up again.
            </p>
            <div className="flex justify-end">
                <Button onClick={onDone}>Done</Button>
            </div>
        </div>
    );
}
