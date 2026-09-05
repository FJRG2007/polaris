/**
 * The address the call server hands out, and what happens when it stops being
 * this network's.
 *
 * The media server learns the public address of the network it is sitting behind
 * exactly once, by asking a STUN server as it starts, and then hands that address
 * to every browser that joins a call. It never asks again. So on a connection
 * whose address is not permanent - which is most domestic lines - the day the
 * address changes is the day every call from outside stops, and nothing anywhere
 * says so:
 *
 * - the call connects, because signalling goes through the edge on 443 with
 *   everything else and that follows the domain;
 * - both people appear, both rings light up;
 * - and the sound is sent to an address that belongs to somebody else now, so it
 *   arrives nowhere. Eight checks sent, none answered.
 *
 * It looks exactly like a router that was never configured, which is the cruel
 * part: the ports ARE forwarded, the operator did the work weeks ago, and the
 * screen that tells them to go and do it is the one thing that is wrong.
 *
 * So this watches for it. Polaris knows the address the line has now, and it can
 * ask the container engine when the media server last started - if the address
 * changed after that, what it is handing out is an address from before.
 *
 * And then it fixes it, because it can: the server re-asks on boot, so restarting
 * it is the whole repair. That is the rule this exists to keep - Polaris
 * configures what it can and only asks a person for what is genuinely theirs. An
 * administrator hears about it afterwards, as something that happened rather than
 * as a job.
 *
 * When it cannot - a media server somebody else runs, no container engine to
 * reach - it says so, and says the one thing that would fix it. That is the
 * honest half: naming what is wrong beats a screen that keeps insisting on a
 * router rule that was never the problem.
 */

import { notify } from "@/lib/notifications/dispatch";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { callServer } from "@/lib/chat/call-server";
import { detectPublicIp } from "@/lib/network-service";
import { localDockerDriver } from "@/lib/docker-service";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The address this line had when it was last looked at, and when it changed.
 *  Settings rather than rows: one fact about this deployment, outliving every
 *  call it was learned in. */
const SEEN = "chat.calls.publicIpSeen";
const CHANGED_AT = "chat.calls.publicIpChangedAt";

/** The compose service the media server runs as. */
const CALL_SERVICE = "livekit";

export interface CallAddressState {
    /** What this line's public address is now, or null when there is none to
     *  find - a machine with no route out, or one behind carrier NAT, where
     *  none of this applies because calls from outside cannot work anyway. */
    readonly current: string | null;
    /** When this address last changed under us, as far as Polaris has watched. */
    readonly changedAt: string | null;
    /** When the media server last started, which is when it last asked. */
    readonly startedAt: string | null;
    /** Whether it is handing out an address from before the change. */
    readonly stale: boolean;
    /** Whether Polaris put it right itself. */
    readonly healed: boolean;
    /** Why it could not, when it could not. Null when there was nothing to do
     *  or when it was done. */
    readonly cannotHeal: string | null;
}

const NOTHING: CallAddressState = {
    current: null,
    changedAt: null,
    startedAt: null,
    stale: false,
    healed: false,
    cannotHeal: null
};

/**
 * Look, repair, and say.
 *
 * Cheap enough to run on a slow timer: one address lookup and, only when the
 * address is one Polaris has not seen before, one question to the container
 * engine. A line whose address never changes never gets past the first step.
 */
export async function watchCallAddress(): Promise<CallAddressState> {
    const current = await detectPublicIp().catch(() => null);
    // No public address at all. Calls from outside cannot work either way, and
    // there is nothing here that would help anybody.
    if (!current) return NOTHING;

    const seen = await getSetting(SEEN);
    let changedAt = await getSetting(CHANGED_AT);

    if (seen !== current) {
        await setSetting(SEEN, current);
        // The first sighting is not a change. Recording one would make every
        // fresh install announce that its address had moved.
        if (seen) {
            changedAt = new Date().toISOString();
            await setSetting(CHANGED_AT, changedAt);
        }
    }
    if (!changedAt) return { ...NOTHING, current };

    const endpoint = await callServer().catch(() => null);
    // A server somebody else runs is on their network, learned its address
    // there, and is none of this deployment's business.
    if (!endpoint?.shipped) return { ...NOTHING, current, changedAt };

    const container = await callContainer();
    if (!container) {
        return {
            current,
            changedAt,
            startedAt: null,
            stale: false,
            healed: false,
            cannotHeal: null
        };
    }
    // Started since the address moved, so it asked after the move and is handing
    // out the right one. Forgetting the change here is what stops this asking
    // the same question every ten minutes for the life of the deployment.
    if (container.startedAt && container.startedAt > changedAt) {
        await setSetting(CHANGED_AT, null);
        return { current, changedAt, startedAt: container.startedAt, stale: false, healed: false, cannotHeal: null };
    }

    const healed = await restart(container.id);
    if (healed) await setSetting(CHANGED_AT, null);
    const state: CallAddressState = {
        current,
        changedAt,
        startedAt: container.startedAt,
        stale: true,
        healed,
        cannotHeal: healed
            ? null
            : "Polaris could not restart the call server itself. Restarting it is what makes it ask for this network's address again."
    };
    await tellAdmins(state);
    return state;
}

/**
 * Make it ask again, now.
 *
 * The button behind the automatic repair. The watch runs on a slow timer because
 * a line's address changes days apart, and somebody who has just watched a call
 * go quiet should not have to wait out that timer to find out whether this is
 * the reason. It is also the honest answer to "is it this?": pressing it costs a
 * few seconds of no call server and either fixes the calls or rules the whole
 * theory out.
 */
export async function repairCallAddress(): Promise<{ ok: boolean; message: string }> {
    const endpoint = await callServer().catch(() => null);
    if (!endpoint?.shipped) {
        return {
            ok: false,
            message: "This deployment does not run the call server, so there is nothing here to restart."
        };
    }
    const container = await callContainer();
    if (!container) {
        return {
            ok: false,
            message: "Polaris cannot reach a container engine from here, so it cannot restart the call server itself."
        };
    }
    if (!(await restart(container.id))) {
        return { ok: false, message: "The call server did not restart. Chat settings says what it is doing." };
    }
    await setSetting(CHANGED_AT, null);
    return {
        ok: true,
        message: "The call server is restarting and will ask for this network's address again. Calls can be made in a few seconds."
    };
}

/**
 * What the card shows about the address, without changing anything.
 *
 * Deliberately does not run the watch: a render must not restart a container,
 * and a page that repaired something by being opened is a page nobody can open
 * to look.
 */
export async function callAddressFacts(): Promise<{
    current: string | null;
    startedAt: string | null;
    stale: boolean;
}> {
    const [current, changedAt] = await Promise.all([
        detectPublicIp().catch(() => null),
        getSetting(CHANGED_AT)
    ]);
    const container = changedAt ? await callContainer() : null;
    const startedAt = container?.startedAt ?? null;
    return {
        current,
        startedAt,
        stale: Boolean(changedAt && startedAt && startedAt <= changedAt)
    };
}

/** The media server's container, if this deployment runs one. */
async function callContainer(): Promise<{ id: string; startedAt: string | null } | null> {
    let driver: ReturnType<typeof localDockerDriver> | null = null;
    try {
        driver = localDockerDriver();
        const all = await driver.listContainers(true);
        const found = all.find((container) => container.composeService === CALL_SERVICE);
        if (!found) return null;
        const detail = await driver.inspect(found.id).catch(() => null);
        return { id: found.id, startedAt: detail?.startedAt ?? null };
    } catch {
        // No engine to ask. Not a fault: the limited edition has none, and this
        // is simply a question it cannot answer.
        return null;
    } finally {
        await driver?.dispose().catch(() => undefined);
    }
}

async function restart(id: string): Promise<boolean> {
    let driver: ReturnType<typeof localDockerDriver> | null = null;
    try {
        driver = localDockerDriver();
        await driver.restart(id);
        return true;
    } catch (caught) {
        console.error("polaris: could not restart the call server:", caught);
        return false;
    } finally {
        await driver?.dispose().catch(() => undefined);
    }
}

/**
 * Tell every administrator, once per change.
 *
 * Worth saying even when it was repaired: somebody was on a call that went
 * silent, and "your address changed and the call server has been restarted" is
 * the difference between a product that had a bad minute and a product nobody
 * trusts with a phone call again.
 */
async function tellAdmins(state: CallAddressState): Promise<void> {
    const admins = await prisma.user
        .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
        .catch(() => []);
    const title = state.healed
        ? "Calls were repaired after this network's address changed"
        : "Calls cannot reach this network from outside";
    const body = state.healed
        ? [
              `This connection's public address is now ${state.current}. The call server had been handing out the one it found when it last started, which is why calls from outside went quiet while everything on screen looked healthy.`,
              "It has been restarted and has asked again. Nothing needs doing, and the port forwarding you already have is unaffected."
          ].join("\n\n")
        : [
              `This connection's public address is now ${state.current}, and the call server is still handing out the one it found when it last started. Calls between devices on this network work; calls from outside are sent to an address that is no longer this one.`,
              state.cannotHeal ?? ""
          ]
              .filter(Boolean)
              .join("\n\n");

    await Promise.all(
        admins.map((admin) =>
            notify({
                userId: admin.id,
                event: "calls.address",
                title,
                body,
                level: state.healed ? "info" : "warning",
                audience: "admins",
                actionRequired: !state.healed,
                href: "/admin/domains",
                metadata: { address: state.current, changedAt: state.changedAt }
            })
        )
    );
}

/** How often the address is looked at. Slow: a line's address changes on a
 *  reconnection, which is days apart, and every pass costs one lookup. */
const EVERY_MS = 10 * 60_000;

/** Watch from startup, and once shortly after boot - the address most likely to
 *  have moved is the one that moved while this was not running. */
export function startCallAddressWatch(): void {
    const tick = () =>
        void watchCallAddress().catch((error) =>
            console.error("polaris: could not check the call server's address:", error)
        );
    setTimeout(tick, 30_000);
    setInterval(tick, EVERY_MS);
}
