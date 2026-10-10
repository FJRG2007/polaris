/** A team drive: their own space, the office NAS, and a bucket for backups. */

import { TEAM, VIEWER, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { ConnectionSummary, DriveEntry } from "@/app/(app)/drive/types";
import type { ShareRow } from "@/app/(app)/drive/shared-links/shared-links-view";

export const DRIVE_ID = id("connection", 1);

export function connections(ctx: SceneContext): ConnectionSummary[] {
    return [
        {
            id: DRIVE_ID,
            name: ctx.say("My drive", "Mi unidad"),
            kind: "personal",
            requiresHostd: false,
            shared: false,
            canManageAccess: true,
            editable: false,
            config: {},
            needsRekey: false
        },
        {
            id: id("connection", 2),
            name: ctx.say("Office NAS", "NAS de la oficina"),
            kind: "smb",
            requiresHostd: true,
            shared: false,
            canManageAccess: true,
            editable: true,
            config: { host: "nas.lan", share: "team" },
            needsRekey: false
        },
        {
            id: id("connection", 3),
            name: ctx.say("Backups", "Copias"),
            kind: "s3",
            requiresHostd: false,
            shared: false,
            canManageAccess: true,
            editable: true,
            config: { bucket: "northwind-backups", region: "eu-west-1" },
            needsRekey: false
        }
    ];
}

const MB = 1024 * 1024;

/** The root of their drive: a few folders, and the files a week of work leaves. */
export function rootEntries(ctx: SceneContext): DriveEntry[] {
    const say = ctx.say;
    const folder = (
        name: string,
        minutes: number,
        extra: Partial<DriveEntry> = {}
    ): DriveEntry => ({
        name,
        path: name,
        kind: "dir",
        size: "0",
        modifiedAt: ago(ctx.now, minutes),
        createdAt: ago(ctx.now, minutes + 60 * 24 * 40),
        owner: VIEWER.name,
        ...extra
    });
    const file = (
        name: string,
        bytes: number,
        minutes: number,
        owner: string = VIEWER.name
    ): DriveEntry => ({
        name,
        path: name,
        kind: "file",
        size: String(Math.round(bytes)),
        modifiedAt: ago(ctx.now, minutes),
        createdAt: ago(ctx.now, minutes + 60 * 24 * 3),
        owner
    });
    return [
        folder(say("Design", "Diseño"), 35, { favorite: true }),
        folder(say("Contracts", "Contratos"), 60 * 26, { locked: true }),
        folder(say("Photos", "Fotos"), 60 * 50),
        folder(say("Invoices", "Facturas"), 60 * 72),
        file(
            say("Onboarding screens.fig", "Pantallas de bienvenida.fig"),
            18.4 * MB,
            22,
            TEAM.lena.name
        ),
        file(say("Q1 report.pdf", "Informe T1.pdf"), 2.1 * MB, 95, TEAM.ana.name),
        file(say("Launch plan.docx", "Plan de lanzamiento.docx"), 0.3 * MB, 60 * 5),
        file(say("Budget 2026.xlsx", "Presupuesto 2026.xlsx"), 0.09 * MB, 60 * 20, TEAM.sam.name),
        file("storefront-demo.mp4", 148 * MB, 60 * 28, TEAM.kenji.name),
        file(say("Team offsite.jpg", "Viaje de equipo.jpg"), 4.6 * MB, 60 * 49, TEAM.priya.name),
        file("brand-kit.zip", 36 * MB, 60 * 80)
    ];
}

/** What each folder at the root holds, as the insights route measures it. The
 *  locked one is left out, as the route leaves out what it may not walk. */
export function folderSizes(ctx: SceneContext) {
    const say = ctx.say;
    const size = (gb: number, files: number, folders: number) => ({
        bytes: String(Math.round(gb * 1024 * MB)),
        files,
        folders,
        partial: false
    });
    return {
        sizes: {
            [say("Design", "Diseño")]: size(3.4, 412, 18),
            [say("Photos", "Fotos")]: size(21.7, 3_960, 42),
            [say("Invoices", "Facturas")]: size(0.2, 188, 12)
        },
        archives: {},
        pending: []
    };
}

/** The links they handed out: one a client still uses, one with a password and
 *  a download limit, one that ran out, and one they pulled. */
export function shareLinks(ctx: SceneContext): ShareRow[] {
    const say = ctx.say;
    const DAY = 60 * 24;
    const link = (
        n: number,
        path: string,
        createdDaysAgo: number,
        extra: Partial<ShareRow> = {}
    ): ShareRow => ({
        id: id("share", n),
        path,
        kind: "public",
        connectionId: DRIVE_ID,
        connectionName: say("My drive", "Mi unidad"),
        allowUpload: false,
        allowRename: false,
        allowDelete: false,
        allowCreateFolder: false,
        allowOverwrite: false,
        allowDownload: true,
        allowPreview: true,
        allowedCidrs: [],
        maxDownloads: null,
        downloadCount: 0,
        expiresAt: null,
        revokedAt: null,
        createdAt: ago(ctx.now, createdDaysAgo * DAY),
        canReveal: true,
        ...extra
    });
    return [
        link(1, say("Design/Brand kit", "Diseño/Kit de marca"), 3, {
            downloadCount: 14,
            expiresAt: ago(ctx.now, -11 * DAY)
        }),
        link(2, say("Q1 report.pdf", "Informe T1.pdf"), 6, {
            maxDownloads: 10,
            downloadCount: 4,
            expiresAt: ago(ctx.now, -24 * DAY)
        }),
        link(3, say("Invoices/Client uploads", "Facturas/Subidas de clientes"), 9, {
            allowUpload: true,
            allowCreateFolder: true,
            allowDownload: false,
            downloadCount: 0,
            allowedCidrs: ["203.0.113.0/24"]
        }),
        link(4, "storefront-demo.mp4", 20, {
            maxDownloads: 5,
            downloadCount: 5
        }),
        link(5, say("Photos/Offsite", "Fotos/Viaje"), 40, {
            downloadCount: 31,
            revokedAt: ago(ctx.now, 12 * DAY)
        })
    ];
}
