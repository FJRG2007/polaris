// js/phone-pad.js
// A phone as the controller. The page that frames the game (Polaris) pairs the phone and relays it; here the phone
// is one more gamepad in the W3C standard layout, so gamepad-controls.js drives the game, the start screen and the
// menu with it exactly as with a Bluetooth or USB pad, and a rumble on it buzzes the phone.
//
// Out: polaris-game:pad-open                                   (the reader opened the phone page: offer a code)
//      polaris-game:pad-rumble { strong, weak, duration }      (an impact, for the phone to vibrate)
// In:  polaris-game:pad { code, link, qr }                     (the code to type and a QR image (data: URL) of the link)
//      polaris-game:pad { connected, name }                    (a phone took the pad, or let go of it)
//      polaris-game:pad { failed: true }                       (no pad could be opened)
//      polaris-game:pad-input { axes[4], buttons[17] }         (the phone's controls, each 0..1, axes -1..1)
import { tellHost } from './embed.js';
import { t } from './i18n.js';

const AXES = 4;
const BUTTONS = 17;

function unit(value, min) {
  return Number.isFinite(value) ? Math.max(min, Math.min(1, value)) : 0;
}

/** A frame from the phone as standard-pad axes and buttons, or null where it is not one. */
function readFrame(raw) {
  if (!raw || !Array.isArray(raw.axes) || !Array.isArray(raw.buttons)) return null;
  if (raw.axes.length !== AXES || raw.buttons.length !== BUTTONS) return null;
  return {
    axes: raw.axes.map((v) => unit(v, -1)),
    buttons: raw.buttons.map((v) => {
      const value = unit(v, 0);
      return { value, pressed: value > 0.5, touched: value > 0 };
    })
  };
}

/** An offer from the host: a six-digit code, its link and a QR image of it, or null. */
function readOffer(raw) {
  if (!raw || typeof raw.code !== 'string' || !/^\d{6}$/.test(raw.code)) return null;
  const qr = typeof raw.qr === 'string' && raw.qr.startsWith('data:image/') && raw.qr.length < 200_000 ? raw.qr : '';
  const link = typeof raw.link === 'string' && /^https?:\/\//.test(raw.link) && raw.link.length < 2048 ? raw.link : '';
  return { code: raw.code, link, qr };
}

class PhonePad {
  constructor(win = window) {
    this.offer = null;
    this.failed = false;
    this.requested = false;
    this.listeners = new Set();
    this.pad = {
      id: 'Phone',
      index: -1,
      mapping: 'standard',
      connected: false,
      timestamp: 0,
      axes: new Array(AXES).fill(0),
      buttons: Array.from({ length: BUTTONS }, () => ({ value: 0, pressed: false, touched: false })),
      vibrationActuator: {
        playEffect: (_type, effect = {}) => {
          if (!this.pad.connected) return Promise.resolve('preempted');
          tellHost({
            type: 'polaris-game:pad-rumble',
            strong: unit(effect.strongMagnitude, 0),
            weak: unit(effect.weakMagnitude, 0),
            duration: Math.max(1, Math.min(2000, Math.round(effect.duration) || 1))
          });
          return Promise.resolve('complete');
        }
      }
    };
    win.addEventListener('message', (event) => {
      if (win.parent === win || event.source !== win.parent || event.origin !== win.location.origin) return;
      this.receive(event.data);
    });
  }

  /** Whether a phone holds the pad. */
  get connected() {
    return this.pad.connected;
  }

  /** Asks the host for a code to pair a phone with (once; a failed attempt may ask again). */
  request() {
    if (this.requested && !this.failed) return;
    this.requested = true;
    this.failed = false;
    tellHost({ type: 'polaris-game:pad-open' });
    this.changed();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed() {
    for (const listener of this.listeners) listener(this);
  }

  receive(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'polaris-game:pad-input') {
      const frame = readFrame(data);
      if (!frame || !this.pad.connected) return;
      this.pad.axes = frame.axes;
      this.pad.buttons = frame.buttons;
      this.pad.timestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
    } else if (data.type === 'polaris-game:pad') {
      if (data.failed === true) {
        this.failed = true;
        this.offer = null;
      } else if (typeof data.connected === 'boolean') {
        this.pad.connected = data.connected;
        // The pad's name on screen, in the reader's language (gamepad-controls.js reads it as the pad's id)
        if (data.connected) this.pad.id = t('start.phone');
        if (!data.connected) {
          this.pad.axes = new Array(AXES).fill(0);
          this.pad.buttons = this.pad.buttons.map(() => ({ value: 0, pressed: false, touched: false }));
        }
      } else {
        const offer = readOffer(data);
        if (!offer) return;
        this.offer = offer;
        this.failed = false;
      }
      this.changed();
    }
  }
}

export { PhonePad, readFrame, readOffer };
