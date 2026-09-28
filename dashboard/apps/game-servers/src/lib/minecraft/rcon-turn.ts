/**
 * One exchange with a server's RCON at a time.
 *
 * The game answers every RCON connection out of one shared buffer: it is emptied
 * before a command runs and read after it, on the connection's own thread, so two
 * commands in flight at once can each come back with the other's answer. Polaris
 * talks to a server from several places at the same moment - the side panel, the
 * players list, an event - and a ground check that read "Test passed" meant for
 * somebody else's command, or a position that was another entity's, turned every
 * place an event looked at into one it could not use. So every command Polaris
 * sends to a server waits for the one before it.
 */
const rconTurns = new Map<string, Promise<unknown>>();

export function inRconTurn<T>(installedAppId: string, work: () => Promise<T>): Promise<T> {
    const before = rconTurns.get(installedAppId) ?? Promise.resolve();
    const turn = before.catch(() => undefined).then(work);
    const settled = turn.catch(() => undefined);
    rconTurns.set(installedAppId, settled);
    void settled.then(() => {
        if (rconTurns.get(installedAppId) === settled) rconTurns.delete(installedAppId);
    });
    return turn;
}
