/**
 * The Chat slash commands the manifest declares (`chatCommands` in
 * package.json), answered. Chat has already checked the writer holds the
 * command's permission; these only read, and answer in the writer's words.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { hospitalityT } from "./i18n";
import type { AppHostTypes } from "@polaris/app-host";

type AppChatCommandHandler = AppHostTypes["AppChatCommandHandler"];

/** `/table <name>`: whether that table has an order open, and how it stands. */
const table: AppChatCommandHandler = async ({ text }) => {
    const t = await hospitalityT();
    const name = text.trim().slice(0, 80);
    if (!name) return { refused: t("chat.tableWhich") };
    const found = await prisma.hospitalityTable.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { id: true, name: true }
    });
    if (!found) return { refused: t("chat.tableUnknown", { name }) };
    const order = await prisma.hospitalityOrder.findFirst({
        where: { tableId: found.id, status: "open" },
        orderBy: { openedAt: "desc" },
        select: { covers: true, total: true, waiterName: true }
    });
    if (!order) return { reply: t("chat.tableFree", { name: found.name }) };
    return {
        reply: t("chat.tableOpen", {
            name: found.name,
            covers: order.covers,
            total: (order.total / 100).toFixed(2),
            waiter: order.waiterName || "-"
        })
    };
};

export const hospitalityChatCommands: Readonly<Record<string, AppChatCommandHandler>> = { table };
