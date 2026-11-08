// The start screen: once the city is on screen, before anything moves, the reader picks how they play - on this
// device (keyboard, mouse or touch) or with a controller (a Bluetooth or USB gamepad, or a phone paired by a code or a QR
// - phone-pad.js). It is a modal <dialog> drawn like the game menu, the game stays paused while it is open, and
// the keyboard, the mouse and a gamepad (gamepad-controls.js drives it through move/activate/goBack/close) all work it.
// The last choice is remembered and focused first next time.
import { t, onLocaleChange } from './i18n.js';

const STORAGE_KEY = 'nyc-input';
const CHOICES = ['device', 'gamepad', 'phone'];
const FOCUSABLE = 'button:not([hidden]):not(:disabled)';

/** The remembered choice, or '' where there is none (or storage is blocked). */
function rememberedChoice() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return CHOICES.includes(value) ? value : '';
  } catch {
    return '';
  }
}

function rememberChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage is optional: the screen just has no preference next time
  }
}

class StartScreen {
  /**
   * @param {object} options
   * @param {() => {connected: boolean, padName: string}} options.gamepad  the gamepad's state (GamepadControls)
   * @param {(open: boolean) => void} options.onOpenChange
   * @param {import('./phone-pad.js').PhonePad} [options.phone]  the phone pad, paired from the phone page
   * @param {(choice: string) => void} options.onChoose  'device', 'gamepad' or 'phone'
   */
  constructor({ gamepad, phone = null, onOpenChange, onChoose }) {
    this.gamepad = gamepad;
    this.phone = phone;
    this.onOpenChange = onOpenChange;
    this.onChoose = onChoose;
    this.dialog = document.getElementById('start-screen');
    this.title = document.getElementById('start-title');
    this.back = this.dialog?.querySelector('[data-start-back]');
    this.padButton = this.dialog?.querySelector('[data-start-choose="gamepad"]');
    this.padStatus = document.getElementById('start-pad-status');
    this.phoneButton = this.dialog?.querySelector('[data-start-choose="phone"]');
    this.phoneRetry = this.dialog?.querySelector('[data-start-retry]');
    this.phoneQr = document.getElementById('start-phone-qr');
    this.phoneCode = document.getElementById('start-phone-code');
    this.phoneStatus = document.getElementById('start-phone-status');
    this.view = 'main';
    this.isOpen = false;
    if (!this.dialog) return;

    this.dialog.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('button') : null;
      if (!target || target.disabled) return;
      if (target.dataset.startOpen) this.show(target.dataset.startOpen);
      else if (target.hasAttribute('data-start-back')) this.goBack();
      else if (target.hasAttribute('data-start-retry')) this.phone?.request();
      else if (target.dataset.startChoose) this.choose(target.dataset.startChoose);
    });
    // Esc goes back a page; on the first it does nothing, since there is nothing behind this screen to return to
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.goBack();
    });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    onLocaleChange(() => this.refresh());
    // The phone that takes the pad while its page is open is the one to play with: no second step
    this.phone?.onChange(() => {
      if (this.isOpen && this.view === 'phone' && this.phone.connected) this.choose('phone');
      else this.refresh();
    });
  }

  onKey(e) {
    if (!this.isOpen) return;
    // While the screen is open no key reaches the game
    e.stopImmediatePropagation();
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      this.move(e.code === 'ArrowDown' ? 1 : -1);
    } else if ((e.code === 'ArrowLeft' || e.code === 'Backspace' || e.code === 'Escape') && this.view !== 'main') {
      e.preventDefault();
      this.goBack();
    } else if (e.code === 'Escape') {
      e.preventDefault();
    }
  }

  open() {
    if (this.isOpen || !this.dialog) return;
    this.isOpen = true;
    this.show('main');
    this.dialog.showModal();
    this.focusFirst();
    this.onOpenChange(true);
  }

  choose(choice) {
    if (!CHOICES.includes(choice) || !this.isOpen) return;
    if (choice === 'gamepad' && !this.gamepad().connected) return;
    if (choice === 'phone' && !this.phone?.connected) return;
    rememberChoice(choice);
    this.isOpen = false;
    this.dialog.close();
    this.onChoose(choice);
    this.onOpenChange(false);
  }

  show(view) {
    if (view !== 'main' && view !== 'controller' && view !== 'phone') return;
    if (view === 'phone') this.phone?.request();
    const from = this.view;
    this.view = view;
    for (const el of this.dialog.querySelectorAll('[data-start-view]')) el.hidden = el.dataset.startView !== view;
    this.back.hidden = view === 'main';
    this.refresh();
    if (!this.isOpen) return;
    if (view === 'main' && from !== 'main') this.dialog.querySelector('[data-start-open="controller"]')?.focus();
    else if (view === 'controller' && from === 'phone') this.dialog.querySelector('[data-start-open="phone"]')?.focus();
    else this.focusFirst();
  }

  items() {
    const page = this.dialog.querySelector(`[data-start-view="${this.view}"]`);
    return [...(this.view === 'main' ? [] : [this.back]), ...page.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden);
  }

  focusFirst() {
    const items = this.items().filter((el) => el !== this.back);
    const remembered = rememberedChoice();
    const preferred = this.view === 'main'
      ? this.dialog.querySelector(remembered === 'gamepad' || remembered === 'phone' ? '[data-start-open="controller"]' : '[data-start-choose="device"]')
      : this.view === 'phone' ? null
      : remembered === 'phone' ? this.dialog.querySelector('[data-start-open="phone"]')
      : this.padButton?.disabled ? null : this.padButton;
    (items.includes(preferred) ? preferred : items[0] || this.back)?.focus();
  }

  move(step) {
    const items = this.items();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    items[(at + step + items.length) % items.length].focus();
  }

  /** Gamepad A: presses the focused item. */
  activate() {
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement && this.dialog.contains(el)) el.click();
  }

  adjust() {}

  /** Gamepad B, Esc: one page back. */
  goBack() {
    if (this.view === 'phone') this.show('controller');
    else if (this.view !== 'main') this.show('main');
  }

  /** Gamepad Start: the pad that pressed it is the controller. */
  close() {
    if (this.phone?.connected) this.choose('phone');
    else if (this.gamepad().connected) this.choose('gamepad');
  }

  /** Redraws what depends on the gamepad or the language. */
  refresh() {
    if (!this.dialog) return;
    this.title.textContent = t(this.view === 'main' ? 'start.title' : this.view === 'phone' ? 'start.phoneTitle' : 'start.controllerTitle');
    this.refreshPhone();
    const { connected, padName } = this.gamepad();
    this.padButton.disabled = !connected;
    this.padStatus.textContent = connected ? padName || t('start.padReady') : t('start.padWaiting');
    // A pad that turns up while its page is open takes the focus from the way back (or from a button that just went off)
    const focus = document.activeElement;
    if (this.isOpen && this.view === 'controller' && connected && (focus === this.back || focus?.dataset?.startOpen === 'phone' || !this.dialog.contains(focus))) this.padButton.focus();
  }

  /** The phone page: the QR and the code to pair with, and how the pairing stands. */
  refreshPhone() {
    if (!this.phoneButton) return;
    const phone = this.phone;
    const offer = phone?.offer;
    const connected = Boolean(phone?.connected);
    this.phoneButton.disabled = !connected;
    this.phoneRetry.hidden = !phone?.failed;
    this.phoneQr.hidden = !offer?.qr || connected;
    if (offer?.qr && this.phoneQr.getAttribute('src') !== offer.qr) this.phoneQr.src = offer.qr;
    this.phoneQr.alt = t('start.phoneQr');
    // Spaced in threes, so it reads like a code and is typed like one
    this.phoneCode.textContent = offer && !connected ? `${offer.code.slice(0, 3)} ${offer.code.slice(3)}` : '';
    const status = !phone ? 'start.phoneUnavailable' : connected ? 'start.padReady' : phone.failed ? 'start.phoneFailed'
      : offer ? 'start.phoneWaiting' : 'start.phoneOpening';
    this.phoneStatus.textContent = t(status);
  }
}

export { StartScreen, rememberedChoice };
