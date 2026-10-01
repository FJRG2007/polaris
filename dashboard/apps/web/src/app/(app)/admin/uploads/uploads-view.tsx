"use client";

/**
 * Where the things people upload are kept: the files they attach to their work,
 * and the photos they put on their profile.
 *
 * Two separate choices rather than one, because they are not the same kind of
 * file. An attachment can be a phone video and is read once; a profile photo
 * weighs nothing and is read on every screen, so an instance may reasonably want
 * the photos on its own disk and the attachments on the NAS.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import type { FootageSettings } from "@/lib/footage-storage";
import type { AvatarSettings } from "@/lib/avatar-service";
import { NetworkStorageCard } from "./network-card";
import { ResolvedTarget, TargetPicker } from "./target-picker";
import type { WhereaboutsView } from "@/lib/storage-whereabouts/follow";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ChatStorageSettings } from "@/lib/chat/attachments";
import type { PersonalDriveSettings } from "@/lib/personal-drive";
import type { OrganizationDriveSettings } from "@/lib/organization-drive";
import type { UploadSettings } from "@/lib/tasks/attachment-service";
import { Button, Card, CardBody, ConfirmDeleteDialog, SizeField, Switch, cn } from "@polaris/ui";
import {
    checkStorageAction,
    setAvatarSettingsAction,
    setChatStorageTargetAction,
    setFootageTargetAction,
    setOrganizationDriveTargetAction,
    setPersonalDriveTargetAction,
    setUploadSettingsAction,
    tidyChatStorageAction,
    type StorageCheck
} from "./actions";

/** Megabytes are what people think in; the setting is stored in bytes. */
function toMegabytes(bytes: number): number {
    return Math.round(bytes / (1024 * 1024));
}

/**
 * Prove it works, rather than that it saved.
 *
 * Storage that takes a file and will not give it back looks exactly like storage
 * that works, right up until somebody opens a message from last week and gets
 * nothing. This writes a small file, reads it back and removes it - the same
 * three calls an upload and a download make - and says what happened.
 */
function CheckButton({ which }: { which: StorageCheck }) {
    const t = useTranslations("admin");
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ ok: boolean; detail: string; where: string } | null>(null);

    return (
        <div className="flex flex-col gap-1.5">
            <div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setSaid(null);
                        const result = await runAction(
                            () => checkStorageAction(which),
                            () => undefined
                        );
                        setBusy(false);
                        setSaid(
                            result ?? {
                                ok: false,
                                detail: t("uploads.check.failed"),
                                where: ""
                            }
                        );
                    }}
                >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {t("uploads.check.button")}
                </Button>
            </div>
            {said && (
                <p className={cn("text-xs", said.ok ? "text-muted-foreground" : "text-danger")}>
                    {said.where
                        ? t("uploads.check.result", { where: said.where, detail: said.detail })
                        : said.detail}
                </p>
            )}
        </div>
    );
}

/**
 * Take out the folders no conversation answers for.
 *
 * Only on the chat card, because that is the storage that grew them: a
 * conversation deleted by an older build left its whole folder behind, and a
 * message deleted one at a time left an empty one named after a uuid. Nothing
 * else will ever remove either, and neither is reachable from anywhere in
 * Polaris.
 *
 * Asked first, because what it does is a recursive delete on somebody's disk and
 * a press is not a decision. It runs against every storage the instance has ever
 * written chat files to - a NAS share other people may also be using among them -
 * and nothing puts back what it takes.
 *
 * What could not be removed is said as plainly as what was. A run where half the
 * folders refused and the line only counted the other half reads as a clean
 * sweep, which is how a full disk stays full.
 */
function TidyButton() {
    const t = useTranslations("admin");
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ detail: string; failed: boolean } | null>(null);

    const tidy = async () => {
        setBusy(true);
        setSaid(null);
        const result = await runAction(
            () => tidyChatStorageAction(),
            () => undefined
        );
        setBusy(false);
        setAsking(false);
        if (!result || result.error) {
            setSaid({ detail: result?.error ?? t("uploads.tidy.failed"), failed: true });
            return;
        }
        const removed = result.removed ?? 0;
        const failed = result.failed ?? 0;
        const took =
            removed === 0 ? t("uploads.tidy.nothing") : t("uploads.tidy.took", { count: removed });
        setSaid({
            detail: failed === 0 ? took : t("uploads.tidy.refused", { took, count: failed }),
            failed: failed > 0
        });
    };

    return (
        <div className="flex flex-col gap-1.5">
            <div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    title={t("uploads.tidy.tooltip")}
                    onClick={() => {
                        setSaid(null);
                        setAsking(true);
                    }}
                >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {t("uploads.tidy.button")}
                </Button>
            </div>
            {said && (
                <p className={cn("text-xs", said.failed ? "text-danger" : "text-muted-foreground")}>
                    {said.detail}
                </p>
            )}

            <ConfirmDeleteDialog
                open={asking}
                onOpenChange={(open) => !busy && setAsking(open)}
                requireTyping={false}
                name={t("uploads.tidy.name")}
                kind={t("uploads.tidy.kind")}
                title={t("uploads.tidy.title")}
                confirmLabel={t("uploads.tidy.button")}
                pending={busy}
                description={t("uploads.tidy.description")}
                question={t("uploads.tidy.question")}
                onConfirm={() => void tidy()}
            />
        </div>
    );
}

/** The Save row every card ends with, including what it says afterwards. */
function SaveRow({
    dirty,
    valid,
    saving,
    saved,
    error,
    onSave
}: {
    dirty: boolean;
    valid: boolean;
    saving: boolean;
    saved: boolean;
    error: string;
    onSave: () => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    return (
        <>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center gap-3">
                <Button onClick={onSave} disabled={!dirty || !valid || saving}>
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    {tc("actions.save")}
                </Button>
                {saved && !dirty && (
                    <span className="text-xs text-muted-foreground">{t("uploads.saved")}</span>
                )}
            </div>
        </>
    );
}

function AttachmentsCard({ settings }: { settings: UploadSettings }) {
    const t = useTranslations("admin");
    const [target, setTarget] = useState(settings.choice);
    const [megabytes, setMegabytes] = useState(String(toMegabytes(settings.maxBytes)));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const limit = Number(megabytes);
    const limitValid = Number.isFinite(limit) && limit >= 1 && limit <= 10240;
    const dirty = target !== settings.choice || toMegabytes(settings.maxBytes) !== limit;

    const save = async () => {
        if (!limitValid || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setUploadSettingsAction({ target, maxBytes: limit * 1024 * 1024 }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.attachments.title")}</h2>
                    <p className="text-xs text-muted-foreground">
                        {t("uploads.attachments.intro")}
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.files")}
                />

                <TargetPicker
                    label={t("uploads.whereThem")}
                    hint={t("uploads.attachments.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">{t("uploads.attachments.biggest")}</span>
                    <SizeField
                        value={Number(megabytes) || 0}
                        stored="MB"
                        min={1}
                        max={10240}
                        aria-label={t("uploads.attachments.biggest")}
                        onChange={(value) => {
                            setMegabytes(String(value));
                            setSaved(false);
                        }}
                    />
                    {!limitValid && (
                        <span className="text-xs text-danger">
                            {t("uploads.attachments.range")}
                        </span>
                    )}
                </label>

                <CheckButton which="tasks" />
                <SaveRow
                    dirty={dirty}
                    valid={limitValid}
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

function PhotosCard({ settings }: { settings: AvatarSettings }) {
    const t = useTranslations("admin");
    const [target, setTarget] = useState(settings.choice);
    const [gravatar, setGravatar] = useState(settings.gravatar);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== settings.choice || gravatar !== settings.gravatar;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setAvatarSettingsAction({ target, gravatar }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.photos.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.photos.intro")}</p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.photos")}
                />

                <TargetPicker
                    label={t("uploads.whereThem")}
                    hint={t("uploads.photos.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <label className="flex items-start justify-between gap-4">
                    <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{t("uploads.photos.gravatar")}</span>
                        <span className="text-xs text-muted-foreground">
                            {t("uploads.photos.gravatarHint")}
                        </span>
                    </span>
                    <Switch
                        checked={gravatar}
                        aria-label={t("uploads.photos.gravatar")}
                        onChange={(value) => {
                            setGravatar(value);
                            setSaved(false);
                        }}
                    />
                </label>

                <CheckButton which="avatars" />
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Where people's own drives are kept.
 *
 * First on this screen because it is the biggest thing the instance will ever
 * hold: everything else here is what somebody attached to something, and this is
 * everything they have. Changing it points the drives made from now on at the
 * new disk and moves nothing - a drive records where its files actually are when
 * it is made, so somebody who has been using Polaris for a year keeps opening
 * theirs where it is.
 */
function DrivesCard({ settings }: { settings: PersonalDriveSettings }) {
    const t = useTranslations("admin");
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;
    const made = settings.existing.reduce((total, row) => total + row.count, 0);
    // Only worth saying when it would surprise: drives already sitting somewhere
    // other than where this setting now points.
    const elsewhere = settings.existing.filter((row) => row.targetId !== settings.resolved.id);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setPersonalDriveTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.drives.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.drives.intro")}</p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.drives")}
                />

                <TargetPicker
                    label={t("uploads.whereThem")}
                    hint={t("uploads.drives.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                {made > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {elsewhere.length > 0
                            ? t("uploads.drives.madeElsewhere", {
                                  count: made,
                                  elsewhere: elsewhere.reduce((total, row) => total + row.count, 0)
                              })
                            : t("uploads.drives.made", { count: made })}
                    </p>
                )}

                <div>
                    <CheckButton which="drive" />
                </div>
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

function ChatCard({ settings }: { settings: ChatStorageSettings }) {
    const t = useTranslations("admin");
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setChatStorageTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.chat.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.chat.intro")}</p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.files")}
                />

                <TargetPicker
                    label={t("uploads.whereThem")}
                    hint={t("uploads.chat.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <div className="flex flex-wrap items-start gap-2">
                    <CheckButton which="chat" />
                    <TidyButton />
                </div>
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Camera footage.
 *
 * Its own card because it is not like the others: it is written by machines
 * rather than by people, it arrives all day, and it is the only kind here that
 * can fill a disk without anybody doing anything. A camera may still be pointed
 * at a disk of its own - that decision lives on the camera - and this is what
 * every camera that has not been is written to.
 */
function FootageCard({ settings }: { settings: FootageSettings }) {
    const t = useTranslations("admin");
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setFootageTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.footage.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.footage.intro")}</p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.footage")}
                />

                <TargetPicker
                    label={t("uploads.footage.where")}
                    hint={t("uploads.footage.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <CheckButton which="footage" />
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Where organizations' shelves are kept.
 *
 * Its own choice rather than the one above, because the two fill up for
 * different reasons: personal drives grow one person at a time, and a company's
 * holds the things everybody there works on. An instance may reasonably want the
 * company's documents on the NAS and everybody's own on the box.
 */
function OrganizationDrivesCard({ settings }: { settings: OrganizationDriveSettings }) {
    const t = useTranslations("admin");
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const made = settings.existing.reduce((total, row) => total + row.count, 0);
    const elsewhere = settings.existing.filter((row) => row.targetId !== settings.resolved.id);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setOrganizationDriveTargetAction({ target }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">{t("uploads.shelves.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("uploads.shelves.intro")}</p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic={t("uploads.automatic.shelves")}
                />

                <TargetPicker
                    label={t("uploads.whereThem")}
                    hint={t("uploads.shelves.hint")}
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                {made > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {elsewhere.length > 0
                            ? t("uploads.shelves.madeElsewhere", {
                                  count: made,
                                  elsewhere: elsewhere.reduce((total, row) => total + row.count, 0)
                              })
                            : t("uploads.shelves.made", { count: made })}
                    </p>
                )}

                <div>
                    <CheckButton which="orgDrive" />
                </div>
                <SaveRow
                    dirty={target !== initial}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

export function UploadsView({
    uploads,
    avatars,
    chat,
    drives,
    orgDrives,
    footage,
    network
}: {
    uploads: UploadSettings;
    avatars: AvatarSettings;
    chat: ChatStorageSettings;
    drives: PersonalDriveSettings;
    orgDrives: OrganizationDriveSettings;
    /** Absent on an instance with no Home installed - there is nothing recording,
     *  so a card about where recordings go would be a setting for a feature that
     *  is not there. */
    footage: FootageSettings | null;
    /** The storages reached at an address on the local network. */
    network: WhereaboutsView[];
}) {
    return (
        <div className="flex max-w-2xl flex-col gap-4">
            {network.length > 0 ? <NetworkStorageCard storages={network} /> : null}
            <DrivesCard settings={drives} />
            <OrganizationDrivesCard settings={orgDrives} />
            <AttachmentsCard settings={uploads} />
            <PhotosCard settings={avatars} />
            <ChatCard settings={chat} />
            {footage ? <FootageCard settings={footage} /> : null}
        </div>
    );
}
