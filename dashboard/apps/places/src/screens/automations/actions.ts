"use server";

/**
 * Everything the automation screens call.
 *
 * Reading them is `home.read`, as reading the devices is. Writing one, switching
 * it, running it and removing it is `home.manage`: an automation is a standing
 * instruction to operate the house with nobody at the button, which is the same
 * kind of decision as connecting the account the doors are on - and somebody
 * lent one door holds neither. One that operates a device also needs the saver
 * to hold `home.control`, because it will act with their rights.
 *
 * Failures come back as `{ error }`, and a definition the schema refuses comes
 * back as `{ issues }` with where each one belongs, so the editor can put it
 * under the field rather than above the form.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import { placesT } from "../../lib/i18n";
import * as rooms from "../../lib/rooms";
import * as places from "../../lib/places";
import type { Coordinate } from "@polaris/core";
import * as devices from "../../lib/devices";
import { requireHome } from "../../lib/access";
import { guard } from "../../lib/action-guard";
import * as auto from "../../lib/automation-kinds";
import * as automations from "../../lib/automations";
import { currentPlace } from "../../lib/current-place";
import * as cameras from "../../lib/cameras";
import * as cameraSets from "../../lib/camera-sets";
import { privacyGroups } from "../../lib/privacy-kinds";
import { moveAutomationNow } from "../../lib/automation-move";
import { draftGraph } from "../../lib/automation-convert";
import { autoOffName, issueText } from "../../lib/automation-words";
import type { DeviceView } from "../../lib/device-kinds";
import type { FloorView, RoomView } from "../../lib/room-kinds";

const { recordAudit } = host.auditService;
const { sessionCan } = host.session;

/** A complaint about one field, already in the reader's words. */
export interface AutomationFieldIssue {
    readonly path: readonly (string | number)[];
    readonly message: string;
}

/** Which places a list is of: one, every one, or (absent) the one being looked at. */
const listScope = z.union([z.object({ placeId: z.string().uuid() }), z.literal("all")]).optional();

/** The automations of the place being looked at - or of `scope` - and the devices they name. */
export async function listAutomationsAction(scope?: unknown): Promise<{
    automations?: auto.AutomationView[];
    devices?: DeviceView[];
    /** The place's rooms, which a block naming a room or a floor is told by. */
    rooms?: RoomView[];
    placeId?: string;
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const asked = listScope.safeParse(scope);
    if (!asked.success) return { error: (await placesT())("automations.errors.placeGone") };
    const wanted = asked.data;
    const result = await guard(async () => {
        const { current, places: every } = await currentPlace(install.id);
        // An id from another install is not one of these, and lists nothing.
        const ids =
            wanted === "all"
                ? every.map((place) => place.id)
                : wanted
                  ? every.some((place) => place.id === wanted.placeId)
                      ? [wanted.placeId]
                      : []
                  : [current.id];
        const list = ids.length > 0 ? await automations.listAutomations(install.id, ids) : [];
        const [found, roomList] = list.some((automation) => !automation.movedTo)
            ? await Promise.all([
                  devices.listDevices(install.id, ids.length === 1 ? ids[0] : null),
                  rooms.listRooms(install.id, ids)
              ])
            : [[], []];
        return {
            list,
            found,
            roomList,
            placeId: ids.length === 1 ? ids[0] : undefined
        };
    });
    if (result.error) return { error: result.error };
    return {
        automations: result.value?.list,
        devices: result.value?.found,
        rooms: result.value?.roomList,
        placeId: result.value?.placeId
    };
}

/** What the editor draws its pickers from, for one place: the devices there and
 *  the other automations a step can start. */
export interface EditorContext {
    readonly placeId: string;
    readonly devices: DeviceView[];
    readonly siblings: { readonly id: string; readonly name: string }[];
    /** The place's rooms, which the add dialog groups devices by. Absent reads
     *  as none. */
    readonly rooms?: RoomView[];
    /** The place's floors, a floor with no room on it among them. */
    readonly floors?: FloorView[];
    /** Where the place is, for the sun blocks' times. Null until set. */
    readonly location?: Coordinate | null;
    /** The camera privacy targets of the place - its cameras, zones, rooms,
     *  sets and the place itself. Absent reads as none. */
    readonly privacyTargets?: { readonly target: string; readonly label: string }[];
}

async function editorContext(installedAppId: string, placeId: string): Promise<EditorContext> {
    const [found, list, roomList, floorList, place, cameraList, setList] = await Promise.all([
        devices.listDevices(installedAppId, placeId),
        automations.listAutomations(installedAppId, placeId),
        rooms.listRooms(installedAppId, placeId),
        rooms.listFloors(installedAppId, placeId),
        places.getPlace(installedAppId, placeId),
        cameras.listCameras(installedAppId, placeId),
        cameraSets.listCameraSets(installedAppId, placeId)
    ]);
    const privacyTargets = privacyGroups(cameraList, {
        places: new Map(place ? [[place.id, place.name]] : []),
        rooms: new Map(roomList.map((room) => [room.id, room.name])),
        sets: setList
    }).map((group) => ({ target: group.target, label: group.label }));
    return {
        placeId,
        devices: found,
        siblings: list.map((automation) => ({ id: automation.id, name: automation.name })),
        rooms: roomList,
        floors: floorList,
        location: place?.location ?? null,
        privacyTargets
    };
}

/** What a Places node in the central editor picks from: the place its config
 *  names, or the one being looked at for a node that names none yet. */
export async function nodeContextAction(
    placeId: string | null
): Promise<{ context?: EditorContext; error?: string }> {
    const { install } = await requireHome("home.read");
    const given = z.string().uuid().nullable().catch(null).parse(placeId);
    const result = await guard(async () =>
        editorContext(install.id, given ?? (await currentPlace(install.id)).current.id)
    );
    if (result.error) return { error: result.error };
    return { context: result.value };
}

/** One automation with what its editor needs: its log, the devices its pickers
 *  offer and the automations a step can start. A null id is a new one, at the
 *  place being looked at. */
export async function getAutomationAction(
    id: string | null,
    /** For a new one: the place it is made at, when not the one being looked at. */
    atPlace?: string | null
): Promise<{
    automation?: auto.AutomationView;
    runs?: auto.RunView[];
    context?: EditorContext;
    error?: string;
}> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () => {
        if (!id) {
            const { current, places: every } = await currentPlace(install.id);
            const at = every.find((place) => place.id === atPlace) ?? current;
            return {
                automation: undefined,
                runs: [],
                context: await editorContext(install.id, at.id)
            };
        }
        const automation = await automations.getAutomation(install.id, String(id));
        const [runs, context] = await Promise.all([
            automations.listRuns(install.id, automation.id),
            editorContext(install.id, automation.placeId)
        ]);
        return { automation, runs, context };
    });
    if (result.error) return { error: result.error };
    return {
        automation: result.value?.automation,
        runs: result.value?.runs,
        context: result.value?.context
    };
}

/** What an automation has done lately, newest first. */
export async function automationRunsAction(
    id: string
): Promise<{ runs?: auto.RunView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(() => automations.listRuns(install.id, String(id)));
    return result.error ? { error: result.error } : { runs: result.value };
}

/**
 * Save an automation, new (`id` null) or changed.
 *
 * Normalized and checked with the editor's own schema, then against the devices
 * the place actually has - a device removed while the editor was open is caught
 * here and said under its field.
 */
export async function saveAutomationAction(
    id: string | null,
    input: unknown
): Promise<{ automation?: auto.AutomationView; issues?: AutomationFieldIssue[]; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const t = await placesT();
    const parsed = auto.automationInputSchema.safeParse(auto.normalizeAutomationInput(input));
    if (!parsed.success) {
        return {
            issues: parsed.error.issues.map((issue) => ({
                path: issue.path,
                message: issueText(issue.message, t)
            })),
            error: t("automations.errors.fix")
        };
    }
    if (auto.actsOnDevices(parsed.data.definition) && !(await sessionCan(user, "home.control"))) {
        return { error: t("automations.errors.noControl") };
    }
    const self = id ? String(id) : null;
    const checked = await guard(() => automations.checkAutomation(install.id, parsed.data, self));
    if (checked.error) return { error: checked.error };
    if (checked.value && checked.value.length > 0) {
        return {
            issues: checked.value.map((issue) => ({
                path: issue.path,
                message: issueText(issue.message, t)
            })),
            error: t("automations.errors.fix")
        };
    }
    const result = await guard(() =>
        automations.saveAutomation(install.id, user.id, self, parsed.data)
    );
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: self ? "places.automation.update" : "places.automation.create",
        targetType: "placeAutomation",
        targetId: result.value?.id ?? "",
        metadata: { name: parsed.data.name }
    });
    // Saved here, then moved at once: what was just made runs on the central
    // engine, and its screen is there. One that cannot move stays here.
    const saved = result.value;
    if (!saved) return { automation: saved };
    const movedTo = await moveAutomationNow(saved.id).catch(() => null);
    return { automation: movedTo ? { ...saved, movedTo } : saved };
}

const startInput = z.object({
    name: z.string().trim().min(1).max(auto.LIMITS.name),
    placeId: z.string().min(1).max(64),
    definition: z.unknown()
});

/**
 * A new automation, made in the central editor from the start: a template or a
 * blank one laid out as a draft there, so every trigger, condition and step -
 * a web request, a webhook, another automation - is offered before the first
 * save. Nothing runs until it is published there.
 */
export async function startAutomationAction(
    input: unknown
): Promise<{ id?: string; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const t = await placesT();
    const parsed = startInput.safeParse(input);
    if (!parsed.success) return { error: t("automations.errors.name") };
    const result = await guard(async () => {
        const place = await places.getPlace(install.id, parsed.data.placeId);
        if (!place) return { refused: "automations.errors.placeGone" } as const;
        const graph = draftGraph(place.id, parsed.data.definition);
        if (!graph) return { refused: "automations.errors.template" } as const;
        const id = await host.automations
            .startAppAutomation({
                name: parsed.data.name,
                ownerId: user.id,
                origin: "home",
                originRef: place.id,
                graph
            })
            .catch((caught: unknown) => {
                if (atShelfLimit(caught)) return null;
                throw caught;
            });
        if (!id) return { refused: "automations.errors.limit" } as const;
        await recordAudit({
            actorId: user.id,
            action: "places.automation.create",
            targetType: "automation",
            targetId: id,
            metadata: { name: parsed.data.name }
        });
        return { id };
    });
    if (result.error) return { error: result.error };
    if (!result.value) return { error: t("refusals.failed") };
    if (result.value.refused) return { error: t(result.value.refused) };
    return { id: result.value.id };
}

function atShelfLimit(caught: unknown): boolean {
    return (
        caught instanceof Error &&
        caught.name === "AutomationAccessError" &&
        (caught as { code?: unknown }).code === "limit"
    );
}

export async function setAutomationEnabledAction(
    id: string,
    enabled: boolean
): Promise<{ automation?: auto.AutomationView; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() =>
        automations.setAutomationEnabled(install.id, String(id), enabled === true)
    );
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: enabled === true ? "places.automation.enable" : "places.automation.disable",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return { automation: result.value };
}

export async function deleteAutomationAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() => automations.deleteAutomation(install.id, String(id)));
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: "places.automation.delete",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return {};
}

/** Run it now. The run is queued and started; the screen reads the log again
 *  rather than waiting on the steps. */
export async function runAutomationAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() =>
        automations.runAutomationNow(install.id, String(id), user.name, randomUUID())
    );
    if (result.error) return { error: result.error };
    await recordAudit({
        actorId: user.id,
        action: "places.automation.run",
        targetType: "placeAutomation",
        targetId: String(id)
    });
    return {};
}

/**
 * "Turn off after this many minutes on", from a device's own panel, in one press.
 *
 * The automation is written and switched on as it would be from the editor, by
 * the same checks, so opening it afterwards shows exactly what was made.
 */
export async function addAutoOffAction(
    deviceId: string,
    minutes: number,
    timeZone: string
): Promise<{ automation?: auto.AutomationView; issues?: AutomationFieldIssue[]; error?: string }> {
    const { install } = await requireHome("home.manage");
    const t = await placesT();
    const found = await guard(async () => {
        const device = await devices.getDevice(install.id, String(deviceId));
        const { current } = await currentPlace(install.id);
        return { device, placeId: device.placeId ?? current.id };
    });
    if (found.error || !found.value) return { error: found.error ?? t("refusals.failed") };
    const { device, placeId } = found.value;
    const definition = auto.autoOffDefinition(device, Number(minutes), String(timeZone));
    if (!definition) return { error: t("automations.errors.noAutoOff") };
    return saveAutomationAction(null, {
        name: autoOffName(device, Number(minutes), t),
        enabled: true,
        placeId,
        definition
    });
}
