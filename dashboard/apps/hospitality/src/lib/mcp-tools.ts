/**
 * The MCP tools the manifest declares (`mcpTools` in package.json), done. The
 * dashboard has already checked the caller holds the tool's permission and the
 * input against its declared fields; these only read, and answer with the
 * declared output.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { hospitalityT } from "./i18n";
import type { AppHostTypes } from "@polaris/app-host";

type AppMcpToolHandler = AppHostTypes["AppMcpToolHandler"];

/** The most open orders one answer lists, as the manifest's list answer allows. */
const MAX_ORDERS = 200;

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

/** The orders still open, newest first: in one venue, or in all of them. */
const openOrders: AppMcpToolHandler = async (input) => {
    const venueId = str(input.venueId);
    const rows = await prisma.hospitalityOrder.findMany({
        where: { status: "open", ...(venueId ? { venueId } : {}) },
        orderBy: { openedAt: "desc" },
        take: MAX_ORDERS,
        select: { id: true, venueId: true, tableId: true, label: true, covers: true, total: true, waiterName: true, openedAt: true }
    });
    const tableIds = [...new Set(rows.flatMap((row) => (row.tableId ? [row.tableId] : [])))];
    const tables = tableIds.length
        ? await prisma.hospitalityTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, name: true } })
        : [];
    const tableName = new Map(tables.map((table) => [table.id, table.name]));
    return {
        output: {
            count: rows.length,
            items: rows.map((row) => ({
                orderId: row.id,
                venueId: row.venueId,
                table: (row.tableId && tableName.get(row.tableId)) || row.label,
                covers: row.covers,
                total: row.total,
                waiter: row.waiterName,
                openedAt: row.openedAt.toISOString()
            }))
        }
    };
};

/** Whether a product can be ordered: everywhere, or in one venue (its own setting there wins). */
const availability: AppMcpToolHandler = async (input) => {
    const productId = str(input.productId);
    const venueId = str(input.venueId);
    const product = productId
        ? await prisma.hospitalityProduct.findUnique({ where: { id: productId }, select: { id: true, name: true, available: true } })
        : null;
    if (!product) return { refused: (await hospitalityT())("automation.productGone") };
    const override = venueId
        ? await prisma.hospitalityPriceOverride.findUnique({
              where: { venueId_productId: { venueId, productId: product.id } },
              select: { available: true }
          })
        : null;
    return { output: { productId: product.id, name: product.name, available: override?.available ?? product.available } };
};

export const hospitalityMcpTools: Readonly<Record<string, AppMcpToolHandler>> = {
    hospitality_open_orders: openOrders,
    hospitality_product_availability: availability
};
