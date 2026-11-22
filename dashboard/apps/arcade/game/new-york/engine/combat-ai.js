// js/combat-ai.js
// The crews' behaviour and the wanted level, as pure state transitions (tested without a scene).
//
// A crew member is in one state at a time:
//   patrol       walks between points around where it spawned
//   investigate  heard a shot it did not see: walks to where it came from
//   engage       sees the player: faces them, closes to firing range and shoots
//   search       lost sight of the player: goes to the last place it saw them, then gives up
//   cover        hurt while engaged: backs off to break the line of fire, then returns to the fight
// The wanted level climbs with what the player does (shots fired near people, hits, takedowns) and cools down only
// while no one is engaging; each star allows more crew at once.

const STATES = ['patrol', 'investigate', 'engage', 'search', 'cover'];

const AI = {
  hearing: 70,         // metres a gunshot carries
  sight: 55,           // metres they see the player within
  searchTime: 9,       // seconds of searching before going back to patrol
  investigateTime: 12, // seconds before giving up on a sound
  coverHealth: 0.4,    // share of health under which an engaged member takes cover
  coverTime: 3.5       // seconds spent in cover before re-engaging
};

function createCrewMember(id, x, z, { health = 100 } = {}) {
  return {
    id, x, z, heading: 0, health, maxHealth: health, alive: true, state: 'patrol', stateTime: 0,
    home: { x, z }, target: null, lastSeen: null, nextShotAt: 0, tookCover: false
  };
}

function enter(member, state, target = null) {
  member.state = state;
  member.stateTime = 0;
  member.target = target;
}

/**
 * One decision step. `senses`: { seesPlayer, player: {x, z}, heardShotAt: {x, z} | null }.
 * Returns the member (mutated) so a caller can chain; never moves it (the caller does, towards `target`).
 */
function think(member, senses, dt) {
  if (!member.alive) return member;
  member.stateTime += dt;
  const { seesPlayer, player, heardShotAt } = senses;
  if (seesPlayer && player) member.lastSeen = { x: player.x, z: player.z };

  switch (member.state) {
    case 'patrol':
    case 'investigate':
      if (seesPlayer) enter(member, 'engage', member.lastSeen);
      else if (heardShotAt) enter(member, 'investigate', { x: heardShotAt.x, z: heardShotAt.z });
      else if (member.state === 'investigate' && member.stateTime > AI.investigateTime) enter(member, 'patrol');
      break;
    case 'engage':
      if (!member.tookCover && member.health / member.maxHealth < AI.coverHealth) {
        member.tookCover = true;
        enter(member, 'cover', member.lastSeen);
      } else if (!seesPlayer) {
        enter(member, 'search', member.lastSeen);
      } else {
        member.target = member.lastSeen;
      }
      break;
    case 'search':
      if (seesPlayer) enter(member, 'engage', member.lastSeen);
      else if (heardShotAt) member.target = { x: heardShotAt.x, z: heardShotAt.z };
      else if (member.stateTime > AI.searchTime) enter(member, 'patrol');
      break;
    case 'cover':
      if (member.stateTime > AI.coverTime) enter(member, seesPlayer ? 'engage' : 'search', member.lastSeen);
      break;
    default:
      enter(member, 'patrol');
  }
  return member;
}

/** Applies damage; true when it was the last of the member's health. */
function damageMember(member, amount) {
  if (!member.alive) return false;
  member.health = Math.max(0, member.health - amount);
  if (member.health > 0) return false;
  member.alive = false;
  return true;
}

// Wanted level: heat in "stars" (0 to 5), from events, cooling while unseen
const HEAT = { shot: 0.08, hit: 0.35, takedown: 1, maxStars: 5, coolDelay: 6, coolRate: 0.12 };

function createWanted() {
  return { heat: 0, sinceSeen: 0 };
}

function stars(wanted) {
  return Math.min(HEAT.maxStars, Math.floor(wanted.heat + 1e-9));
}

/** `event`: 'shot' | 'hit' | 'takedown'. Never lowers the level. */
function raiseWanted(wanted, event) {
  wanted.heat = Math.min(HEAT.maxStars + 0.99, wanted.heat + (HEAT[event] ?? 0));
  wanted.sinceSeen = 0;
}

/** Per frame: heat cools after `coolDelay` seconds with nobody engaging the player. */
function coolWanted(wanted, dt, engaged) {
  if (engaged) {
    wanted.sinceSeen = 0;
    return;
  }
  wanted.sinceSeen += dt;
  if (wanted.sinceSeen > HEAT.coolDelay) wanted.heat = Math.max(0, wanted.heat - HEAT.coolRate * dt);
}

/** How many crew may be about at a wanted level: a few on patrol at zero, more with each star. */
function crewBudget(level) {
  return 3 + level * 2;
}

export {
  AI, HEAT, STATES, coolWanted, createCrewMember, createWanted, crewBudget, damageMember, raiseWanted, stars, think
};
