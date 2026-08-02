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
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "./environment-meta";
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

const AUTH_LABELS: Record<SshAuthMethod, string> = {
    password: "Password",
    key: "Private key"
};

const ENVIRONMENT_OPTIONS = [
    ...ENVIRONMENT_CHOICES.map((value) => ({ value, label: ENVIRONMENT_META[value].label })),
    { value: "unknown", label: "Not sure yet" }
];

/** Which way the operator is adding this one. Quick leads, because it is the one
 *  that does not ask anybody to paste a private key into a browser. */
type AddMode = "quick" | "manual";

export function HostDialog() {
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
                    Add server
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add a server</DialogTitle>
                    <DialogDescription>
                        An SSH host, reusable in Containers (Docker) and Drive (SFTP).
                    </DialogDescription>
                </DialogHeader>

                <div className="mb-1 flex gap-1 rounded-md bg-muted/40 p-1">
                    <ModeTab active={mode === "quick"} onClick={() => setMode("quick")}>
                        Run a command
                    </ModeTab>
                    <ModeTab active={mode === "manual"} onClick={() => setMode("manual")}>
                        Enter SSH details
                    </ModeTab>
                </div>

                {mode === "quick" ? <QuickEnroll onDone={() => setOpen(false)} /> : null}

                {mode !== "manual" ? null : (
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input name="name" required placeholder="nas-01" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Address
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
                            Port
                            <Input name="port" type="number" defaultValue="22" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Username
                            <Input name="username" required />
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        Where it lives
                        <Select
                            value={environment}
                            onValueChange={(value) => {
                                setEnvironment(value as ServerEnvironment);
                                setEnvironmentPicked(true);
                            }}
                            options={ENVIRONMENT_OPTIONS}
                        />
                        <span className="text-xs text-muted-foreground">
                            {ENVIRONMENT_META[environment].routing}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Authentication
                        <Select
                            value={authMethod}
                            onValueChange={(value) => setAuthMethod(value as SshAuthMethod)}
                            options={SSH_AUTH_METHODS.map((value) => ({
                                value,
                                label: AUTH_LABELS[value]
                            }))}
                        />
                    </label>

                    {authMethod === "password" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            Password
                            <Input name="password" type="password" required />
                        </label>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Private key (PEM)
                                <Textarea
                                    name="privateKey"
                                    required
                                    rows={4}
                                    className="rounded-md border border-input bg-surface px-3 py-1 text-sm"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Key passphrase (optional)
                                <Input name="passphrase" type="password" />
                            </label>
                        </>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? "Connecting..." : "Add server"}
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
            className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
                active ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
        >
            {children}
        </button>
    );
}
