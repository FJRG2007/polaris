"use client";

/**
 * Add a Docker host. The default is the local host over the install-provisioned
 * SSH key (no secret to enter); a mounted socket or a remote SSH/TCP host are the
 * other options. Values are assembled into the transport config and (only when a
 * secret is entered) credentials, then validated again server-side.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { DOCKER_TRANSPORTS, type DockerTransport } from "@polaris/docker/schema";
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
import { createDockerConnectionAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function DockerConnectionDialog({ sshEnabled }: { sshEnabled: boolean }) {
    const t = useTranslations("containers");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [transport, setTransport] = useState<DockerTransport>(sshEnabled ? "ssh" : "socket");
    const [useInstallKey, setUseInstallKey] = useState(true);
    const [tls, setTls] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "");
        const str = (key: string) => {
            const value = form.get(key);
            return value ? String(value) : undefined;
        };

        let config: Record<string, unknown>;
        let credentials: Record<string, unknown>;
        if (transport === "socket") {
            config = {
                transport: "socket",
                socketPath: str("socketPath") ?? "/var/run/docker.sock"
            };
            credentials = { transport: "socket" };
        } else if (transport === "ssh") {
            config = {
                transport: "ssh",
                host: str("host"),
                port: Number(str("port") ?? 22),
                username: str("username"),
                useInstallKey
            };
            credentials = useInstallKey
                ? { transport: "ssh" }
                : {
                      transport: "ssh",
                      privateKey: str("privateKey"),
                      passphrase: str("passphrase")
                  };
        } else {
            config = {
                transport: "tcp",
                host: str("host"),
                port: Number(str("port") ?? 2375),
                tls
            };
            credentials = tls
                ? { transport: "tcp", ca: str("ca"), cert: str("cert"), key: str("key") }
                : { transport: "tcp" };
        }

        const result = await createDockerConnectionAction({ name, config, credentials });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setOpen(false);
        router.refresh();
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" />
                    {t("connection.add")}
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("connection.title")}</DialogTitle>
                    <DialogDescription>{t("connection.intro")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("connection.transport")}
                        <Select
                            value={transport}
                            onValueChange={(value) => setTransport(value as DockerTransport)}
                            options={DOCKER_TRANSPORTS.map((value) => ({
                                value,
                                label: t(`connection.transports.${value}`)
                            }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("connection.name")}
                        <Input name="name" required placeholder={t("connection.namePlaceholder")} />
                    </label>

                    {transport === "socket" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            {t("connection.socketPath")}
                            <Input name="socketPath" placeholder="/var/run/docker.sock" />
                        </label>
                    ) : null}

                    {transport === "ssh" ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("connection.host")}
                                <Input name="host" required defaultValue="host.docker.internal" />
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("connection.port")}
                                    <Input name="port" type="number" defaultValue="22" />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("connection.username")}
                                    <Input name="username" required />
                                </label>
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={useInstallKey}
                                    onChange={(event) => setUseInstallKey(event.target.checked)}
                                />
                                {sshEnabled ? t("connection.installKey") : t("connection.installKeyNone")}
                            </label>
                            {useInstallKey ? null : (
                                <>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("connection.privateKey")}
                                        <Textarea
                                            name="privateKey"
                                            rows={4}
                                            className="rounded-md border border-border bg-surface px-3 py-1 text-sm"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("connection.passphrase")}
                                        <Input name="passphrase" type="password" />
                                    </label>
                                </>
                            )}
                        </>
                    ) : null}

                    {transport === "tcp" ? (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("connection.host")}
                                    <Input name="host" required />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("connection.port")}
                                    <Input name="port" type="number" defaultValue="2375" />
                                </label>
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={tls}
                                    onChange={(event) => setTls(event.target.checked)}
                                />
                                {t("connection.tls")}
                            </label>
                            {tls ? (
                                <>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("connection.ca")}
                                        <Textarea
                                            name="ca"
                                            rows={3}
                                            className="rounded-md border border-border bg-surface px-3 py-1 text-sm"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("connection.cert")}
                                        <Textarea
                                            name="cert"
                                            rows={3}
                                            className="rounded-md border border-border bg-surface px-3 py-1 text-sm"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("connection.key")}
                                        <Textarea
                                            name="key"
                                            rows={3}
                                            className="rounded-md border border-border bg-surface px-3 py-1 text-sm"
                                        />
                                    </label>
                                </>
                            ) : null}
                        </>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                {tcommon("actions.cancel")}
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? t("connection.connecting") : t("connection.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
