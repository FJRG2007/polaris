"use client";

/**
 * Moderation: who is on right now, who runs the server, who is allowed in and
 * who is not. Every action is one RCON command and takes effect in the running
 * game, so the list is re-read from the server afterwards rather than guessed at
 * locally - the server is the record, not this screen.
 */

import { useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, CardBody, Input, Switch } from "@polaris/ui";
import type { MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";
import { Ban, Crown, DoorOpen, ShieldMinus, ShieldPlus, UserMinus, UserPlus } from "lucide-react";
import { moderatePlayerAction, setWhitelistEnforcedAction, type MinecraftModeration } from "./minecraft-actions";

export function MinecraftPlayers({
    installedAppId,
    status,
    roster,
    onChanged
}: {
    installedAppId: string;
    status: MinecraftStatus | null;
    roster: MinecraftRoster | null;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [confirm, confirmElement] = useConfirm();
    const answering = status?.answering ?? false;

    function moderate(input: Omit<MinecraftModeration, "installedAppId">): void {
        setError(null);
        startTransition(async () => {
            const result = await moderatePlayerAction({ ...input, installedAppId });
            if (result.error) {
                setError(result.error);
                return;
            }
            onChanged();
        });
    }

    async function moderateWithConfirm(
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ): Promise<void> {
        if (!(await confirm({ title, description, confirmLabel: "Confirm", danger: true }))) return;
        moderate(input);
    }

    if (!answering) {
        return (
            <Card>
                <CardBody className="py-8 text-center text-sm text-muted-foreground">
                    {status?.message ?? "Connecting to the server..."}
                </CardBody>
            </Card>
        );
    }

    const online = status?.players.players ?? [];
    const ops = roster?.ops ?? [];
    const whitelist = roster?.whitelist ?? [];
    const bans = roster?.bans ?? [];

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}

            <Section
                title="Online"
                count={online.length}
                empty="Nobody is playing right now."
                loading={roster === null && online.length === 0}
            >
                {online.map((player) => (
                    <Row key={player} name={player} badge={ops.includes(player) ? "Operator" : null}>
                        <IconAction
                            label={ops.includes(player) ? `Remove ${player} as operator` : `Make ${player} an operator`}
                            icon={ops.includes(player) ? <ShieldMinus className="size-4" /> : <ShieldPlus className="size-4" />}
                            disabled={pending}
                            onClick={() => moderate({ action: ops.includes(player) ? "deop" : "op", player })}
                        />
                        <IconAction
                            label={`Kick ${player}`}
                            icon={<DoorOpen className="size-4" />}
                            disabled={pending}
                            onClick={() =>
                                void moderateWithConfirm(
                                    { action: "kick", player },
                                    `Kick ${player}?`,
                                    "They are disconnected and can join again straight away."
                                )
                            }
                        />
                        <IconAction
                            label={`Ban ${player}`}
                            icon={<Ban className="size-4" />}
                            danger
                            disabled={pending}
                            onClick={() =>
                                void moderateWithConfirm(
                                    { action: "ban", player },
                                    `Ban ${player}?`,
                                    "They are disconnected and cannot rejoin until the ban is lifted."
                                )
                            }
                        />
                    </Row>
                ))}
            </Section>

            <Section
                title="Operators"
                count={ops.length}
                empty="No operators yet. An operator can run any command in the game."
                loading={roster === null}
                form={
                    <AddPlayer
                        label="Make an operator"
                        pending={pending}
                        onAdd={(player) => moderate({ action: "op", player })}
                    />
                }
            >
                {ops.map((player) => (
                    <Row key={player} name={player} icon={<Crown className="size-4 text-warning" />}>
                        <IconAction
                            label={`Remove ${player} as operator`}
                            icon={<ShieldMinus className="size-4" />}
                            disabled={pending}
                            onClick={() => moderate({ action: "deop", player })}
                        />
                    </Row>
                ))}
            </Section>

            <WhitelistSection
                installedAppId={installedAppId}
                whitelist={whitelist}
                enforced={roster?.whitelistEnforced ?? false}
                loading={roster === null}
                pending={pending}
                onAdd={(player) => moderate({ action: "whitelist-add", player })}
                onRemove={(player) => moderate({ action: "whitelist-remove", player })}
                onError={setError}
                onChanged={onChanged}
            />

            <Section title="Banned" count={bans.length} empty="Nobody is banned." loading={roster === null}>
                {bans.map((ban) => (
                    <Row key={ban.name} name={ban.name} note={ban.reason ?? undefined}>
                        <IconAction
                            label={`Lift the ban on ${ban.name}`}
                            icon={<UserPlus className="size-4" />}
                            disabled={pending}
                            onClick={() => moderate({ action: "pardon", player: ban.name })}
                        />
                    </Row>
                ))}
            </Section>

            {confirmElement}
        </div>
    );
}

/** The whitelist, with the switch that decides whether it is enforced at all -
 *  a list nobody is checked against is the commonest way to think you are
 *  private and not be. */
function WhitelistSection({
    installedAppId,
    whitelist,
    enforced,
    loading,
    pending,
    onAdd,
    onRemove,
    onError,
    onChanged
}: {
    installedAppId: string;
    whitelist: readonly string[];
    enforced: boolean;
    loading: boolean;
    pending: boolean;
    onAdd: (player: string) => void;
    onRemove: (player: string) => void;
    onError: (message: string | null) => void;
    onChanged: () => void;
}) {
    const [enforcing, startEnforcing] = useTransition();

    function setEnforced(enforced: boolean): void {
        onError(null);
        startEnforcing(async () => {
            const result = await setWhitelistEnforcedAction(installedAppId, enforced);
            if (result.error) {
                onError(result.error);
                return;
            }
            onChanged();
        });
    }

    return (
        <Section
            title="Whitelist"
            count={whitelist.length}
            empty="The whitelist is empty. Turn it on and only the players here can join."
            loading={loading}
            action={
                <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{enforced ? "Enforced" : "Not enforced"}</span>
                    <Switch
                        checked={enforced}
                        onChange={setEnforced}
                        disabled={enforcing || loading}
                        aria-label="Enforce the whitelist"
                    />
                </div>
            }
            form={<AddPlayer label="Add to the whitelist" pending={pending} onAdd={onAdd} />}
        >
            {whitelist.map((player) => (
                <Row key={player} name={player}>
                    <IconAction
                        label={`Remove ${player} from the whitelist`}
                        icon={<UserMinus className="size-4" />}
                        disabled={pending}
                        onClick={() => onRemove(player)}
                    />
                </Row>
            ))}
        </Section>
    );
}

function Section({
    title,
    count,
    empty,
    loading,
    action,
    form,
    children
}: {
    title: string;
    count: number;
    empty: string;
    loading: boolean;
    action?: React.ReactNode;
    form?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                        {title} <span className="text-muted-foreground">{count > 0 ? count : ""}</span>
                    </p>
                    {action}
                </div>
                {form}
                {loading ? (
                    <p className="py-3 text-sm text-muted-foreground">Reading the server...</p>
                ) : count === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">{empty}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60">{children}</ul>
                )}
            </CardBody>
        </Card>
    );
}

function Row({
    name,
    note,
    badge,
    icon,
    children
}: {
    name: string;
    note?: string;
    badge?: string | null;
    icon?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <li className="flex items-center gap-2 py-2">
            {icon}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={name}>{name}</p>
                {note && <p className="truncate text-xs text-muted-foreground" title={note}>{note}</p>}
            </div>
            {badge && <Badge>{badge}</Badge>}
            <div className="flex items-center gap-1">{children}</div>
        </li>
    );
}

function IconAction({
    label,
    icon,
    onClick,
    disabled,
    danger
}: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <Button
            size="sm"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={danger ? "text-danger hover:text-danger" : undefined}
        >
            {icon}
        </Button>
    );
}

/** Minecraft's own rule for a name, so a typo is caught here instead of coming
 *  back as a console error. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

function AddPlayer({ label, pending, onAdd }: { label: string; pending: boolean; onAdd: (player: string) => void }) {
    const [value, setValue] = useState("");
    const trimmed = value.trim();
    const invalid = trimmed.length > 0 && !PLAYER_NAME.test(trimmed);

    function submit(): void {
        if (invalid || trimmed.length === 0) return;
        onAdd(trimmed);
        setValue("");
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <Input
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && submit()}
                    placeholder="Player name"
                    aria-label={label}
                    className="h-9"
                />
                <Button size="sm" onClick={submit} disabled={pending || invalid || trimmed.length === 0}>
                    <UserPlus className="size-4" /> Add
                </Button>
            </div>
            {invalid && <p className="text-xs text-danger">A player name is 1-16 letters, digits or underscores</p>}
        </div>
    );
}
