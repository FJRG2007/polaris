/**
 * The automation steps the manifest declares (`automationSteps` in
 * package.json), done. The dashboard has already checked each step's settings
 * against its declared fields and the run-as account against its permission;
 * these only do the work, through the same functions the screens call, and
 * answer with the declared output or a refusal in the reader's words.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { sendLines } from "./orders";
import { hospitalityT } from "./i18n";
import { setAvailability } from "./catalog";
import { HospitalityRefusal } from "./outcome";
import type { AppHostTypes } from "@polaris/app-host";

type AppStepHandler = AppHostTypes["AppStepHandler"];
type Answer = Awaited<ReturnType<AppStepHandler>>;

/** A refusal the venue gives, in words; anything else is thrown for the host to log. */
async function refusedOn(caught: unknown): Promise<Answer> {
    if (!(caught instanceof HospitalityRefusal)) throw caught;
    return { refused: (await hospitalityT())(caught.key) };
}

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Take a product off the menu, or put it back - everywhere, or in one venue. */
const availability: AppStepHandler = async (input, context) => {
    const productId = str(input.productId);
    const venueId = str(input.venueId);
    const available = input.available === true;
    if (!productId) return { refused: (await hospitalityT())("automation.productGone") };
    const [product, venue] = await Promise.all([
        prisma.hospitalityProduct.findUnique({ where: { id: productId }, select: { id: true } }),
        venueId ? prisma.hospitalityVenue.findUnique({ where: { id: venueId }, select: { id: true } }) : null
    ]);
    if (!product || (venueId && !venue)) return { refused: (await hospitalityT())("automation.productGone") };
    try {
        await setAvailability(productId, venueId, available, context.actorId);
    } catch (caught) {
        return refusedOn(caught);
    }
    return { output: { productId, available } };
};

/** Fire what is still pending on an order: all of it, or one course. */
const fire: AppStepHandler = async (input, context) => {
    const orderId = str(input.orderId);
    if (!orderId) return { refused: (await hospitalityT())("orders.gone") };
    const course = typeof input.course === "number" ? input.course : null;
    try {
        const sent = await sendLines(orderId, course, context.actorId);
        return { output: { orderId, sent } };
    } catch (caught) {
        return refusedOn(caught);
    }
};

export const hospitalitySteps: Readonly<Record<string, AppStepHandler>> = {
    "hospitality.action.setAvailability": availability,
    "hospitality.action.fireOrder": fire
};
