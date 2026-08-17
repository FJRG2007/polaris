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
import { listHosts } from "@/lib/host-service";
import { probeCamera } from "@/lib/home/onvif";
import { requireHome } from "@/lib/home/access";
import { cameraVendor } from "@/lib/home/vendors";
import { discoverCameras } from "@/lib/home/discovery";
import { cameraInputSchema, discoveryInputSchema, normalizeCameraInput } from "@/lib/home/schemas";

const PATH = "/house";

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
    const result = await guard(() => cameras.listCameras(install.id));
    return result.error ? { error: result.error } : { cameras: result.value };
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
    await requireHome("home.manage");
    const parsed = discoveryInputSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: "Write the network as 192.168.1.0/24." };
    const result = await guard(() => discoverCameras(parsed.data.subnet));
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
    const result = await guard(() =>
        id ? cameras.updateCamera(install.id, id, parsed.data) : cameras.createCamera(install.id, parsed.data)
    );
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
