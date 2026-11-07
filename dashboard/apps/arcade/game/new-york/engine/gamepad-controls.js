import { isTypingInField } from './city-config.js';

const DEAD_ZONE = 0.15;
const TRIGGER_DEAD_ZONE = 0.05;
const BUTTON_COUNT = 17;
const RUMBLE_GAP_MS = 250;

function axis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function steeringAxis(value) {
  const v = axis(value);
  return Math.sign(v) * Math.max(0, (Math.abs(v) - DEAD_ZONE) / (1 - DEAD_ZONE));
}

function rawButton(button) {
  return Number.isFinite(button?.value) ? Math.max(0, Math.min(1, button.value)) : button?.pressed ? 1 : 0;
}

/** Whether a pad can drive the game at all: two sticks' worth of axes is too much to ask of a pad with no mapping. */
function usablePad(pad) {
  if (!pad?.connected) return false;
  if (pad.mapping === 'standard') return true;
  return (pad.axes?.length || 0) >= 2 && (pad.buttons?.length || 0) >= 4;
}

/**
 * A pad read as the W3C standard layout: `axes` [left x, left y, right x, right y] and 17 button values 0..1 in the
 * standard order. A standard pad passes through. A pad with no mapping (an older driver, Firefox on Linux, a generic
 * USB pad) keeps the face, shoulder, Back, Start and stick buttons where most of them put them (0-11), takes the right
 * stick from axes 3/4 when there are six or more (2 and 5 are then its analog triggers) and from 2/3 otherwise, and
 * reads the d-pad from a hat on the last two axes when it has no d-pad buttons. A trigger axis rests at -1, but some
 * browsers report 0 until it is first touched, so it counts only once it has been seen at rest (`state.restSeen`).
 */
function normalizePad(pad, state = {}) {
  const axes = pad?.axes || [];
  const raw = pad?.buttons || [];
  const values = Array.from({ length: BUTTON_COUNT }, (_, i) => rawButton(raw[i]));
  if (pad?.mapping === 'standard') {
    return { standard: true, axes: [axis(axes[0]), axis(axes[1]), axis(axes[2]), axis(axes[3])], buttons: values };
  }
  const wide = axes.length >= 6;
  const right = wide ? 3 : 2;
  if (wide) {
    state.restSeen ??= [false, false];
    [2, 5].forEach((index, side) => {
      const value = axis(axes[index]);
      if (value < -0.9) state.restSeen[side] = true;
      if (state.restSeen[side]) values[6 + side] = Math.max(values[6 + side], (value + 1) / 2);
    });
  }
  if (raw.length < 13 && axes.length >= (wide ? 8 : 6)) {
    const hx = axis(axes[axes.length - 2]), hy = axis(axes[axes.length - 1]);
    values[12] = hy < -0.5 ? 1 : 0;
    values[13] = hy > 0.5 ? 1 : 0;
    values[14] = hx < -0.5 ? 1 : 0;
    values[15] = hx > 0.5 ? 1 : 0;
  }
  return { standard: false, axes: [axis(axes[0]), axis(axes[1]), axis(axes[right]), axis(axes[right + 1])], buttons: values };
}

function stick(pad, offset) {
  const x = axis(pad.axes?.[offset]), y = axis(pad.axes?.[offset + 1]);
  const distance = Math.hypot(x, y);
  const strength = Math.max(0, (Math.min(distance, 1) - DEAD_ZONE) / (1 - DEAD_ZONE));
  return distance ? { x: x / distance * strength, y: y / distance * strength } : { x: 0, y: 0 };
}

/** A button's value 0..1; `pad` is either a raw Gamepad or a normalized read (whose buttons are plain numbers). */
function buttonValue(pad, index) {
  const button = pad.buttons?.[index];
  const value = typeof button === 'number' ? Math.max(0, Math.min(1, button)) : rawButton(button);
  return index === 6 || index === 7 ? Math.max(0, (value - TRIGGER_DEAD_ZONE) / (1 - TRIGGER_DEAD_ZONE)) : value;
}

function buttons(pad) {
  return Array.from({ length: BUTTON_COUNT }, (_, i) => {
    const button = pad.buttons?.[i];
    return typeof button === 'number' ? button > 0.5 : Boolean(button?.pressed) || rawButton(button) > 0.5;
  });
}

/** How hard an impact shakes the pad: nothing under a nudge, then up to a full, longer rumble for a crash. */
function impactRumble(speed) {
  if (!Number.isFinite(speed) || speed < 2) return null;
  const strength = Math.min(1, (speed - 2) / 14);
  return { strong: 0.25 + 0.75 * strength, weak: 0.4 + 0.6 * strength, duration: Math.round(90 + 260 * strength) };
}

/** Plays a rumble on whichever actuator the browser offers (Chrome and Edge, then Firefox); a pad without one is fine. */
function rumble(pad, effect) {
  if (!pad || !effect) return false;
  try {
    const actuator = pad.vibrationActuator;
    if (typeof actuator?.playEffect === 'function') {
      actuator.playEffect('dual-rumble', { startDelay: 0, duration: effect.duration,
        strongMagnitude: effect.strong, weakMagnitude: effect.weak })?.catch?.(() => {});
      return true;
    }
    const haptic = pad.hapticActuators?.[0];
    if (typeof haptic?.pulse === 'function') {
      haptic.pulse(effect.strong, effect.duration)?.catch?.(() => {});
      return true;
    }
  } catch {
    // A pad that refuses the effect just does not shake
  }
  return false;
}

/**
 * The helicopter on a gamepad: the triggers climb (RT) and descend (LT) by how far they are pulled, A and B do the same
 * at full rate for a pad whose triggers read badly, and clicking the left stick holds turbo. `held(i)` is whether button
 * i is down (and not left over from before a reset). Returns `vertical` (-1 descend to 1 climb) and `turbo` (0 or 1).
 */
function helicopterPadInput(pad, held) {
  const climb = Math.max(buttonValue(pad, 7), held(0) ? 1 : 0);
  const descend = Math.max(buttonValue(pad, 6), held(1) ? 1 : 0);
  return { vertical: climb - descend, turbo: held(10) ? 1 : 0 };
}

class GamepadControls {
  constructor(controllerManager, cameraSystem, callbacks = {}) {
    this.controller = controllerManager;
    this.camera = cameraSystem;
    this.callbacks = callbacks;
    this.connected = false;
    this.enabled = true;
    this.padIndex = null;
    this.padId = null;
    this.padName = '';
    this.standard = true;
    this.padState = {};
    this.lastRumble = -Infinity;
    this.previousButtons = [];
    this.suppressedButtons = [];
    this.syncButtons = true;
    this.revision = 0;
    this.navDirection = 0; // the left stick's last up/down step through the menu
    this.focused = typeof document.hasFocus !== 'function' || document.hasFocus();

    window.addEventListener('blur', () => {
      this.focused = false;
      this.reset();
    });
    window.addEventListener('focus', () => {
      this.focused = true;
      this.reset();
    });
    document.addEventListener('visibilitychange', () => this.reset());
    // A pad plugged in or paired while the game runs is noticed on the next frame by update(); these events only make
    // a pad that is unplugged while the game is paused (the loop still polls) reported at once.
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad?.index === this.padIndex) this.update(0);
    });
  }

  readPad() {
    // Some browsers expose the API but reject it through Permissions Policy.
    try {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
      const pads = navigator.getGamepads();
      // The pad in use stays in use; otherwise the first with the standard layout, then the first that can play at all
      let first = null, fallback = null;
      for (let i = 0; i < (pads?.length || 0); i++) {
        const pad = pads[i];
        if (!usablePad(pad)) continue;
        if (pad.index === this.padIndex && pad.id === this.padId) return pad;
        if (pad.mapping === 'standard') first ||= pad;
        else fallback ||= pad;
      }
      return first || fallback;
    } catch {
      return null;
    }
  }

  reset() {
    this.revision++;
    this.controller.clearGamepadInput();
    const pad = this.readPad();
    if (pad && pad.index === this.padIndex && pad.id === this.padId) {
      this.previousButtons = buttons(normalizePad(pad, this.padState));
      this.suppressedButtons = this.previousButtons.slice();
      this.syncButtons = false;
    } else {
      this.syncButtons = true;
    }
  }

  setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  /** Shakes the pad in use for an impact of the player's at `speed` m/s, where the pad and browser support it. */
  impact(speed) {
    if (!this.connected || !this.enabled || !this.focused || document.hidden) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastRumble < RUMBLE_GAP_MS) return false;
    const played = rumble(this.readPad(), impactRumble(speed));
    if (played) this.lastRumble = now;
    return played;
  }

  update(dt) {
    const device = this.readPad();
    const connected = Boolean(device);
    const changedPad = device ? device.index !== this.padIndex || device.id !== this.padId : this.connected;
    if (changedPad) {
      const previous = this.padName;
      this.controller.clearGamepadInput();
      this.padIndex = device ? device.index : null;
      this.padId = device ? device.id : null;
      this.padName = device ? padLabel(device.id) : '';
      this.standard = device ? device.mapping === 'standard' : true;
      this.padState = {};
      this.syncButtons = true;
      this.connected = connected;
      this.callbacks.onPadChange?.({ connected, name: this.padName || previous, standard: this.standard });
    }
    this.connected = connected;
    if (!device) return;

    const pad = normalizePad(device, this.padState);
    const pressed = buttons(pad);
    if (this.syncButtons) {
      // Connecting, switching pads, or resetting must not turn a held button into a fresh action.
      this.previousButtons = pressed.slice();
      this.suppressedButtons = pressed.slice();
      this.syncButtons = false;
    }
    for (let i = 0; i < BUTTON_COUNT; i++) if (!pressed[i]) this.suppressedButtons[i] = false;
    const edge = (i) => pressed[i] && !this.previousButtons[i] && !this.suppressedButtons[i];
    const held = (i) => pressed[i] && !this.suppressedButtons[i];
    // Capture edges before callbacks: changing mode or opening the map may synchronously call reset().
    // Start (9) is the game menu, Back (8) the map.
    const toggleMenu = edge(9), toggleMap = edge(8), closeMap = edge(1);
    const menuKeys = { up: edge(12), down: edge(13), left: edge(14), right: edge(15), accept: edge(0), back: edge(1) };
    const cycleMode = Number(Boolean(edge(5))) - Number(Boolean(edge(4)));
    const cycleCamera = edge(3), recenter = edge(11), horn = edge(2);
    this.previousButtons = pressed;

    const target = document.activeElement;
    const typing = isTypingInField({ target }) || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
    if (!this.focused || document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus()) || typing) {
      this.suppressedButtons = pressed.slice();
      this.controller.clearGamepadInput();
      return;
    }

    // The start screen, before play, is driven exactly like the menu
    const menu = this.callbacks.startScreen?.isOpen ? this.callbacks.startScreen : this.callbacks.menu;
    if (menu?.isOpen) {
      this.controller.clearGamepadInput();
      const y = stick(pad, 0).y;
      const direction = y > 0.6 ? 1 : y < -0.6 ? -1 : 0;
      const stepped = direction !== this.navDirection ? direction : 0;
      this.navDirection = direction;
      if (toggleMenu) menu.close();
      else if (menuKeys.back) menu.goBack();
      else if (menuKeys.accept) menu.activate();
      else if (menuKeys.up || stepped < 0) menu.move(-1);
      else if (menuKeys.down || stepped > 0) menu.move(1);
      else if (menuKeys.left || menuKeys.right) menu.adjust(menuKeys.right ? 1 : -1);
      return;
    }
    if (toggleMenu && this.enabled) {
      this.controller.clearGamepadInput();
      menu?.open();
      return;
    }

    const revision = this.revision;
    if (toggleMap) {
      this.controller.clearGamepadInput();
      this.callbacks.onToggleMap?.();
      return;
    }
    if (!this.enabled) {
      this.controller.clearGamepadInput();
      for (let i = 0; i < BUTTON_COUNT; i++) if (i !== 1 && i !== 8) this.suppressedButtons[i] = pressed[i];
      if (closeMap) this.callbacks.onCloseMap?.();
      return;
    }
    if (cycleMode) this.callbacks.onCycleMode?.(cycleMode);
    if (revision !== this.revision) return;
    if (cycleCamera) this.callbacks.onCycleCamera?.(1);
    if (revision !== this.revision) return;
    if (recenter) this.camera.resetOrbit();

    const mode = this.controller.activeMode;
    if (horn && mode === 'car') this.callbacks.onHorn?.();
    const driving = mode === 'car' || mode === 'cyclist';
    const movement = driving ? { x: steeringAxis(pad.axes?.[0]), y: 0 } : stick(pad, 0);
    const look = stick(pad, 2);
    let drive = -movement.y;
    let vertical = 0;
    let turbo = 0;
    if (driving) {
      drive = buttonValue(pad, 7) - buttonValue(pad, 6);
    } else if (mode === 'helicopter') {
      ({ vertical, turbo } = helicopterPadInput(pad, held));
    }
    this.controller.setGamepadInput('forward', Math.max(0, drive));
    this.controller.setGamepadInput('backward', Math.max(0, -drive));
    this.controller.setGamepadInput('left', Math.max(0, -movement.x));
    this.controller.setGamepadInput('right', Math.max(0, movement.x));
    this.controller.setGamepadInput('up', mode === 'person' ? Number(Boolean(held(0))) : Math.max(0, vertical));
    this.controller.setGamepadInput('down', Math.max(0, -vertical));
    this.controller.setGamepadInput('turbo', turbo);
    const zoom = Number(Boolean(held(13))) - Number(Boolean(held(12)));
    this.camera.applyGamepadInput(look.x, look.y, zoom, Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0);
  }
}

/** A pad's name for the screen, without the vendor and product codes browsers append (or put first, in Firefox). */
function padLabel(id) {
  const text = String(id || '')
    .replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor: [0-9a-f]+ Product: [0-9a-f]+\)\s*/gi, ' ')
    .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 48);
}

export { GamepadControls, helicopterPadInput, normalizePad, usablePad, impactRumble, rumble, padLabel };
