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
import type { CameraActivity } from "@/lib/home/vision-activity";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { CameraView } from "@/lib/home/cameras";
import { CircleCheck, Loader2, Sparkles } from "lucide-react";
import { CAMERA_VENDORS, cameraVendor } from "@/lib/home/vendors";
import {
    DEFAULT_DETECTION,
    DETECTORS,
    DETECTOR_META,
    LOCAL_MACHINE,
    OBJECT_CLASSES,
    OBJECT_CLASS_HINTS,
    OBJECT_CLASS_LABELS,
    needsSomewhereToRun,
    type Detector,
    type ObjectClass
} from "@/lib/home/detection";
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
        vendor: camera?.vendor ?? prefill?.vendor ?? "tapo-cloud",
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
    servers: Server[];
    /** The disks footage can be pointed at, the instance default first. */
    storage: { id: string; label: string }[];
    /** What a new camera starts out believing about movement. */
    defaults: { sensitivity: number; settleSeconds: number; minGapSeconds: number } | null;
    onClose: () => void;
    onSaved: (saved: CameraView) => void;
}) {
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

    const vendor = cameraVendor(form.vendor);
    /** The server this camera is reached through, when it is not Polaris itself. */
    const reachedVia = form.reachVia.startsWith("server:")
        ? form.reachVia.slice("server:".length)
        : null;
    // A make with its own protocol has no paths and no account to fill in: the
    // password is the whole credential. Showing the fields anyway is how somebody
    // ends up typing a camera account into a form that ignores it.
    const usesRtsp = !vendor.nativeScheme;

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

    const incomplete = !form.name.trim() || !form.address.trim();

    const payload = () => ({
        name: form.name,
        zone: form.zone,
        vendor: form.vendor,
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
        setTesting(false);
        if (!result) return;
        if (result.error || !result.probe) {
            setError(result.error ?? "The camera did not answer.");
            return;
        }
        // What the camera said replaces what the make suggested - it is the only
        // authority on its own paths.
        setForm((current) => ({
            ...current,
            mainPath: result.probe?.mainPath || current.mainPath,
            subPath: result.probe?.subPath || current.subPath,
            name: current.name || result.probe?.model || ""
        }));
        setTested(
            [result.probe.manufacturer, result.probe.model].filter(Boolean).join(" ") ||
                "The camera answered"
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
                    <DialogTitle>{camera ? camera.name : "Add a camera"}</DialogTitle>
                    <DialogDescription>
                        {camera
                            ? "Change how this camera is reached, what it notices, and what is kept."
                            : "Polaris asks the camera what it streams, so most of this fills itself in."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    <Section title="The camera">
                        <Field label="Name" required>
                            <Input
                                value={form.name}
                                onChange={(event) => set("name", event.target.value)}
                                placeholder="Front door"
                            />
                        </Field>
                        <Field
                            label="Where it points"
                            hint="Groups the wall. Leave it blank if you only have a few."
                        >
                            <Input
                                value={form.zone}
                                onChange={(event) => set("zone", event.target.value)}
                                placeholder="Outside"
                            />
                        </Field>
                        <Field label="Make">
                            <Select
                                value={form.vendor}
                                onValueChange={(value) => set("vendor", value)}
                                options={CAMERA_VENDORS.map((item) => ({
                                    value: item.id,
                                    label: item.label
                                }))}
                            />
                        </Field>
                        {vendor.note ? (
                            <p className="text-[12px] leading-relaxed text-muted-foreground">
                                {vendor.note}
                            </p>
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                            <Field label="Address" required>
                                <Input
                                    value={form.address}
                                    onChange={(event) => set("address", event.target.value)}
                                    placeholder="192.168.1.50"
                                />
                            </Field>
                            {usesRtsp ? (
                                <Field label="Stream port">
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
                                <Field label="Account">
                                    <Input
                                        value={form.username}
                                        onChange={(event) => set("username", event.target.value)}
                                        autoComplete="off"
                                    />
                                </Field>
                            ) : null}
                            <Field
                                label="Password"
                                hint={
                                    camera?.hasPassword ? "Stored. Type to replace it." : undefined
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
                                    placeholder={camera?.hasPassword ? "Unchanged" : ""}
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
                                Ask the camera
                            </Button>
                            {tested ? (
                                <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    {tested}
                                </span>
                            ) : null}
                        </div>
                        {usesRtsp ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Field
                                    label="Stream path"
                                    hint="Left blank, the make's usual one is used."
                                >
                                    <Input
                                        value={form.mainPath}
                                        onChange={(event) => set("mainPath", event.target.value)}
                                        placeholder={vendor.mainPath || "/stream1"}
                                    />
                                </Field>
                                <Field
                                    label="Small stream"
                                    hint="What detection reads. Cheaper by a lot."
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
                        title="Reached from"
                        hint="A camera on another network - behind a repeater, or at another address - is reached by a server that lives there and is connected to Polaris under Servers. The stream comes back over that connection, so no extra port has to be opened."
                    >
                        <Select
                            value={form.reachVia}
                            onValueChange={(value) => set("reachVia", value)}
                            options={[
                                { value: "direct", label: "Polaris itself" },
                                ...servers
                                    .filter((server) => server.id !== "local")
                                    .map((server) => ({
                                        value: `server:${server.id}`,
                                        label: server.label
                                    }))
                            ]}
                        />
                    </Section>

                    <Section title="What it should notice">
                        <Select
                            value={form.detector}
                            onValueChange={(value) => set("detector", value as Detector)}
                            options={DETECTORS.map((id) => ({
                                value: id,
                                label: DETECTOR_META[id].label
                            }))}
                        />
                        <p className="text-[12px] leading-relaxed text-muted-foreground">
                            {DETECTOR_META[form.detector].summary}{" "}
                            <span className="text-foreground-subtle">
                                {DETECTOR_META[form.detector].cost}
                            </span>
                        </p>
                        {/* Only when it is actually a problem. The line used to
                            be printed whenever this rung was chosen, so a house
                            with recognition running was warned that it had none,
                            and a house with it switched off read the same
                            sentence and had no way to tell the two apart. */}
                        {form.detector === "faces" && recognizes === false ? (
                            <p className="text-[12px] leading-relaxed text-warning">
                                {DETECTOR_META.faces.requires}{" "}
                                <Link href="/places/settings" className="underline underline-offset-2">
                                    Open Settings
                                </Link>
                            </p>
                        ) : null}
                        {camera?.id && form.detector !== "none" ? (
                            <DetectorActivity activity={activity} />
                        ) : null}
                        {form.detector === "faces" && recognizes === true ? (
                            <p className="text-[12px] leading-relaxed text-muted-foreground">
                                Face recognition is on. Teach it who lives here under People and this camera
                                starts using their names.
                            </p>
                        ) : null}

                        {needsSomewhereToRun(form.detector) ? (
                            reachedVia ? (
                                // Not a choice: the stream is over there, and
                                // dragging it back across the link Polaris could
                                // not reach the camera over, to look at it here,
                                // would be the slowest possible way to do it.
                                <Field
                                    label="Runs on"
                                    hint="The machine that reaches this camera also analyzes it - the stream is already there."
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
                                <Field label="Runs on">
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
                                        label={`Sensitivity - ${form.sensitivity}`}
                                        hint="Higher notices smaller changes. Too high and every shadow is an event."
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
                                            aria-label="Sensitivity"
                                        />
                                    </Field>
                                ) : null}
                                <Field
                                    label="Ignore anything shorter than"
                                    hint="Seconds. The knob that keeps moths, gusts and passing lorries out of the log - nearly every false alarm is over within one or two. Zero reports the instant anything moves."
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
                                    label="Wait between detections"
                                    hint="The knob that decides what this camera costs. Seconds."
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
                                    <span className="text-[13px] text-foreground">
                                        Only at certain hours
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
                                            aria-label="From hour"
                                        />
                                        <span className="text-[12px] text-muted-foreground">
                                            to
                                        </span>
                                        <Input
                                            value={form.hoursTo}
                                            onChange={(event) => set("hoursTo", event.target.value)}
                                            className="w-20"
                                            inputMode="numeric"
                                            aria-label="To hour"
                                        />
                                        <span className="text-[12px] text-foreground-subtle">
                                            24-hour clock. 22 to 6 is overnight.
                                        </span>
                                    </div>
                                ) : null}
                            </>
                        ) : null}

                        {form.detector === "objects" || form.detector === "faces" ? (
                            <Field label="Worth reporting">
                                <div className="flex flex-wrap gap-3">
                                    {OBJECT_CLASSES.map((item) => (
                                        <label
                                            key={item}
                                            className="flex items-center gap-2 text-[13px]"
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
                                            {OBJECT_CLASS_LABELS[item]}
                                        </label>
                                    ))}
                                </div>
                                {form.classes.includes("package") ? (
                                    <p className="text-[12px] text-foreground-subtle">
                                        {OBJECT_CLASS_HINTS.package}
                                    </p>
                                ) : null}
                            </Field>
                        ) : null}

                        {form.detector === "faces" ? (
                            <Field
                                label="Sure enough to name somebody"
                                hint="Below this they are reported as a stranger rather than as the nearest match."
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

                    <Section title="What to keep">
                        <SegmentedControl
                            value={form.recording}
                            onValueChange={(value) =>
                                set("recording", value as FormState["recording"])
                            }
                            options={[
                                { value: "off", label: "Nothing" },
                                { value: "motion", label: "When something happens" },
                                { value: "continuous", label: "Everything" }
                            ]}
                        />
                        {form.recording !== "off" ? (
                            <Field
                                label="Store on"
                                hint="Footage already written stays where it is; this decides where the next of it goes."
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
                            <Field label="Keep for" hint="Days. Anything you pin survives this.">
                                <Input
                                    value={form.retentionDays}
                                    onChange={(event) => set("retentionDays", event.target.value)}
                                    className="w-24"
                                    inputMode="numeric"
                                />
                            </Field>
                        ) : null}
                        <label className="flex items-center justify-between gap-3">
                            <span className="text-[13px] text-foreground">
                                Switched on
                                <span className="block text-[12px] text-foreground-subtle">
                                    Off means Polaris does not connect to it at all.
                                </span>
                            </span>
                            <Switch
                                checked={form.enabled}
                                onChange={(value) => set("enabled", value)}
                            />
                        </label>
                    </Section>
                </div>

                {error ? <p className="mt-4 text-[12px] text-danger">{error}</p> : null}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={busy || incomplete}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {camera ? "Save" : "Add camera"}
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
                <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
                {hint ? (
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
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
            <span className={cn("text-[12px] font-medium text-muted-foreground")}>
                {label}
                {required ? <span className="text-danger"> *</span> : null}
            </span>
            {children}
            {hint ? <span className="text-[11px] text-foreground-subtle">{hint}</span> : null}
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
    if (activity === undefined) return <Skeleton className="h-4 w-64" />;
    if (activity === null) {
        return (
            <p className="text-[12px] leading-relaxed text-warning">
                No detector has reported on this camera. If you have just saved it, give it a minute - the
                worker asks for its cameras every half minute.
            </p>
        );
    }

    const lines = [
        activity.watching ? "Watching this camera." : "Not connected to this camera right now.",
        activity.motionAt ? `Movement ${since(activity.motionAt)}.` : "Nothing has moved in front of it yet.",
        activity.lookedAt
            ? activity.foundAt
                ? `Last looked properly ${since(activity.lookedAt)}, and found ${activity.found ?? "something"} ${since(activity.foundAt)}.`
                : `Last looked properly ${since(activity.lookedAt)} and found nothing it was asked to report.`
            : null
    ].filter(Boolean);

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[12px] leading-relaxed text-muted-foreground">{lines.join(" ")}</p>
            {activity.limitedTo ? (
                <p className="text-[12px] leading-relaxed text-warning">It is {activity.limitedTo}.</p>
            ) : null}
        </div>
    );
}

/** How long ago, in the words somebody reads a status line in. */
function since(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
}
