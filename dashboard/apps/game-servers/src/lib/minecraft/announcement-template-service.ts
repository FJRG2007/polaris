/**
 * Reading and writing a server's kept announcements. The rules are in
 * `announcement-templates`; this is only where they are stored.
 */

import { prisma } from "@polaris/db";
import {
    TEMPLATES_KEY,
    readTemplates,
    withTemplate,
    withoutTemplate,
    type AnnouncementTemplate
} from "./announcement-templates";
import { host } from "@polaris/app-host";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

export async function listTemplates(installedAppId: string): Promise<AnnouncementTemplate[]> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return readTemplates(readInstallConfig(row?.config));
}

export async function saveTemplate(
    installedAppId: string,
    entry: AnnouncementTemplate
): Promise<AnnouncementTemplate[]> {
    const list = withTemplate(await listTemplates(installedAppId), entry);
    await patchInstallConfig(installedAppId, { [TEMPLATES_KEY]: list });
    return list;
}

export async function deleteTemplate(
    installedAppId: string,
    id: string
): Promise<AnnouncementTemplate[]> {
    const list = withoutTemplate(await listTemplates(installedAppId), id);
    await patchInstallConfig(installedAppId, { [TEMPLATES_KEY]: list });
    return list;
}
