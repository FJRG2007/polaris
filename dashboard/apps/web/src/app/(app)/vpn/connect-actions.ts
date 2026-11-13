"use server";

/** What the VPN's own screen asks for: anybody's devices, and an administrator's nodes
 *  and who may use them. Every limit is decided in the service, never on the screen. */

import { z } from "zod";
import { serverOptionsWhere } from "@/lib/server-options";
import { prisma } from "@polaris/db";
import * as wg from "@/lib/vpn/wireguard";
import { recordAudit } from "@/lib/audit-service";
import * as places from "@/lib/vpn/place-search";
import { getLocale, getTranslations } from "@/lib/i18n/request";
import * as service from "@/lib/vpn/wireguard-service";
import { profilesOf } from "@/lib/vpn/profile-service";
import { requireAdmin, requireUser } from "@/lib/session";
import { refreshVpnAccessLater } from "@/lib/vpn/refresh";
import { vpnMeshOn } from "@/lib/vpn/mesh";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

async function failed(error: unknown): Promise<{ error: string }> {
    const t = await getTranslations("vpn");
    if (error instanceof service.WireGuardRefusal)
        return { error: t(`connect.errors.${error.code}`) };
    if (error instanceof z.ZodError) return { error: t("connect.errors.invalid") };
    console.error("polaris: a VPN action failed:", error);
    return { error: t("errors.generic") };
}

/** A place with where to draw it on the map, when that is known. */
type Spotted<T> = Omit<T, "latitude" | "longitude"> & {
    readonly latitude: number | null;
    readonly longitude: number | null;
};

function spotted<T extends Parameters<typeof places.spotOf>[0]>(place: T): Spotted<T> {
    const spot = places.spotOf(place);
    return { ...place, latitude: spot?.latitude ?? null, longitude: spot?.longitude ?? null };
}

export interface ConnectAnswer {
    readonly nodes: Spotted<Awaited<ReturnType<typeof service.nodesFor>>[number]>[];
    readonly devices: Awaited<ReturnType<typeof service.devicesOf>>;
    readonly profiles: Spotted<Awaited<ReturnType<typeof profilesOf>>[number]>[];
    readonly standing: wg.AccessStanding | "none";
    readonly deviceLimit: number;
    readonly usedBytes: string;
    readonly dataLimitGb: number | null;
}

export async function connectAction(): Promise<Result<ConnectAnswer>> {
    const user = await requireUser();
    try {
        const [nodes, devices, profiles, access] = await Promise.all([
            service.nodesFor(user),
            service.devicesOf(user.id),
            profilesOf(user.id),
            service.accessOf(user)
        ]);
        return {
            nodes: nodes.map(spotted),
            devices,
            profiles: profiles.map(spotted),
            standing: access ? wg.accessStanding(access, new Date()) : "none",
            deviceLimit: access?.deviceLimit ?? 0,
            usedBytes: (access?.usedBytes ?? 0n).toString(),
            dataLimitGb: access?.dataLimitGb ?? null
        };
    } catch (error) {
        return failed(error);
    }
}

const thisDeviceSchema = z.object({
    nodeId: z.string().uuid(),
    name: wg.deviceNameSchema,
    publicKey: z.string().refine(wg.isWireGuardKey)
});

/** The app on this computer joins a server. Its private key never leaves the app. */
export async function connectThisDeviceAction(
    input: unknown
): Promise<Result<{ connection: service.ClientConnection }>> {
    const user = await requireUser();
    try {
        const body = thisDeviceSchema.parse(input);
        return { connection: await service.connectClient(user, body) };
    } catch (error) {
        return failed(error);
    }
}

/** After the app's tunnel got no answer: whether anything reaches that server's port. */
export async function checkVpnNodeAnswerAction(
    input: unknown
): Promise<Result<{ check: service.NodeAnswerCheck }>> {
    const user = await requireUser();
    try {
        return { check: await service.checkNodeAnswer(user, z.string().uuid().parse(input)) };
    } catch (error) {
        return failed(error);
    }
}

/** The administrator's list: whether devices' packets reach a node's port now. */
export async function checkVpnNodeReachAction(
    input: unknown
): Promise<Result<{ check: service.NodeAnswerCheck; checkedAt: string }>> {
    await requireAdmin();
    try {
        const check = await service.checkNodeReach(z.string().uuid().parse(input));
        return { check, checkedAt: new Date().toISOString() };
    } catch (error) {
        return failed(error);
    }
}

export async function removeVpnDeviceAction(input: unknown): Promise<Result> {
    const user = await requireUser();
    try {
        await service.removeDevice(user, z.string().uuid().parse(input));
        return {};
    } catch (error) {
        return failed(error);
    }
}

/** The devices on the VPN's own servers: the reader's, or everybody's for an
 *  administrator. */
export async function vpnAppDevicesAction(): Promise<
    Result<{ devices: Awaited<ReturnType<typeof service.devicesFor>> }>
> {
    const user = await requireUser();
    try {
        return { devices: await service.devicesFor(user) };
    } catch (error) {
        return failed(error);
    }
}

export interface NodesAnswer {
    readonly nodes: Awaited<ReturnType<typeof service.listNodes>>;
    /** The nodes on this admin's own servers - the ones they may edit or remove. */
    readonly mine: string[];
    /** Whether one of their servers could still become a node. */
    readonly canAdd: boolean;
    readonly access: Awaited<ReturnType<typeof service.listAccess>>;
    readonly open: boolean;
    /** Whether the device mesh integration is switched on. */
    readonly mesh: boolean;
}

export async function vpnAdminAction(): Promise<Result<NodesAnswer>> {
    const user = await requireAdmin();
    try {
        const [nodes, free, access, open, mesh] = await Promise.all([
            service.listNodes(),
            // Only whether one exists: the dialog reads the servers themselves a
            // page at a time, under the same filters.
            prisma.host.findFirst({
                where: serverOptionsWhere(user.id, "", { root: true, withoutVpnNode: true }),
                select: { id: true }
            }),
            service.listAccess(),
            service.openAccess(),
            vpnMeshOn()
        ]);
        const owned = await prisma.host.findMany({
            where: { ownerId: user.id, id: { in: nodes.map(({ hostId }) => hostId) } },
            select: { id: true }
        });
        return { nodes, access, open, mine: owned.map(({ id }) => id), canAdd: free !== null, mesh };
    } catch (error) {
        return failed(error);
    }
}

async function audited(
    actorId: string,
    action: string,
    targetId: string,
    work: () => Promise<void>
): Promise<Result> {
    try {
        await work();
        await recordAudit({ actorId, action, targetType: "vpn", targetId });
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function addVpnNodeAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = wg.nodeInputSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const host = await prisma.host.findUnique({
        where: { id: parsed.data.hostId },
        select: { ownerId: true }
    });
    if (host?.ownerId !== user.id) return failed(new service.WireGuardRefusal("notFound"));
    return audited(user.id, "vpn.node.add", parsed.data.hostId, () => service.addNode(parsed.data));
}

const nodeChangeSchema = wg.nodeInputSchema
    .pick({ name: true, endpoint: true, port: true, exit: true })
    .extend({ id: z.string().uuid() });

export async function updateVpnNodeAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = nodeChangeSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const { id, ...change } = parsed.data;
    if (!(await service.ownsNode(id, user.id)))
        return failed(new service.WireGuardRefusal("notFound"));
    return audited(user.id, "vpn.node.update", id, () => service.updateNode(id, change));
}

const nodeRemovalSchema = z.object({ id: z.string().uuid(), anyway: z.boolean() });

/** `unreachable` lets the screen offer to remove a machine that is gone for good. */
export async function removeVpnNodeAction(
    input: unknown
): Promise<Result<{ unreachable?: undefined }> | { error: string; unreachable: true }> {
    const user = await requireAdmin();
    const parsed = nodeRemovalSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const { id, anyway } = parsed.data;
    try {
        if (!(await service.ownsNode(id, user.id))) throw new service.WireGuardRefusal("notFound");
        await service.removeNode(id, anyway);
        await recordAudit({
            actorId: user.id,
            action: "vpn.node.remove",
            targetType: "vpn",
            targetId: id
        });
        return {};
    } catch (error) {
        const answer = await failed(error);
        const cut = error instanceof service.WireGuardRefusal && error.code === "unreachable";
        return cut ? { ...answer, unreachable: true } : answer;
    }
}

const nodeIdSchema = z.object({ id: z.string().uuid() });

/** Set a server up for browsers again: the button beside the reason it cannot. */
export async function retryVpnBrowserAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = nodeIdSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    if (!(await service.ownsNode(parsed.data.id, user.id)))
        return failed(new service.WireGuardRefusal("notFound"));
    return audited(user.id, "vpn.node.browser", parsed.data.id, () =>
        service.retryBrowserRoute(parsed.data.id)
    );
}

const placeQuerySchema = z.union([
    z.object({ query: z.string().trim().min(2).max(80) }),
    z.object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180)
    })
]);

/** Towns by name, or what is at a pair of coordinates, for placing a server by hand. */
export async function findVpnPlaceAction(
    input: unknown
): Promise<Result<{ matches: places.PlaceMatch[] }>> {
    await requireAdmin();
    const parsed = placeQuerySchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const t = await getTranslations("vpn");
    const language = (await getLocale()).slice(0, 2);
    if ("query" in parsed.data) {
        const matches = await places.searchPlaces(parsed.data.query, language);
        return matches ? { matches } : { error: t("place.unreachable") };
    }
    const { latitude, longitude } = parsed.data;
    const found = await places.placeOfPoint(latitude, longitude, language);
    if (found === undefined) return { error: t("place.unreachable") };
    return { matches: found ? [found] : [] };
}

const placeChangeSchema = z.object({ id: z.string().uuid(), place: wg.nodePlaceSchema.nullable() });

/** Put a server where somebody said it is, or back to where its address says. */
export async function placeVpnNodeAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = placeChangeSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const { id, place } = parsed.data;
    if (!(await service.ownsNode(id, user.id)))
        return failed(new service.WireGuardRefusal("notFound"));
    return audited(user.id, "vpn.node.place", id, () => service.placeNodeByHand(id, place));
}

export async function setVpnOpenAccessAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const open = z.boolean().safeParse(input);
    if (!open.success) return failed(open.error);
    // Who the private network lets in follows who may use the VPN, so every change
    // to that rewrites its policy too.
    return audited(user.id, "vpn.access.open", "instance", () =>
        service.setOpenAccess(open.data).then(refreshVpnAccessLater)
    );
}

const grantSchema = wg.accessInputSchema
    .omit({ userId: true })
    .extend({ email: z.string().trim().toLowerCase().email() });

/** Find somebody by the email they signed up with, and set what they may do. */
export async function grantVpnAccessAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const parsed = grantSchema.safeParse(input);
    if (!parsed.success) return failed(parsed.error);
    const { email, ...access } = parsed.data;
    const person = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!person) return failed(new service.WireGuardRefusal("noSuchPerson"));
    return audited(user.id, "vpn.access.grant", person.id, () =>
        service.grantAccess({ ...access, userId: person.id }).then(refreshVpnAccessLater)
    );
}

export async function revokeVpnAccessAction(input: unknown): Promise<Result> {
    const user = await requireAdmin();
    const id = z.string().uuid().safeParse(input);
    if (!id.success) return failed(id.error);
    return audited(user.id, "vpn.access.revoke", id.data, () =>
        service.revokeAccess(id.data).then(refreshVpnAccessLater)
    );
}
