"use client";

/**
 * Add a server, either way round.
 *
 * The quick way runs a generated command on the machine and lets it register
 * itself; nothing secret is typed and Polaris pins the host key the machine
 * committed to. The manual way is the original SSH form, for a box that cannot
 * run the script (Windows, an appliance) or credentials that already exist: it
 * test-connects to validate them and captures the host key to pin.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { QuickEnroll } from "./quick-enroll";
import { createHostAction } from "./actions";
import { useState, type FormEvent } from "react";
import { ENVIRONMENT_CHOICES, environmentWords } from "./environment-meta";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    environmentFromAddress,
    SSH_AUTH_METHODS,
    type ServerEnvironment,
    type SshAuthMethod
} from "@polaris/core";
import {
    Input,
    Button,
    Dialog,
    Select,
    Textarea,
    DialogClose,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogTrigger,
    DialogDescription
} from "@polaris/ui";


/** Which way the operator is adding this one. Quick leads, because it is the one
 *  that does not ask anybody to paste a private key into a browser. */
type AddMode = "quick" | "manual";

export function HostDialog() {
    const t = useTranslations("servers");
    const tc = useTranslations("components");
    const tcommon = useTranslations("common");
    const environmentOptions = [
        ...ENVIRONMENT_CHOICES.map((value) => ({ value, label: environmentWords(tc, value).label })),
        { value: "unknown", label: t("host.notSure") }
    ];
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<AddMode>("quick");
    const [authMethod, setAuthMethod] = useState<SshAuthMethod>("password");
    const [environment, setEnvironment] = useState<ServerEnvironment>("unknown");
    const [environmentPicked, setEnvironmentPicked] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const str = (key: string) => {
            const value = form.get(key);
            return value ? String(value) : undefined;
        };

        const config = {
            address: str("address"),
            port: Number(str("port") ?? 22),
            username: str("username"),
            authMethod,
            environment
        };
        const credentials =
            authMethod === "password"
                ? { method: "password", password: str("password") }
                : { method: "key", privateKey: str("privateKey"), passphrase: str("passphrase") };

        const result = await createHostAction({ name: str("name"), config, credentials });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setOpen(false);
        router.refresh();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                // The form fields unmount with the dialog, so clear the derived
                // location too instead of carrying it into the next server.
                if (next) {
                    setMode("quick");
                    setEnvironment("unknown");
                    setEnvironmentPicked(false);
                    setError(null);
                }
                setOpen(next);
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" />
                    {t("host.add")}
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("host.title")}</DialogTitle>
                    <DialogDescription>{t("host.intro")}</DialogDescription>
                </DialogHeader>

                <div className="mb-1 flex gap-1 rounded-md bg-muted/40 p-1">
                    <ModeTab active={mode === "quick"} onClick={() => setMode("quick")}>
                        {t("host.quick")}
                    </ModeTab>
                    <ModeTab active={mode === "manual"} onClick={() => setMode("manual")}>
                        {t("host.manual")}
                    </ModeTab>
                </div>

                {mode === "quick" ? <QuickEnroll onDone={() => setOpen(false)} /> : null}

                {mode !== "manual" ? null : (
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("host.name")}
                        <Input name="name" required placeholder="nas-01" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("host.address")}
                        <Input
                            name="address"
                            required
                            placeholder="192.168.1.10"
                            onChange={(event) => {
                                if (environmentPicked) return;
                                setEnvironment(environmentFromAddress(event.target.value));
                            }}
                        />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("host.port")}
                            <Input name="port" type="number" defaultValue="22" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("host.username")}
                            <Input name="username" required />
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("host.where")}
                        <Select
                            value={environment}
                            onValueChange={(value) => {
                                setEnvironment(value as ServerEnvironment);
                                setEnvironmentPicked(true);
                            }}
                            options={environmentOptions}
                        />
                        <span className="text-xs text-muted-foreground">
                            {environmentWords(tc, environment).routing}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("host.auth")}
                        <Select
                            value={authMethod}
                            onValueChange={(value) => setAuthMethod(value as SshAuthMethod)}
                            options={SSH_AUTH_METHODS.map((value) => ({
                                value,
                                label: value === "password" ? t("host.password") : t("host.privateKey")
                            }))}
                        />
                    </label>

                    {authMethod === "password" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            {t("host.password")}
                            <Input name="password" type="password" required />
                        </label>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("host.pem")}
                                <Textarea
                                    name="privateKey"
                                    required
                                    rows={4}
                                    className="rounded-md border border-border bg-surface px-3 py-1 text-sm"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("host.passphrase")}
                                <Input name="passphrase" type="password" />
                            </label>
                        </>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                {tcommon("actions.cancel")}
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? t("host.connecting") : t("host.add")}
                        </Button>
                    </div>
                </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** One side of the segmented switch at the top of the dialog. */
function ModeTab({
    active,
    onClick,
    children
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`flex-1 rounded border px-3 py-1 text-[0.8125rem] font-medium transition-colors duration-fast ${
                active
                    ? "border-border-strong bg-card-hover text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
        >
            {children}
        </button>
    );
}
