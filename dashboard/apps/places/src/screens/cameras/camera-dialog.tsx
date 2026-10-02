"use client";

/**
 * Adding a camera, or changing one.
 *
 * Four decisions, in the order somebody actually makes them: what and where it
 * is, how Polaris reaches it, what it should notice, and what to keep. The
 * detection section is the one that matters most and is written to be read -
 * every choice says what it costs the machine, because "person detection" with
 * no price attached is how a house ends up with eight cameras and a server at
 * 100%.
 *
 * The password is never sent back to the browser, so an empty field on an edit
 * means "leave it alone" rather than "clear it" - asking for the camera password
 * again to rename a camera is how people end up keeping it in a note.
 */

import * as actions from "../actions";
import Link from "next/link";
import type { CameraActivity } from "../../lib/vision-activity";
import { useEffect, useRef, useState } from "react";
import type { CameraView } from "../../lib/cameras";
import { CircleCheck, Loader2, Sparkles } from "lucide-react";
import { BrandPicker, ModelPicker } from "./model-picker";
import {
    cameraVendor,
    reportsOwnAlerts,
    usesAccountPassword,
    vendorMethod,
    vendorNote
} from "../../lib/vendors";
import { usePlacesT } from "../use-places-t";
import type { PlacesTranslator } from "../../lib/i18n";
import {
    BATTERY_COST_WARNING,
    POWER_SOURCES,
    modelNote,
    askPowerFor,
    cameraModel,
    connectionsFor,
    drawsFromBattery,
    vendorForModel,
    type PowerSource
} from "../../lib/camera-models";
import {
    DEFAULT_DETECTION,
    DETECTORS,
    LOCAL_MACHINE,
    OBJECT_CLASSES,
    needsSomewhereToRun,
    type Detector,
    type ObjectClass
} from "../../lib/detection";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";

const { runAction } = hostUi.runAction;

interface Server {
    id: string;
    label: string;
}

/** What the form holds. Strings for anything typed, so a half-typed port is a
 *  half-typed port rather than NaN. */
interface FormState {
    name: string;
    zone: string;
    vendor: string;
    /** Not stored: the make is a step on the way to the model, and the model is
     *  what a camera carries. Kept so the picker below it has something to
     *  narrow by before anything has been picked. */
    brand: string;
    modelId: string;
    power: PowerSource;
    address: string;
    rtspPort: string;
    onvifPort: string;
    mainPath: string;
    subPath: string;
    username: string;
    password: string;
    reachVia: string;
    detector: Detector;
    detectorTargetId: string;
    sensitivity: number;
    minGapSeconds: string;
    settleSeconds: string;
    classes: ObjectClass[];
    faceThreshold: string;
    hoursOn: boolean;
    hoursFrom: string;
    hoursTo: string;
    recording: "off" | "motion" | "continuous";
    storageTarget: string;
    retentionDays: string;
    enabled: boolean;
}

function initial(
    camera: CameraView | null,
    prefill: { address: string; vendor: string | null } | null,
    defaults: { sensitivity: number; settleSeconds: number; minGapSeconds: number } | null
): FormState {
    // An existing camera keeps what it was set to; a new one starts from
    // whatever this instance decided works here.
    const detection = camera?.detection ?? { ...DEFAULT_DETECTION, ...(defaults ?? {}) };
    return {
        name: camera?.name ?? "",
        zone: camera?.zone ?? "",
        // The make is still carried, because a camera added before the model
        // list existed has one and no model, and it is what keeps working.
        vendor: camera?.vendor ?? prefill?.vendor ?? "tapo-cloud",
        brand: cameraModel(camera?.modelId)?.brand ?? "",
        modelId: camera?.modelId ?? "",
        power: (camera?.power as PowerSource) ?? "mains",
        address: camera?.address ?? prefill?.address ?? "",
        rtspPort: String(camera?.rtspPort ?? 554),
        onvifPort: camera?.onvifPort ? String(camera.onvifPort) : "",
        mainPath: camera?.mainPath ?? "",
        subPath: camera?.subPath ?? "",
        username: camera?.username ?? "",
        password: "",
        reachVia: camera?.reachVia ?? "direct",
        detector: (camera?.detector as Detector) ?? "camera",
        detectorTargetId: camera?.detectorTargetId ?? LOCAL_MACHINE,
        sensitivity: detection.sensitivity,
        minGapSeconds: String(detection.minGapSeconds),
        settleSeconds: String(detection.settleSeconds),
        classes: [...detection.classes],
        faceThreshold: String(detection.faceThreshold),
        hoursOn: detection.hours !== null,
        hoursFrom: String(detection.hours?.from ?? 22),
        hoursTo: String(detection.hours?.to ?? 6),
        // A new camera keeps what it sees. Somebody adding a camera to a
        // house means "watch this", and a camera that notices things and keeps
        // none of them answers no question anybody had afterwards.
        recording: (camera?.recording as FormState["recording"]) ?? "motion",
        storageTarget: camera?.storageTarget ?? "",
        retentionDays: String(camera?.retentionDays ?? 7),
        enabled: camera?.enabled ?? true
    };
}

export function CameraDialog({
    camera,
    prefill = null,
    sharedPassword = false,
    servers,
    storage,
    defaults,
    onClose,
    onSaved
}: {
    camera: CameraView | null;
    /** A camera discovery found, being added: the address is known and the make
     *  is a guess worth starting from. */
    prefill?: { address: string; vendor: string | null } | null;
    /** Whether this house already holds a TP-Link account password. It is one
     *  password for every camera on the account, so the second one onwards does
     *  not have to be given it again - and the field must not demand it. */
    sharedPassword?: boolean;
    servers: Server[];
    /** The disks footage can be pointed at, the instance default first. */
    storage: { id: string; label: string }[];
    /** What a new camera starts out believing about movement. */
    defaults: { sensitivity: number; settleSeconds: number; minGapSeconds: number } | null;
    onClose: () => void;
    onSaved: (saved: CameraView) => void;
}) {
    const t = usePlacesT();
    const [form, setForm] = useState<FormState>(() => initial(camera, prefill, defaults));
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const [tested, setTested] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Whether faces are being put to names at all, for the rung that needs it.
     *  Null until asked - a warning drawn before the answer arrives is a warning
     *  about nothing. */
    const [recognizes, setRecognizes] = useState<boolean | null>(null);
    /** What this camera's detector has been doing, for the reader who opened
     *  this dialog because it has noticed nothing. Undefined until asked. */
    const [activity, setActivity] = useState<CameraActivity | null | undefined>(undefined);

    const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
        setForm((current) => ({ ...current, [key]: value }));

    /** The model decides the make. A camera from before the list keeps the make
     *  it was set up with, which is why this falls back rather than defaulting. */
    const model = cameraModel(form.modelId);
    /** What it is reached by: what it is on now, where the model still allows
     *  it, and the model's own first choice for one being set up. */
    const vendorId = vendorForModel(form.modelId, form.vendor);
    const vendor = cameraVendor(vendorId);
    /** The ways this model can be reached. Offered whenever there is more than
     *  one, because which of them to use is a real decision with a real cost and
     *  not something to resolve behind somebody's back. */
    const connections = connectionsFor(form.modelId);
    /** The server this camera is reached through, when it is not Polaris itself. */
    const reachedVia = form.reachVia.startsWith("server:")
        ? form.reachVia.slice("server:".length)
        : null;
    // A make with its own protocol has no paths and no account to fill in: the
    // password is the whole credential. Showing the fields anyway is how somebody
    // ends up typing a camera account into a form that ignores it.
    const usesRtsp = !vendor.nativeScheme;
    /** Whether this camera could ever report its own movement. */
    const ownAlerts = reportsOwnAlerts(form.vendor);
    /** Whether this one is asked how it is powered at all. */
    const askPower = askPowerFor(form.modelId);
    /** Whether watching it spends a charge rather than a wire. Its owner's
     *  answer, not the make's: the same model runs on a cable or on a pole. */
    const battery = drawsFromBattery(form.power);
    /** The rungs worth offering. One that cannot fire on this camera is not a
     *  cheaper setting, it is a setting that does nothing - and the whole point
     *  of this section is that every choice says what it costs. */
    const rungs = ownAlerts ? DETECTORS : DETECTORS.filter((id) => id !== "camera");

    // Asked once when the dialog opens rather than only when this rung is
    // picked: the answer decides what the picker says about a choice somebody is
    // still deciding on, and it is one small call.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.homeSettingsAction();
            if (!cancelled) setRecognizes(result.settings?.faceEnabled === true);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Only for a camera that exists. A camera being added has no detector
    // running yet, and a line saying so would be noise on the one screen where
    // somebody is busy.
    useEffect(() => {
        if (!camera?.id) return;
        let cancelled = false;
        const ask = async () => {
            const result = await actions.cameraActivityAction(camera.id);
            if (!cancelled) setActivity(result.activity ?? null);
        };
        void ask();
        // The worker publishes twice a minute; asking on the same cadence means
        // somebody walking in front of their own camera with this open sees it
        // register rather than having to close and reopen.
        const timer = setInterval(() => void ask(), 15_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [camera?.id]);

    useEffect(() => {
        setTested(null);
    }, [form.address, form.username, form.password, form.vendor]);

    /**
     * Settings the make that was just chosen cannot honour.
     *
     * Keyed on the make alone, so this happens when somebody picks one and never
     * again - a later choice of theirs is theirs. Two things move: the camera's
     * own alerts, which a make that speaks no ONVIF cannot send, and, on a
     * battery camera, recording, because recording it means watching it and
     * watching it is what the battery is for.
     */
    /**
     * What the camera was said to be running on last time this ran. Null until
     * the form has been drawn once, which is how a change made here is told from
     * the value the camera was opened with.
     */
    const wasPowered = useRef<PowerSource | null>(null);

    /**
     * Saying a camera is on its own charge is the answer to what Polaris may do
     * with it, so both of the settings that would hold its stream open go back
     * to off.
     *
     * Only when the answer CHANGES. On the way in it is left alone: a camera
     * whose owner deliberately set a detector on it, knowing the cost, must not
     * have that quietly undone because they opened the form to rename it.
     */
    useEffect(() => {
        const was = wasPowered.current;
        wasPowered.current = form.power;
        if (was === null || was === form.power || !drawsFromBattery(form.power)) return;
        setForm((current) => ({ ...current, detector: "none", recording: "off" }));
    }, [form.power]);

    useEffect(() => {
        const chosen = cameraVendor(vendorId);
        setForm((current) => {
            const next = { ...current };
            if (chosen.noOnvif && next.detector === "camera") next.detector = "none";
            // A camera that cannot run off a battery is not asked how it is
            // powered, so an answer left over from a model that was chosen and
            // then changed is cleared rather than stored.
            if (!askPowerFor(next.modelId)) next.power = "mains";
            if (drawsFromBattery(next.power) && !camera) next.recording = "off";
            return next;
        });
    }, [vendorId, form.modelId, form.power, camera]);

    /** Whether leaving the field empty means "use the one already stored for this
     *  account" rather than "connect with nothing". */
    const inheritsPassword =
        sharedPassword && usesAccountPassword(vendorId) && !camera?.hasPassword;
    /** On a make with its own protocol the password is the entire credential -
     *  there is no account name beside it - so an empty one cannot connect and
     *  is not worth a round trip to find that out. Unless there is one to
     *  inherit, in which case empty is the answer rather than an omission. */
    const needsPassword = !usesRtsp && !form.password && !camera?.hasPassword && !inheritsPassword;
    const incomplete = !form.name.trim() || !form.address.trim() || needsPassword;

    const payload = () => ({
        name: form.name,
        zone: form.zone,
        vendor: vendorId,
        modelId: form.modelId,
        power: form.power,
        address: form.address,
        rtspPort: Number(form.rtspPort) || 554,
        onvifPort: form.onvifPort ? Number(form.onvifPort) : null,
        mainPath: form.mainPath,
        subPath: form.subPath,
        username: form.username,
        // Only sent when something was typed, so an edit leaves the stored one be.
        ...(form.password ? { password: form.password } : {}),
        reachVia: form.reachVia,
        detector: form.detector,
        detectorTargetId: needsSomewhereToRun(form.detector) ? form.detectorTargetId : null,
        detection: {
            sensitivity: form.sensitivity,
            minGapSeconds: Number(form.minGapSeconds) || DEFAULT_DETECTION.minGapSeconds,
            settleSeconds: Number.isFinite(Number(form.settleSeconds))
                ? Number(form.settleSeconds)
                : DEFAULT_DETECTION.settleSeconds,
            classes: form.classes,
            faceThreshold: Number(form.faceThreshold) || DEFAULT_DETECTION.faceThreshold,
            hours: form.hoursOn
                ? { from: Number(form.hoursFrom) || 0, to: Number(form.hoursTo) || 0 }
                : null
        },
        recording: form.recording,
        storageTarget: form.storageTarget,
        retentionDays: Number(form.retentionDays) || 7,
        enabled: form.enabled
    });

    const test = async () => {
        setTesting(true);
        setError(null);
        const result = await runAction(() => actions.probeCameraAction(payload()), setError);
        if (!result?.probe || result.error) {
            setTesting(false);
            if (result) setError(result.error ?? t("dialog.noAnswer"));
            return;
        }
        // A saved camera gets a second call after this one, and the button has to
        // stay busy across both - so it is cleared here only for the answers that
        // end at the probe.
        const tryVideo = result.probe.verified === "reachable" && camera?.id;
        if (!tryVideo) setTesting(false);
        // What the camera said replaces what the make suggested - it is the only
        // authority on its own paths.
        setForm((current) => ({
            ...current,
            mainPath: result.probe?.mainPath || current.mainPath,
            subPath: result.probe?.subPath || current.subPath,
            name: current.name || result.probe?.model || ""
        }));
        // For a camera that exists, the reachable answer is not the end of it.
        // "Something is answering there" and no picture is exactly where this
        // was left before: the only place that knows why is the relay, and
        // asking it is one more call.
        if (tryVideo && camera) {
            const stream = await runAction(
                () => actions.testCameraStreamAction(camera.id),
                setError
            );
            setTesting(false);
            if (!stream) return;
            if (stream.error) {
                setError(t("dialog.videoFailed", { reason: stream.error }));
                return;
            }
            setTested(
                stream.streams === "main-only"
                    ? // Worth saying rather than hiding: it is the whole reason
                      // this camera drew nothing, and it means every picture of
                      // it now costs the full-size stream.
                      t("dialog.videoMainOnly")
                    : t("dialog.videoWorks")
            );
            return;
        }
        setTested(
            result.probe.verified === "reachable"
                ? // All that can be asked of a camera that speaks only its
                  // maker's protocol before it has been saved. Said plainly,
                  // because "the camera answered" over a password nobody checked
                  // is the reassurance that costs an evening.
                  t("dialog.somethingAnswers")
                : [result.probe.manufacturer, result.probe.model].filter(Boolean).join(" ") ||
                      t("dialog.answered")
        );
    };

    const save = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () => actions.saveCameraAction(camera?.id ?? null, payload()),
            setError
        );
        if (!result || result.error || !result.camera) {
            setBusy(false);
            if (result?.error) setError(result.error);
            return;
        }
        // Handing it to the relay is its own step and can take a while the first
        // time, so the dialog closes on the save and the list shows the camera
        // starting.
        void actions.startCameraAction(result.camera.id).catch(() => null);
        setBusy(false);
        onSaved(result.camera);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{camera ? camera.name : t("cameras.add")}</DialogTitle>
                    <DialogDescription>
                        {camera
                            ? t("dialog.editIntro")
                            : t("dialog.addIntro")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    <Section title={t("dialog.sections.camera")}>
                        <Field label={t("placeDialog.name")} required>
                            <Input
                                value={form.name}
                                onChange={(event) => set("name", event.target.value)}
                                placeholder={t("dialog.namePlaceholder")}
                            />
                        </Field>
                        <Field
                            label={t("dialog.zone")}
                            hint={t("dialog.zoneHint")}
                        >
                            <Input
                                value={form.zone}
                                onChange={(event) => set("zone", event.target.value)}
                                placeholder={t("dialog.zonePlaceholder")}
                            />
                        </Field>
                        <Field label={t("dialog.brand")} required>
                            <BrandPicker
                                value={form.brand}
                                onChange={(brand) =>
                                    setForm((current) => ({
                                        ...current,
                                        brand,
                                        // A model from the brand that was just
                                        // left is not a model of this one.
                                        modelId:
                                            cameraModel(current.modelId)?.brand === brand
                                                ? current.modelId
                                                : ""
                                    }))
                                }
                            />
                        </Field>
                        <Field
                            label={t("dialog.model")}
                            hint={t("dialog.modelHint")}
                            required
                        >
                            <ModelPicker
                                value={form.modelId}
                                brand={form.brand}
                                onChange={(modelId) =>
                                    setForm((current) => ({
                                        ...current,
                                        modelId,
                                        // Picking through a search that crossed
                                        // makes moves the make to match, rather
                                        // than leaving the two disagreeing.
                                        brand: cameraModel(modelId)?.brand ?? current.brand
                                    }))
                                }
                            />
                        </Field>
                        {/* More than one way in is the normal case, and they are
                            not equivalent - so the choice is offered, with the
                            one to take if you have no opinion marked as such
                            rather than merely listed first. */}
                        {connections.length > 1 ? (
                            <Field
                                label={t("dialog.connection")}
                                hint={t("dialog.connectionHint")}
                            >
                                <Select
                                    value={vendorId}
                                    onValueChange={(value) => set("vendor", value)}
                                    options={connections.map((id, index) => {
                                        const name = vendorMethod(id, t);
                                        return {
                                            value: id,
                                            label: index === 0 ? t("dialog.recommended", { name }) : name
                                        };
                                    })}
                                />
                            </Field>
                        ) : null}
                        {/* What is true of this model and not of its make - the
                            doorbells that answer RTSP only once they are wired
                            up, and nothing else. */}
                        {model && modelNote(model, t) ? (
                            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                                {modelNote(model, t)}
                            </p>
                        ) : null}
                        {askPower ? (
                            <Field
                                label={t("dialog.power")}
                                hint={t("dialog.powerHint")}
                            >
                                <Select
                                    value={form.power}
                                    onValueChange={(value) => set("power", value as PowerSource)}
                                    options={POWER_SOURCES.map((source) => ({
                                        value: source,
                                        label: t(`power.labels.${source}`)
                                    }))}
                                />
                            </Field>
                        ) : null}
                        {askPower ? (
                            <p
                                className={cn(
                                    "text-[0.75rem] leading-relaxed",
                                    battery &&
                                        (needsSomewhereToRun(form.detector) ||
                                            form.recording !== "off")
                                        ? "text-warning"
                                        : "text-muted-foreground"
                                )}
                            >
                                {battery &&
                                (needsSomewhereToRun(form.detector) || form.recording !== "off")
                                    ? t(BATTERY_COST_WARNING)
                                    : t(`power.notes.${form.power}`)}
                            </p>
                        ) : null}
                        {vendorNote(vendorId, t) ? (
                            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                                {vendorNote(vendorId, t)}
                            </p>
                        ) : null}
                        {/* Not a Polaris setting and not one Polaris can reach,
                            so the only thing to do with it is say it before the
                            camera refuses and the password gets the blame. */}
                        {vendor.appConsent ? (
                            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                                {t.rich("dialog.appConsent", {
                                    path: vendor.appConsent,
                                    em: (chunks) => <span className="text-foreground">{chunks}</span>
                                })}
                            </p>
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                            <Field label={t("dialog.address")} required>
                                <Input
                                    value={form.address}
                                    onChange={(event) => set("address", event.target.value)}
                                    placeholder="10.0.1.50"
                                />
                            </Field>
                            {usesRtsp ? (
                                <Field label={t("dialog.rtspPort")}>
                                    <Input
                                        value={form.rtspPort}
                                        onChange={(event) => set("rtspPort", event.target.value)}
                                        className="w-24"
                                        inputMode="numeric"
                                    />
                                </Field>
                            ) : null}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {usesRtsp ? (
                                <Field label={t("dialog.account")}>
                                    <Input
                                        value={form.username}
                                        onChange={(event) => set("username", event.target.value)}
                                        autoComplete="off"
                                    />
                                </Field>
                            ) : null}
                            <Field
                                label={usesRtsp ? t("dialog.password") : t("dialog.tapoPassword")}
                                required={!usesRtsp && !inheritsPassword}
                                hint={
                                    camera?.hasPassword
                                        ? t("dialog.passwordStored")
                                        : inheritsPassword
                                          ? t("dialog.passwordInherited")
                                          : usesRtsp
                                            ? undefined
                                            : // The question everybody asks at this
                                              // field, answered at it: the camera
                                              // checks the password by itself and
                                              // never asks who is presenting it,
                                              // so there is no address to give and
                                              // its absence is not a missing step.
                                              t("dialog.passwordTapo")
                                }
                            >
                                {/* enigma:allow-no-breach-check - nothing is being
                                    chosen here. This is the password the camera
                                    already has, set in its own app or on its own
                                    web page; refusing it for being weak would
                                    only stop Polaris connecting to a camera that
                                    is going to keep that password either way.
                                    enigma:allow-identity-password - and it
                                    belongs to a device, so there is no account
                                    identity for it to resemble. */}
                                <Input
                                    type="password"
                                    value={form.password}
                                    onChange={(event) => set("password", event.target.value)}
                                    autoComplete="off"
                                    placeholder={camera?.hasPassword ? t("dialog.unchanged") : ""}
                                />
                            </Field>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={test}
                                disabled={testing || incomplete}
                            >
                                {testing ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                ) : (
                                    <Sparkles className="size-4 shrink-0" />
                                )}
                                {t("dialog.ask")}
                            </Button>
                            {tested ? (
                                <span className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    {tested}
                                </span>
                            ) : null}
                        </div>
                        {usesRtsp ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field
                                    label={t("dialog.mainPath")}
                                    hint={t("dialog.mainPathHint")}
                                >
                                    <Input
                                        value={form.mainPath}
                                        onChange={(event) => set("mainPath", event.target.value)}
                                        placeholder={vendor.mainPath || "/stream1"}
                                    />
                                </Field>
                                <Field
                                    label={t("dialog.subPath")}
                                    hint={t("dialog.subPathHint")}
                                >
                                    <Input
                                        value={form.subPath}
                                        onChange={(event) => set("subPath", event.target.value)}
                                        placeholder={vendor.subPath ?? ""}
                                    />
                                </Field>
                            </div>
                        ) : null}
                    </Section>

                    <Section
                        title={t("dialog.sections.reach")}
                        hint={t("dialog.reachHint")}
                    >
                        <Select
                            value={form.reachVia}
                            onValueChange={(value) => set("reachVia", value)}
                            options={[
                                { value: "direct", label: t("dialog.direct") },
                                ...servers
                                    .filter((server) => server.id !== "local")
                                    .map((server) => ({
                                        value: `server:${server.id}`,
                                        label: server.label
                                    }))
                            ]}
                        />
                    </Section>

                    <Section title={t("dialog.sections.notice")}>
                        <Select
                            value={form.detector}
                            onValueChange={(value) => set("detector", value as Detector)}
                            options={rungs.map((id) => ({
                                value: id,
                                label: t(`detectors.${id}.label`)
                            }))}
                        />
                        <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                            {t(`detectors.${form.detector}.summary`)}{" "}
                            <span className="text-foreground-subtle">
                                {t(`detectors.${form.detector}.cost`)}
                            </span>
                        </p>
                        {/* Only when it is actually a problem. The line used to
                            be printed whenever this rung was chosen, so a house
                            with recognition running was warned that it had none,
                            and a house with it switched off read the same
                            sentence and had no way to tell the two apart. */}
                        {form.detector === "faces" && recognizes === false ? (
                            <p className="text-[0.75rem] leading-relaxed text-warning">
                                {t("detectors.faces.requires")}{" "}
                                <Link
                                    href="/places/settings"
                                    className="underline underline-offset-2"
                                >
                                    {t("dialog.openSettings")}
                                </Link>
                            </p>
                        ) : null}
                        {battery && needsSomewhereToRun(form.detector) ? (
                            <p className="text-[0.75rem] leading-relaxed text-warning">
                                {t(BATTERY_COST_WARNING)}
                            </p>
                        ) : null}
                        {battery && !ownAlerts && form.detector === "none" ? (
                            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                                {t("dialog.noOwnAlerts")}
                            </p>
                        ) : null}
                        {camera?.id && form.detector !== "none" ? (
                            <DetectorActivity activity={activity} />
                        ) : null}
                        {form.detector === "faces" && recognizes === true ? (
                            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                                {t("dialog.facesOn")}
                            </p>
                        ) : null}

                        {needsSomewhereToRun(form.detector) ? (
                            reachedVia ? (
                                // Not a choice: the stream is over there, and
                                // dragging it back across the link Polaris could
                                // not reach the camera over, to look at it here,
                                // would be the slowest possible way to do it.
                                <Field
                                    label={t("dialog.runsOn")}
                                    hint={t("dialog.runsOnHint")}
                                >
                                    <Input
                                        value={
                                            servers.find((server) => server.id === reachedVia)
                                                ?.label ?? reachedVia
                                        }
                                        readOnly
                                        className="w-64"
                                    />
                                </Field>
                            ) : (
                                <Field label={t("dialog.runsOn")}>
                                    <Select
                                        value={form.detectorTargetId}
                                        onValueChange={(value) => set("detectorTargetId", value)}
                                        options={servers.map((server) => ({
                                            value: server.id,
                                            label: server.label
                                        }))}
                                    />
                                </Field>
                            )
                        ) : null}

                        {form.detector !== "none" ? (
                            <>
                                {/* Only the rungs Polaris runs itself have a
                                    sensitivity to set: a camera doing its own
                                    looking has that setting in its own app. */}
                                {needsSomewhereToRun(form.detector) ? (
                                    <Field
                                        label={t("dialog.sensitivity", { value: form.sensitivity })}
                                        hint={t("dialog.sensitivityHint")}
                                    >
                                        <input
                                            type="range"
                                            min={1}
                                            max={100}
                                            value={form.sensitivity}
                                            onChange={(event) =>
                                                set("sensitivity", Number(event.target.value))
                                            }
                                            className="w-64 accent-primary"
                                            aria-label={t("dialog.sensitivityLabel")}
                                        />
                                    </Field>
                                ) : null}
                                <Field
                                    label={t("dialog.settle")}
                                    hint={t("dialog.settleHint")}
                                >
                                    <Input
                                        value={form.settleSeconds}
                                        onChange={(event) =>
                                            set("settleSeconds", event.target.value)
                                        }
                                        className="w-24"
                                        inputMode="numeric"
                                    />
                                </Field>
                                <Field
                                    label={t("dialog.gap")}
                                    hint={t("dialog.gapHint")}
                                >
                                    <Input
                                        value={form.minGapSeconds}
                                        onChange={(event) =>
                                            set("minGapSeconds", event.target.value)
                                        }
                                        className="w-24"
                                        inputMode="numeric"
                                    />
                                </Field>
                                <label className="flex items-center justify-between gap-3">
                                    <span className="text-[0.8125rem] text-foreground">
                                        {t("dialog.hours")}
                                    </span>
                                    <Switch
                                        checked={form.hoursOn}
                                        onChange={(value) => set("hoursOn", value)}
                                    />
                                </label>
                                {form.hoursOn ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            value={form.hoursFrom}
                                            onChange={(event) =>
                                                set("hoursFrom", event.target.value)
                                            }
                                            className="w-20"
                                            inputMode="numeric"
                                            aria-label={t("dialog.fromHour")}
                                        />
                                        <span className="text-[0.75rem] text-muted-foreground">
                                            {t("dialog.to")}
                                        </span>
                                        <Input
                                            value={form.hoursTo}
                                            onChange={(event) => set("hoursTo", event.target.value)}
                                            className="w-20"
                                            inputMode="numeric"
                                            aria-label={t("dialog.toHour")}
                                        />
                                        <span className="text-[0.75rem] text-foreground-subtle">
                                            {t("dialog.hoursHint")}
                                        </span>
                                    </div>
                                ) : null}
                            </>
                        ) : null}

                        {form.detector === "objects" || form.detector === "faces" ? (
                            <Field label={t("dialog.classes")}>
                                <div className="flex flex-wrap gap-3">
                                    {OBJECT_CLASSES.map((item) => (
                                        <label
                                            key={item}
                                            className="flex items-center gap-2 text-[0.8125rem]"
                                        >
                                            <Checkbox
                                                checked={form.classes.includes(item)}
                                                onChange={(event) =>
                                                    set(
                                                        "classes",
                                                        event.target.checked
                                                            ? [...form.classes, item]
                                                            : form.classes.filter(
                                                                  (value) => value !== item
                                                              )
                                                    )
                                                }
                                            />
                                            {t(`objects.${item}`)}
                                        </label>
                                    ))}
                                </div>
                                {form.classes.includes("package") ? (
                                    <p className="text-[0.75rem] text-foreground-subtle">
                                        {t("objects.packageHint")}
                                    </p>
                                ) : null}
                            </Field>
                        ) : null}

                        {form.detector === "faces" ? (
                            <Field
                                label={t("dialog.faceThreshold")}
                                hint={t("dialog.faceThresholdHint")}
                            >
                                <Input
                                    value={form.faceThreshold}
                                    onChange={(event) => set("faceThreshold", event.target.value)}
                                    className="w-24"
                                    inputMode="numeric"
                                />
                            </Field>
                        ) : null}
                    </Section>

                    <Section title={t("dialog.sections.keep")}>
                        <SegmentedControl
                            value={form.recording}
                            onValueChange={(value) =>
                                set("recording", value as FormState["recording"])
                            }
                            options={[
                                { value: "off", label: t("dialog.keep.off") },
                                { value: "motion", label: t("dialog.keep.motion") },
                                { value: "continuous", label: t("dialog.keep.continuous") }
                            ]}
                        />
                        {battery && form.recording !== "off" ? (
                            <p className="text-[0.75rem] leading-relaxed text-warning">
                                {t(BATTERY_COST_WARNING)}
                            </p>
                        ) : null}
                        {form.recording !== "off" ? (
                            <Field
                                label={t("dialog.storeOn")}
                                hint={t("dialog.storeOnHint")}
                            >
                                <Select
                                    value={form.storageTarget}
                                    onValueChange={(value) => set("storageTarget", value)}
                                    options={storage.map((option) => ({
                                        value: option.id,
                                        label: option.label
                                    }))}
                                />
                            </Field>
                        ) : null}
                        {form.recording !== "off" ? (
                            <Field label={t("dialog.keepFor")} hint={t("dialog.keepForHint")}>
                                <Input
                                    value={form.retentionDays}
                                    onChange={(event) => set("retentionDays", event.target.value)}
                                    className="w-24"
                                    inputMode="numeric"
                                />
                            </Field>
                        ) : null}
                        <label className="flex items-center justify-between gap-3">
                            <span className="text-[0.8125rem] text-foreground">
                                {t("dialog.enabled")}
                                <span className="block text-[0.75rem] text-foreground-subtle">
                                    {t("dialog.enabledHint")}
                                </span>
                            </span>
                            <Switch
                                checked={form.enabled}
                                onChange={(value) => set("enabled", value)}
                            />
                        </label>
                    </Section>
                </div>

                {error ? <p className="mt-4 text-[0.75rem] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={save} disabled={busy || incomplete}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {camera ? t("common.save") : t("dialog.addCamera")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Section({
    title,
    hint,
    children
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-3">
            <div>
                <h3 className="text-[0.8125rem] font-semibold text-foreground">{title}</h3>
                {hint ? (
                    <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted-foreground">
                        {hint}
                    </p>
                ) : null}
            </div>
            {children}
        </section>
    );
}

function Field({
    label,
    hint,
    required,
    children
}: {
    label: string;
    hint?: string;
    required?: boolean;
    children: React.ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className={cn("text-[0.75rem] font-medium text-muted-foreground")}>
                {label}
                {required ? <span className="text-danger"> *</span> : null}
            </span>
            {children}
            {hint ? <span className="text-[0.6875rem] text-foreground-subtle">{hint}</span> : null}
        </label>
    );
}

/**
 * What the detector has been doing, in one line.
 *
 * The screen that answers "it has noticed nothing". Every state that produces no
 * events looks identical from outside - nothing has moved, something moved and
 * was not a person, the worker has no model, the camera would not say how big
 * its picture is - and telling them apart used to mean opening a terminal and
 * reading a container's process list, which the person who owns these cameras
 * does not have and should not need.
 *
 * Ages rather than clock times, because the question is always "recently?" and
 * never "at what time". Nothing is hidden behind a hover.
 */
function DetectorActivity({ activity }: { activity: CameraActivity | null | undefined }) {
    const t = usePlacesT();
    if (activity === undefined) return <Skeleton className="h-4 w-64" />;
    if (activity === null) {
        return (
            <p className="text-[0.75rem] leading-relaxed text-warning">
                {t("activity.none")}
            </p>
        );
    }

    const lines = [
        activity.watching ? t("activity.watching") : t("activity.notWatching"),
        activity.motionAt
            ? t("activity.motion", { since: since(activity.motionAt, t) })
            : t("activity.noMotion"),
        activity.lookedAt
            ? activity.foundAt
                ? t("activity.found", {
                      looked: since(activity.lookedAt, t),
                      found: activity.found ?? t("activity.something"),
                      at: since(activity.foundAt, t)
                  })
                : t("activity.foundNothing", { looked: since(activity.lookedAt, t) })
            : null
    ].filter(Boolean);

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                {lines.join(" ")}
            </p>
            {activity.limitedTo ? (
                <p className="text-[0.75rem] leading-relaxed text-warning">
                    {t("activity.limited", { reason: limitReason(activity.limitedTo, t) })}
                </p>
            ) : null}
        </div>
    );
}

/** How long ago, in the words somebody reads a status line in. */
function since(at: number, t: PlacesTranslator): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 45) return t("activity.justNow");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("activity.minutesAgo", { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("activity.hoursAgo", { count: hours });
    return t("activity.daysAgo", { count: Math.round(hours / 24) });
}

/** The vision worker's two reasons for looking less than it was asked to,
 *  in the reader's words; anything else as the worker said it. */
function limitReason(reason: string, t: PlacesTranslator): string {
    if (reason === "this machine has no detection model, so movement only") return t("activity.noModel");
    if (reason === "the camera would not say how big its picture is, so movement only") {
        return t("activity.noSize");
    }
    return reason;
}
