"use server";

/**
 * Everything the Home screens call.
 *
 * Three gates, and which one applies is the whole permission model: looking at a
 * camera is `home.read`, pointing one is `home.control`, and deciding what
 * Polaris connects to is `home.manage` - which is administrative on purpose,
 * because adding a camera is the one place somebody can aim the server at an
 * address of their choosing.
 *
 * Failures come back as `{ error }` rather than thrown: every caller is a panel
 * with a line to put it on, and a camera's own refusal ("not authorized") is the
 * most useful sentence anybody gets here. What never comes back is the camera's
 * password or the relay's address.
 */

import * as relay from "@/lib/home/relay";
import { revalidatePath } from "next/cache";
import * as cameras from "@/lib/home/cameras";
import * as events from "@/lib/home/events";
import * as ptz from "@/lib/home/ptz";
import * as alerts from "@/lib/home/alerts";
import * as places from "@/lib/home/places";
import * as defaults from "@/lib/home/detection-defaults";
import * as people from "@/lib/home/people";
import * as recording from "@/lib/home/recording";
import { listHosts } from "@/lib/host-service";
import { footageTarget } from "@/lib/home/stills";
import { LOCAL_TARGET, storageTargetOptions } from "@/lib/storage-target";
import { probeCamera } from "@/lib/home/onvif";
import { cookies } from "next/headers";
import { requireHome } from "@/lib/home/access";
import { currentPlace, PLACE_COOKIE, PLACE_COOKIE_MAX_AGE } from "@/lib/home/current-place";
import { cameraVendor } from "@/lib/home/vendors";
import { discoverCameras } from "@/lib/home/discovery";
import { ensureVisionWorker, faceEndpoint, faceRecognitionSettings, setFaceRecognition } from "@/lib/home/vision";
import { needsSomewhereToRun, type Detector } from "@/lib/home/detection";
import { cameraInputSchema, discoveryInputSchema, normalizeCameraInput } from "@/lib/home/schemas";

const PATH = "/places";

/** Turn a refusal into a sentence. Anything else is a real fault and throws. */
async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof Error) return { error: caught.message };
        return { error: "That did not work." };
    }
}

export async function listCamerasAction(): Promise<{ cameras?: cameras.CameraView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        const { current } = await currentPlace(install.id);
        return cameras.listCameras(install.id, current.id);
    });
    return result.error ? { error: result.error } : { cameras: result.value };
}

/** Remember which place this person is looking at. Not authorization: it narrows
 *  what is listed, and every screen still resolves what they may do. */
export async function choosePlaceAction(placeId: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        const place = await places.getPlace(install.id, String(placeId));
        if (!place) throw new Error("No such place");
        (await cookies()).set(PLACE_COOKIE, place.id, {
            path: "/",
            maxAge: PLACE_COOKIE_MAX_AGE,
            sameSite: "lax"
        });
    });
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

export async function listPlacesAction(): Promise<{ places?: places.PlaceView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(() => places.listPlaces(install.id));
    return result.error ? { error: result.error } : { places: result.value };
}

export async function savePlaceAction(
    id: string | null,
    input: { name: string; kind: string; address: string }
): Promise<{ place?: places.PlaceView; error?: string }> {
    const { install } = await requireHome("home.manage");
    const shape = {
        name: String(input?.name ?? ""),
        kind: String(input?.kind ?? "other"),
        address: String(input?.address ?? "")
    };
    const result = await guard(() =>
        id ? places.updatePlace(install.id, id, shape) : places.createPlace(install.id, shape)
    );
    if (result.error || !result.value) return { error: result.error ?? "That place could not be saved." };
    revalidatePath(PATH);
    return { place: result.value };
}

export async function deletePlaceAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => places.deletePlace(install.id, id));
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

/** Everybody who could be told about something, for the alert form. Names and
 *  ids only - an alert names people, and that is all it needs of them. */
export async function listRecipientsAction(): Promise<{
    people?: { id: string; name: string }[];
    error?: string;
}> {
    await requireHome("home.manage");
    const result = await guard(async () => {
        const { prisma } = await import("@polaris/db");
        return prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 });
    });
    return result.error ? { error: result.error } : { people: result.value };
}

export async function listAlertsAction(): Promise<{ rules?: alerts.AlertRuleView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () =>
        alerts.listAlertRules(install.id, (await currentPlace(install.id)).current.id)
    );
    return result.error ? { error: result.error } : { rules: result.value };
}

/**
 * Write or change an alert.
 *
 * `home.manage`, because an alert names other people and puts a conversation in
 * their sidebar. Being told about your own house is everyday; deciding who else
 * gets woken up at three in the morning is not.
 */
export async function saveAlertAction(
    id: string | null,
    input: alerts.AlertRuleInput
): Promise<{ rule?: alerts.AlertRuleView; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(async () => {
        // A rule with no place is one that watches everywhere, which is a
        // deliberate choice rather than a side effect of the switcher.
        const placeId = input.placeId ?? (await currentPlace(install.id)).current.id;
        return alerts.saveAlertRule(install.id, id, user.id, { ...input, placeId });
    });
    if (result.error || !result.value) return { error: result.error ?? "That alert could not be saved." };
    revalidatePath(`${PATH}/alerts`);
    return { rule: result.value };
}

export async function deleteAlertAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => alerts.deleteAlertRule(install.id, id));
    if (result.error) return { error: result.error };
    revalidatePath(`${PATH}/alerts`);
    return {};
}

/** What a new camera starts out believing about movement, and setting it. */
export async function detectionDefaultsAction(): Promise<{
    defaults?: defaults.DetectionDefaults;
    error?: string;
}> {
    await requireHome("home.read");
    const result = await guard(() => defaults.detectionDefaults());
    return result.error ? { error: result.error } : { defaults: result.value };
}

export async function setDetectionDefaultsAction(input: {
    sensitivity: number;
    settleSeconds: number;
    minGapSeconds: number;
}): Promise<{ error?: string }> {
    await requireHome("home.manage");
    const result = await guard(() => defaults.setDetectionDefaults(input));
    return result.error ? { error: result.error } : {};
}

/** The disks a camera's footage can be pointed at: whatever Polaris is set to by
 *  default, this server, or any storage connection it has. */
export async function listStorageOptionsAction(): Promise<{
    options?: { id: string; label: string }[];
    error?: string;
}> {
    await requireHome("home.read");
    const result = await guard(async () => {
        const [fallback, connections] = await Promise.all([footageTarget(null), storageTargetOptions()]);
        return [
            { id: "", label: `Wherever this Polaris keeps footage (${fallback.name})` },
            { id: LOCAL_TARGET, label: "This server" },
            ...connections.map((connection) => ({ id: connection.id, label: connection.name }))
        ];
    });
    return result.error ? { error: result.error } : { options: result.value };
}

/** The machines a camera can be reached from, or have its detection run on. */
export async function listServersAction(): Promise<{
    servers?: { id: string; label: string }[];
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        const hosts = await listHosts(install.ownerId);
        return [
            { id: "local", label: "This machine" },
            ...hosts.map((host) => ({ id: host.id, label: host.name }))
        ];
    });
    return result.error ? { error: result.error } : { servers: result.value };
}

/**
 * Ask a camera what it is, before anybody commits to adding it.
 *
 * The answer replaces the guesses: a make's stream paths are a starting point,
 * and this is the camera itself saying. It is also the only honest test of the
 * credentials - a camera refuses this call first when they are wrong.
 */
export async function probeCameraAction(input: unknown): Promise<{
    probe?: { model: string; manufacturer: string; mainPath: string; subPath: string; ptz: boolean };
    error?: string;
}> {
    await requireHome("home.manage");
    const parsed = cameraInputSchema
        .pick({ address: true, onvifPort: true, username: true, password: true, vendor: true })
        .safeParse(normalizeCameraInput((input ?? {}) as Record<string, unknown>));
    if (!parsed.success) return { error: "Check the address and the account." };

    const vendor = cameraVendor(parsed.data.vendor);
    const port = parsed.data.onvifPort ?? vendor.onvifPort ?? 80;
    const result = await guard(() =>
        probeCamera({
            address: parsed.data.address,
            port,
            username: parsed.data.username,
            password: parsed.data.password ?? ""
        })
    );
    if (result.error || !result.value) return { error: result.error ?? "The camera did not answer." };

    // Only the path is kept from what the camera answered. Its URL carries the
    // host it thinks it is on, which on a camera behind a repeater is an address
    // nothing else can reach.
    const pathOf = (url: string | null) => {
        if (!url) return "";
        try {
            const parsedUrl = new URL(url);
            return `${parsedUrl.pathname}${parsedUrl.search}`;
        } catch {
            return "";
        }
    };
    return {
        probe: {
            model: result.value.device.model,
            manufacturer: result.value.device.manufacturer,
            mainPath: pathOf(result.value.mainUrl),
            subPath: pathOf(result.value.subUrl),
            ptz: result.value.ptz
        }
    };
}

/** Look for cameras nobody has added yet. */
export async function discoverCamerasAction(input: unknown): Promise<{
    found?: Awaited<ReturnType<typeof discoverCameras>>;
    error?: string;
}> {
    const { install } = await requireHome("home.manage");
    const parsed = discoveryInputSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: "Write the network as 192.168.1.0/24." };
    // Looking from another server is only meaningful with a range to look at:
    // the multicast probe is a thing Polaris does on its own segment.
    if (parsed.data.fromServerId && !parsed.data.subnet) {
        return { error: "Give the address range on that network, like 192.168.1.0/24." };
    }
    const result = await guard(() =>
        discoverCameras(
            parsed.data.subnet,
            parsed.data.fromServerId ? { hostId: parsed.data.fromServerId, ownerId: install.ownerId } : null
        )
    );
    return result.error ? { error: result.error } : { found: result.value };
}

export async function saveCameraAction(
    id: string | null,
    input: unknown
): Promise<{ camera?: cameras.CameraView; error?: string }> {
    const { install } = await requireHome("home.manage");
    const parsed = cameraInputSchema.safeParse(normalizeCameraInput((input ?? {}) as Record<string, unknown>));
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Some of that is not right." };
    }
    const result = await guard(async () => {
        const { current } = await currentPlace(install.id);
        const placeId = parsed.data.placeId || current.id;
        if (!(await places.getPlace(install.id, placeId))) throw new Error("That place is not one of yours");
        parsed.data.placeId = placeId;
        if (parsed.data.storageTarget) {
            const allowed = new Set([LOCAL_TARGET, ...(await storageTargetOptions()).map((option) => option.id)]);
            if (!allowed.has(parsed.data.storageTarget)) throw new Error("That storage is not one of yours");
        }
        return id
            ? cameras.updateCamera(install.id, id, parsed.data)
            : cameras.createCamera(install.id, parsed.data);
    });
    if (result.error || !result.value) return { error: result.error ?? "That camera could not be saved." };
    revalidatePath(PATH);
    return { camera: result.value };
}

/**
 * Hand a camera to the relay, bringing the relay up if this is the first one on
 * that machine.
 *
 * Kept out of saving on purpose. Installing the relay is a deploy: it pulls an
 * image and starts a container, which is tens of seconds the first time and
 * nothing every time after. A form that waited for it would look broken, so
 * saving returns at once and the screen shows this step happening.
 */
export async function startCameraAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(async () => {
        const camera = await cameras.getCamera(install.id, id);
        if (!camera) throw new Error("Camera not found");
        if (!camera.enabled) return;
        const target = await cameras.cameraTarget(install.id, id);
        if (!target) throw new Error("Camera not found");
        const endpoint = await relay.ensureRelay(install.ownerId, user.id, relay.relayServerFor(camera.reachVia));
        await relay.publishCamera(endpoint, target, camera.vendor);
        // A rung Polaris runs itself needs something to run it on, and that
        // machine is the one the owner chose on the form. Installed here rather
        // than when the camera was saved, for the same reason as the relay: it is
        // a deploy, and a form should not wait on one.
        if (needsSomewhereToRun(camera.detector as Detector)) {
            await ensureVisionWorker(install.ownerId, user.id, camera.detectorTargetId ?? "local");
        }
    });
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

export async function deleteCameraAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(async () => {
        const camera = await cameras.getCamera(install.id, id);
        if (!camera) throw new Error("Camera not found");
        // Told to stop serving it first: a relay that keeps a stream for a camera
        // nobody can open again holds a connection to it forever.
        const endpoint = await relay.relayEndpoint(relay.relayServerFor(camera.reachVia));
        if (endpoint) await relay.unpublishCamera(endpoint, id);
        await cameras.deleteCamera(install.id, id);
    });
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

export async function listEventsAction(input: {
    cameraId?: string | null;
    kind?: string | null;
    /** One person, by the name the recognizer put to them. */
    label?: string | null;
    /** The window to look inside, as whatever a datetime field produced. */
    from?: string | null;
    to?: string | null;
    /** The timestamp of the oldest row already on screen, for the next page. */
    before?: string | null;
}): Promise<{ events?: events.EventView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    /** A date that a browser may have sent as an empty string or as nonsense. */
    const when = (value: string | null | undefined): Date | null => {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const before = when(input.before);
    const result = await guard(async () =>
        events.listEvents(install.id, {
            placeId: (await currentPlace(install.id)).current.id,
            cameraId: input.cameraId ?? null,
            kind: input.kind ?? null,
            label: input.label ?? null,
            from: when(input.from),
            to: when(input.to),
            before
        })
    );
    return result.error ? { error: result.error } : { events: result.value };
}

/**
 * Remove a detection, or everything the current filter matched.
 *
 * `home.control` rather than `home.manage`: clearing false positives is the
 * everyday work of whoever watches the cameras, and a log they cannot tidy is
 * one they stop reading. What it removes is a record of what a camera thought it
 * saw, never footage - a clip is removed from Clips, deliberately separately.
 */
export async function deleteEventAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => events.deleteEvent(install.id, id));
    if (result.error) return { error: result.error };
    revalidatePath(`${PATH}/events`);
    return {};
}

export async function clearEventsAction(input: {
    cameraId?: string | null;
    kind?: string | null;
    label?: string | null;
    from?: string | null;
    to?: string | null;
}): Promise<{ removed?: number; error?: string }> {
    const { install } = await requireHome("home.control");
    const when = (value: string | null | undefined): Date | null => {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const result = await guard(async () =>
        events.deleteEvents(install.id, {
            placeId: (await currentPlace(install.id)).current.id,
            cameraId: input.cameraId ?? null,
            kind: input.kind ?? null,
            label: input.label ?? null,
            from: when(input.from),
            to: when(input.to)
        })
    );
    if (result.error) return { error: result.error };
    revalidatePath(`${PATH}/events`);
    return { removed: result.value ?? 0 };
}

/** The footage of one moment, and how far into it to start. Null when nothing
 *  was kept - which the screen says rather than opening an empty player. */
export async function momentAction(
    eventId: string
): Promise<{ moment?: { clipId: string; offsetSeconds: number } | null; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(() => recording.momentOf(install.id, eventId));
    return result.error ? { error: result.error } : { moment: result.value ?? null };
}

/** Say that somebody has seen this one. Control rather than read: it changes
 *  what everybody else in the house sees waiting for them. */
export async function acknowledgeEventAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.control");
    const result = await guard(() => events.acknowledgeEvent(install.id, id, user.id));
    return result.error ? { error: result.error } : {};
}

/** Everybody the house knows by sight, and whether there is a recognizer for
 *  those names to mean anything to yet. */
export async function listPeopleAction(): Promise<{
    people?: people.PersonView[];
    recognizerReady?: boolean;
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => ({
        people: await people.listPeople(install.id),
        recognizerReady: (await faceEndpoint()) !== null
    }));
    return result.error ? { error: result.error } : { ...result.value };
}

export async function addPersonAction(name: string): Promise<{ person?: people.PersonView; error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => people.addPerson(install.id, String(name)));
    if (result.error || !result.value) return { error: result.error ?? "They could not be added." };
    revalidatePath(`${PATH}/people`);
    return { person: result.value };
}

/**
 * Teach the recognizer a face.
 *
 * The photograph is passed straight through and is never written down by
 * Polaris. Capped here as well as at the recognizer: an action that accepts an
 * arbitrarily large upload is a way to spend a server's memory.
 */
export async function addFaceAction(id: string, image: Uint8Array): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    if (image.byteLength > 8_000_000) return { error: "That photograph is too large." };
    const result = await guard(() => people.addFace(install.id, id, image));
    return result.error ? { error: result.error } : {};
}

export async function setPersonNotifyAction(id: string, notify: boolean): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => people.setNotify(install.id, id, Boolean(notify)));
    return result.error ? { error: result.error } : {};
}

export async function removePersonAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => people.removePerson(install.id, id));
    if (result.error) return { error: result.error };
    revalidatePath(`${PATH}/people`);
    return {};
}

/** Where the recognizer is and whether it has a key, for the settings screen.
 *  The key itself never comes back. */
export async function homeSettingsAction(): Promise<{
    settings?: { faceApiUrl: string; hasFaceKey: boolean; recognizerReady: boolean };
    error?: string;
}> {
    const { install } = await requireHome("home.manage");
    const result = await guard(async () => {
        const face = await faceRecognitionSettings(install.id);
        return {
            faceApiUrl: face.baseUrl,
            hasFaceKey: face.hasKey,
            recognizerReady: (await faceEndpoint()) !== null
        };
    });
    return result.error ? { error: result.error } : { settings: result.value };
}

/**
 * Point the house at the recognizer somebody is running.
 *
 * Connected rather than installed: CompreFace is five containers and a database,
 * and Polaris deploys single containers - so it is run the way its own project
 * says to, and this is where Home is told the address and the key it minted.
 * Clearing the address switches face recognition off.
 */
export async function setFaceRecognitionAction(baseUrl: string, apiKey: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => setFaceRecognition(install.id, String(baseUrl), String(apiKey)));
    return result.error ? { error: result.error } : {};
}

/**
 * Point a camera somewhere else, and stop it again.
 *
 * `home.control` rather than `home.manage`: moving a camera is an everyday thing
 * for whoever is watching, and it changes nothing about how the house is set up.
 * The stop is its own call because movement is continuous - the camera keeps
 * going until told otherwise.
 */
export async function ptzMoveAction(cameraId: string, direction: ptz.PtzDirection): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => ptz.move(install.id, cameraId, direction));
    return result.error ? { error: result.error } : {};
}

export async function ptzStopAction(cameraId: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => ptz.stop(install.id, cameraId));
    return result.error ? { error: result.error } : {};
}

export async function ptzPresetsAction(cameraId: string): Promise<{
    presets?: { token: string; name: string }[];
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(() => ptz.presets(install.id, cameraId));
    return result.error ? { error: result.error } : { presets: result.value };
}

export async function ptzGoToAction(cameraId: string, preset: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => ptz.goTo(install.id, cameraId, preset));
    return result.error ? { error: result.error } : {};
}

export async function listClipsAction(input: {
    cameraId?: string | null;
    before?: string | null;
}): Promise<{ clips?: recording.ClipView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const before = input.before ? new Date(input.before) : null;
    const result = await guard(async () =>
        recording.listClips(install.id, {
            placeId: (await currentPlace(install.id)).current.id,
            cameraId: input.cameraId ?? null,
            before: before && !Number.isNaN(before.getTime()) ? before : null
        })
    );
    return result.error ? { error: result.error } : { clips: result.value };
}

/** Hold on to one clip past its retention, or stop. Control rather than manage:
 *  it keeps something rather than removing it, and everybody who watches the
 *  house should be able to say "not that one". */
export async function pinClipAction(id: string, pinned: boolean): Promise<{ error?: string }> {
    const { install } = await requireHome("home.control");
    const result = await guard(() => recording.pinClip(install.id, id, pinned));
    return result.error ? { error: result.error } : {};
}

export async function deleteClipAction(id: string): Promise<{ error?: string }> {
    const { install } = await requireHome("home.manage");
    const result = await guard(() => recording.deleteClip(install.id, id));
    return result.error ? { error: result.error } : {};
}

/** Which cameras the relay is actually serving, so a tile can tell "not started
 *  yet" from "started and the camera is down". */
export async function liveCamerasAction(): Promise<{ live?: string[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        const all = await cameras.listCameras(install.id);
        const servers = [...new Set(all.map((camera) => relay.relayServerFor(camera.reachVia)))];
        const names = await Promise.all(
            servers.map(async (server) => {
                const endpoint = await relay.relayEndpoint(server);
                return endpoint ? relay.publishedStreams(endpoint) : [];
            })
        );
        const published = new Set(names.flat());
        return all.filter((camera) => published.has(relay.streamName(camera.id, "main"))).map((camera) => camera.id);
    });
    return result.error ? { error: result.error } : { live: result.value };
}
