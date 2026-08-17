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
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { CameraView } from "@/lib/home/cameras";
import { CircleCheck, Loader2, Sparkles } from "lucide-react";
import { CAMERA_VENDORS, cameraVendor } from "@/lib/home/vendors";
import {
    DEFAULT_DETECTION,
    DETECTORS,
    DETECTOR_META,
    OBJECT_CLASSES,
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
    classes: ObjectClass[];
    faceThreshold: string;
    hoursOn: boolean;
    hoursFrom: string;
    hoursTo: string;
    recording: "off" | "motion" | "continuous";
    retentionDays: string;
    enabled: boolean;
}

function initial(camera: CameraView | null, prefill: { address: string; vendor: string | null } | null): FormState {
    const detection = camera?.detection ?? DEFAULT_DETECTION;
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
        detectorTargetId: camera?.detectorTargetId ?? "local",
        sensitivity: detection.sensitivity,
        minGapSeconds: String(detection.minGapSeconds),
        classes: [...detection.classes],
        faceThreshold: String(detection.faceThreshold),
        hoursOn: detection.hours !== null,
        hoursFrom: String(detection.hours?.from ?? 22),
        hoursTo: String(detection.hours?.to ?? 6),
        recording: (camera?.recording as FormState["recording"]) ?? "off",
        retentionDays: String(camera?.retentionDays ?? 7),
        enabled: camera?.enabled ?? true
    };
}

export function CameraDialog({
    camera,
    prefill = null,
    servers,
    onClose,
    onSaved
}: {
    camera: CameraView | null;
    /** A camera discovery found, being added: the address is known and the make
     *  is a guess worth starting from. */
    prefill?: { address: string; vendor: string | null } | null;
    servers: Server[];
    onClose: () => void;
    onSaved: (saved: CameraView) => void;
}) {
    const [form, setForm] = useState<FormState>(() => initial(camera, prefill));
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const [tested, setTested] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
        setForm((current) => ({ ...current, [key]: value }));

    const vendor = cameraVendor(form.vendor);
    // A make with its own protocol has no paths and no account to fill in: the
    // password is the whole credential. Showing the fields anyway is how somebody
    // ends up typing a camera account into a form that ignores it.
    const usesRtsp = !vendor.nativeScheme;

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
            classes: form.classes,
            faceThreshold: Number(form.faceThreshold) || DEFAULT_DETECTION.faceThreshold,
            hours: form.hoursOn ? { from: Number(form.hoursFrom) || 0, to: Number(form.hoursTo) || 0 } : null
        },
        recording: form.recording,
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
            [result.probe.manufacturer, result.probe.model].filter(Boolean).join(" ") || "The camera answered"
        );
    };

    const save = async () => {
        setBusy(true);
        setError(null);
        const result = await runAction(() => actions.saveCameraAction(camera?.id ?? null, payload()), setError);
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
                        <Field label="Where it points" hint="Groups the wall. Leave it blank if you only have a few.">
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
                                options={CAMERA_VENDORS.map((item) => ({ value: item.id, label: item.label }))}
                            />
                        </Field>
                        {vendor.note ? (
                            <p className="text-[12px] leading-relaxed text-muted-foreground">{vendor.note}</p>
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
                                hint={camera?.hasPassword ? "Stored. Type to replace it." : undefined}
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
                            <Button type="button" variant="secondary" size="sm" onClick={test} disabled={testing || incomplete}>
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
                                <Field label="Stream path" hint="Left blank, the make's usual one is used.">
                                    <Input
                                        value={form.mainPath}
                                        onChange={(event) => set("mainPath", event.target.value)}
                                        placeholder={vendor.mainPath || "/stream1"}
                                    />
                                </Field>
                                <Field label="Small stream" hint="What detection reads. Cheaper by a lot.">
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
                        hint="A camera on another network - behind a repeater, or at another address - is reached by a server that can see it."
                    >
                        <Select
                            value={form.reachVia}
                            onValueChange={(value) => set("reachVia", value)}
                            options={[
                                { value: "direct", label: "Polaris itself" },
                                ...servers
                                    .filter((server) => server.id !== "local")
                                    .map((server) => ({ value: `server:${server.id}`, label: server.label }))
                            ]}
                        />
                    </Section>

                    <Section title="What it should notice">
                        <Select
                            value={form.detector}
                            onValueChange={(value) => set("detector", value as Detector)}
                            options={DETECTORS.map((id) => ({ value: id, label: DETECTOR_META[id].label }))}
                        />
                        <p className="text-[12px] leading-relaxed text-muted-foreground">
                            {DETECTOR_META[form.detector].summary}{" "}
                            <span className="text-foreground-subtle">{DETECTOR_META[form.detector].cost}</span>
                        </p>

                        {needsSomewhereToRun(form.detector) ? (
                            <Field label="Runs on">
                                <Select
                                    value={form.detectorTargetId}
                                    onValueChange={(value) => set("detectorTargetId", value)}
                                    options={servers.map((server) => ({ value: server.id, label: server.label }))}
                                />
                            </Field>
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
                                            onChange={(event) => set("sensitivity", Number(event.target.value))}
                                            className="w-64 accent-primary"
                                            aria-label="Sensitivity"
                                        />
                                    </Field>
                                ) : null}
                                <Field
                                    label="Wait between detections"
                                    hint="The knob that decides what this camera costs. Seconds."
                                >
                                    <Input
                                        value={form.minGapSeconds}
                                        onChange={(event) => set("minGapSeconds", event.target.value)}
                                        className="w-24"
                                        inputMode="numeric"
                                    />
                                </Field>
                                <label className="flex items-center justify-between gap-3">
                                    <span className="text-[13px] text-foreground">Only at certain hours</span>
                                    <Switch checked={form.hoursOn} onChange={(value) => set("hoursOn", value)} />
                                </label>
                                {form.hoursOn ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            value={form.hoursFrom}
                                            onChange={(event) => set("hoursFrom", event.target.value)}
                                            className="w-20"
                                            inputMode="numeric"
                                            aria-label="From hour"
                                        />
                                        <span className="text-[12px] text-muted-foreground">to</span>
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
                                        <label key={item} className="flex items-center gap-2 text-[13px]">
                                            <Checkbox
                                                checked={form.classes.includes(item)}
                                                onChange={(event) =>
                                                    set(
                                                        "classes",
                                                        event.target.checked
                                                            ? [...form.classes, item]
                                                            : form.classes.filter((value) => value !== item)
                                                    )
                                                }
                                            />
                                            {OBJECT_CLASS_LABELS[item]}
                                        </label>
                                    ))}
                                </div>
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
                            onValueChange={(value) => set("recording", value as FormState["recording"])}
                            options={[
                                { value: "off", label: "Nothing" },
                                { value: "motion", label: "When something happens" },
                                { value: "continuous", label: "Everything" }
                            ]}
                        />
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
                            <Switch checked={form.enabled} onChange={(value) => set("enabled", value)} />
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

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <div>
                <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
                {hint ? <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{hint}</p> : null}
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
