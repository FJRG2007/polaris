// The page's side of the embed contract: what it tells the page that framed it
// (Polaris, same origin only) and what it accepts from it. The contract itself is
// written down in the app's README (`apps/arcade/README.md`).
//
// Out: polaris-game:progress { stage: 'data' | 'build' | 'compile', done: 0..1 }
//      polaris-game:ready
//      polaris-game:failed { reason: 'graphics' | 'data' | 'error' }
//      polaris-game:state { x, y, z, heading, mode, speed }   (10 a second, while joined)
// In:  polaris-game:join { self: { id, name } }
//      polaris-game:players { players: [{ id, name, x, y, z, heading, mode }] }   (everyone else, replaces the last list)
//      polaris-game:leave

const embedded = window.parent !== window;
const MODES = new Set(['person', 'car', 'cyclist', 'helicopter']);
const MAX_PLAYERS = 32;

let finished = false;
let joined = null;
const listeners = new Set();

/** Post one message to the framing page; nothing when the page is opened on its own. */
export function tellHost(message) {
  if (embedded) parent.postMessage(message, location.origin);
}

export function reportProgress(stage, done) {
  if (!finished) tellHost({ type: 'polaris-game:progress', stage, done: Math.min(1, Math.max(0, done)) });
}

export function reportReady() {
  if (finished) return;
  finished = true;
  tellHost({ type: 'polaris-game:ready' });
}

export function reportFailure(reason) {
  if (finished) return;
  finished = true;
  tellHost({ type: 'polaris-game:failed', reason });
}

// Anything that throws before the city is on screen ends the load; after that a
// stray error is the game's own business and is left to the console.
window.addEventListener('error', () => reportFailure('error'));
window.addEventListener('unhandledrejection', () => reportFailure('error'));

/** Who this player is in the session, or null when not in one. */
export function sessionSelf() {
  return joined;
}

/** Called with every list of other players the host sends, and with [] on leave. */
export function onPlayers(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function readPlayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, x, y, z, heading, mode } = raw;
  if (!text(id, 128) || !text(name, 64) || ![x, y, z, heading].every(finite) || !MODES.has(mode)) return null;
  return { id, name, x, y, z, heading, mode };
}

window.addEventListener('message', (event) => {
  if (!embedded || event.source !== parent || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'polaris-game:join') {
    const self = data.self;
    if (self && text(self.id, 128) && text(self.name, 64)) joined = { id: self.id, name: self.name };
  } else if (data.type === 'polaris-game:leave') {
    joined = null;
    for (const listener of listeners) listener([]);
  } else if (data.type === 'polaris-game:players' && joined && Array.isArray(data.players)) {
    const players = data.players.slice(0, MAX_PLAYERS).map(readPlayer).filter((p) => p && p.id !== joined.id);
    for (const listener of listeners) listener(players);
  }
});

let nextState = 0;

/** Send the active player's state to the host, at most ten times a second, while in a session. */
export function shareState(now, entity, mode) {
  if (!joined || now < nextState) return;
  nextState = now + 100;
  const { x, y, z } = entity.position;
  const heading = Math.atan2(Math.sin(entity.heading), Math.cos(entity.heading));
  tellHost({ type: 'polaris-game:state', x, y, z, heading, mode, speed: entity.speed || 0 });
}
