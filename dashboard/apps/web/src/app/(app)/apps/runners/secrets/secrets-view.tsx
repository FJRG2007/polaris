"use client";

/**
 * The secrets of each pool: what they are called, which repositories can read
 * them, and nothing else until somebody asks.
 *
 * A value is never part of the list. Revealing one is its own request and its own
 * line in the audit log, which is why the eye is a button rather than a toggle
 * that quietly had the value all along.
 *
 * Scope is the repository, because that is what a runner is registered against.
 * A pool-wide secret reaches everything the pool serves; one scoped to a
 * repository reaches that repository's jobs and no others, and overrides a
 * pool-wide one of the same name.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import type { RunnerSecretView } from "@/lib/runners/runner-secrets";
import {
    deleteRunnerSecretAction,
    revealRunnerSecretAction,
    setRunnerSecretAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

interface PoolSecrets {
    id: string;
    name: string;
    perRepo: boolean;
    targets: string[];
    secrets: RunnerSecretView[];
}

export function SecretsView({ pools }: { pools: PoolSecrets[] }) {
    const t = useTranslations("runners");
    if (pools.length === 0) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-2">
                    <p className="text-sm">{t("secrets.noPool")}</p>
                    <p className="max-w-lg text-xs text-muted-foreground">{t("secrets.noPoolHint")}</p>
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/apps/runners">{t("dialog.add")}</Link>
                    </Button>
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <p className="max-w-2xl text-xs text-muted-foreground">
                {t.rich("secrets.intro", {
                    // i18n-ignore a variable name, as a workflow step writes it
                    env: () => <code key="env">$NAME</code>,
                    // i18n-ignore GitHub's own expression syntax
                    github: () => <code key="github">{"${{ secrets.NAME }}"}</code>
                })}
            </p>
            {pools.map((pool) => (
                <PoolCard key={pool.id} pool={pool} />
            ))}
        </div>
    );
}

function PoolCard({ pool }: { pool: PoolSecrets }) {
    const t = useTranslations("runners");
    const [adding, setAdding] = useState(false);

    return (
        <Card>
            <CardHeader className="flex items-center justify-between gap-2">
                <CardTitle>{pool.name}</CardTitle>
                <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    {t("secrets.add")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
                {pool.secrets.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("secrets.none")}</p>
                ) : (
                    <ul className="flex flex-col">
                        {pool.secrets.map((secret) => (
                            <SecretRow key={secret.id} secret={secret} />
                        ))}
                    </ul>
                )}
            </CardBody>
            {adding ? <SecretDialog pool={pool} onClose={() => setAdding(false)} /> : null}
        </Card>
    );
}

function SecretRow({ secret }: { secret: RunnerSecretView }) {
    const t = useTranslations("runners");
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [shown, setShown] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <li className="flex items-center justify-between gap-3 border-t border-border py-2 first:border-0 first:pt-0">
            <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    <code className="truncate text-sm">{secret.key}</code>
                    {secret.scopeKey ? (
                        <Badge variant="neutral">{secret.scopeKey}</Badge>
                    ) : (
                        <Badge variant="neutral">{t("runs.everyRepository")}</Badge>
                    )}
                </span>
                {shown ? (
                    /* Wraps rather than clips: the only reason to press Show is
                       to read or copy the whole secret, and a token has no word
                       boundaries to break on - so it breaks anywhere. */
                    <code className="break-all pl-5 text-xs text-muted-foreground">{shown}</code>
                ) : null}
                {error ? <span className="pl-5 text-xs text-danger">{error}</span> : null}
            </span>
            <span className="flex shrink-0 items-center gap-1">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={shown ? t("secrets.hideNamed", { name: secret.key }) : t("secrets.showNamed", { name: secret.key })}
                    title={shown ? t("secrets.hide") : t("secrets.show")}
                    disabled={pending}
                    onClick={() => {
                        setError(null);
                        if (shown) {
                            setShown(null);
                            return;
                        }
                        startTransition(async () => {
                            const result = await revealRunnerSecretAction(secret.id);
                            if (result.error) setError(result.error);
                            else setShown(result.value ?? "");
                        });
                    }}
                >
                    {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("pools.removeNamed", { name: secret.key })}
                    title={t("pools.remove")}
                    disabled={pending}
                    onClick={() => setConfirming(true)}
                >
                    <Trash2 className="size-4" />
                </Button>
            </span>

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={secret.key}
                kind={t("secrets.kind")}
                requireTyping={false}
                description={t("secrets.removeBody")}
                confirmLabel={t("pools.remove")}
                pending={pending}
                onConfirm={() =>
                    startTransition(async () => {
                        const result = await deleteRunnerSecretAction(secret.id);
                        if (result.error) setError(result.error);
                        else router.refresh();
                    })
                }
            />
        </li>
    );
}

function SecretDialog({ pool, onClose }: { pool: PoolSecrets; onClose: () => void }) {
    const t = useTranslations("runners");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [scope, setScope] = useState("");
    const [error, setError] = useState<string | null>(null);

    // The same rules the server holds, so the form refuses before a round trip
    // rather than after one. The server checks them again regardless.
    const nameProblem =
        key.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())
            ? t("secrets.nameShape")
            : /^(GITHUB_|RUNNER_|ACTIONS_)/i.test(key.trim())
              ? t("secrets.reservedPrefix")
              : null;
    const valueProblem = /[\r\n]/.test(value) ? t("secrets.oneLine") : null;
    const ready = key.trim().length > 0 && value.length > 0 && !nameProblem && !valueProblem;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("secrets.addTo", { name: pool.name })}</DialogTitle>
                    <DialogDescription>{t("secrets.addHint")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!ready) return;
                        setError(null);
                        startTransition(async () => {
                            const result = await setRunnerSecretAction({
                                poolId: pool.id,
                                key: key.trim(),
                                value,
                                scopeKey: scope
                            });
                            if (result.error) {
                                setError(result.error);
                                return;
                            }
                            onClose();
                            router.refresh();
                        });
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        {t("dialog.name")}
                        <Input
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            placeholder="REGISTRY_TOKEN" // i18n-ignore an example variable name
                            autoFocus
                        />
                        {nameProblem ? (
                            <span className="text-xs text-danger">{nameProblem}</span>
                        ) : null}
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        {t("secrets.value")}
                        <Input
                            type="password"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            autoComplete="off"
                        />
                        {valueProblem ? (
                            <span className="text-xs text-danger">{valueProblem}</span>
                        ) : null}
                    </label>

                    {pool.perRepo && pool.targets.length > 0 ? (
                        <label className="flex flex-col gap-1 text-sm">
                            {t("secrets.readableBy")}
                            <Select
                                value={scope}
                                onValueChange={setScope}
                                options={[
                                    { value: "", label: t("secrets.everyServed") },
                                    ...pool.targets.map((target) => ({
                                        value: target,
                                        label: target
                                    }))
                                ]}
                            />
                            <span className="text-xs text-muted-foreground">{t("secrets.overrideHint")}</span>
                        </label>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={!ready || pending}>
                            {t("repos.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
