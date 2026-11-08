// The start screen every game shares: once the game is on screen, before anything moves, the reader picks how they
// play, every way listed on its first page - on this device (keyboard, mouse or touch), with a gamepad (Bluetooth or
// USB), with a phone as the controller (paired by a code or a QR, phone-pad.js), or with others (the host's rooms for
// this game, offered only where the host says the game has rooms). It is a modal <dialog> the game draws like its
// menu, the game stays paused while it is open, and the keyboard, the mouse and a gamepad (move/activate/goBack/close)
// all work it. The last choice is remembered and focused first next time.
//
// A game brings the markup (ids and data attributes below, see new-york/index.html), its words under `start.*`, and
// its own `t` and `onLocaleChange`; nothing in here is about any one game.

const CHOICES = ['device', 'gamepad', 'phone'];
const FOCUSABLE = 'button:not([hidden]):not(:disabled)';
const DEFAULT_KEY = 'polaris-game-input';

/** The remembered choice, or '' where there is none (or storage is blocked). */
function rememberedChoice(storageKey = DEFAULT_KEY) {
  try {
    const value = localStorage.getItem(storageKey);
    return CHOICES.includes(value) ? value : '';
  } catch {
    return '';
  }
}

function rememberChoice(storageKey, choice) {
  try {
    localStorage.setItem(storageKey, choice);
  } catch {
    // Storage is optional: the screen just has no preference next time
  }
}

class StartScreen {
  /**
   * @param {object} options
   * @param {(key: string, values?: object) => string} options.t  the game's words
   * @param {(listener: () => void) => void} [options.onLocaleChange]
   * @param {string} [options.storageKey]  where the last choice is kept
   * @param {() => {connected: boolean, padName: string}} options.gamepad  the gamepad's state
   * @param {(open: boolean) => void} options.onOpenChange
   * @param {{connected: boolean, failed: boolean, offer: {qr?: string, code: string} | null, request: () => void, onChange: (l: () => void) => void}} [options.phone]
   * @param {{state: () => 'on' | 'denied' | 'off', open: () => void, onChange?: (l: () => void) => void}} [options.rooms]
   * @param {(choice: string) => void} options.onChoose  'device', 'gamepad' or 'phone'
   */
  constructor({ t, onLocaleChange = null, storageKey = DEFAULT_KEY, gamepad, phone = null, rooms = null, onOpenChange, onChoose }) {
    this.t = t;
    this.storageKey = storageKey;
    this.gamepad = gamepad;
    this.phone = phone;
    this.rooms = rooms;
    this.onOpenChange = onOpenChange;
    this.onChoose = onChoose;
    this.dialog = document.getElementById('start-screen');
    this.title = document.getElementById('start-title');
    this.back = this.dialog?.querySelector('[data-start-back]');
    this.deviceButton = this.dialog?.querySelector('[data-start-choose="device"]');
    this.padButton = this.dialog?.querySelector('[data-start-choose="gamepad"]');
    this.padStatus = document.getElementById('start-pad-status');
    this.phoneOpen = this.dialog?.querySelector('[data-start-open="phone"]');
    this.phoneButton = this.dialog?.querySelector('[data-start-choose="phone"]');
    this.phoneRetry = this.dialog?.querySelector('[data-start-retry]');
    this.phoneQr = document.getElementById('start-phone-qr');
    this.phoneCode = document.getElementById('start-phone-code');
    this.phoneStatus = document.getElementById('start-phone-status');
    this.togetherButton = this.dialog?.querySelector('[data-start-together]');
    this.togetherStatus = document.getElementById('start-together-status');
    this.view = 'main';
    this.isOpen = false;
    this.padWas = false;
    if (!this.dialog) return;

    this.dialog.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('button') : null;
      if (!target || target.disabled) return;
      if (target.dataset.startOpen) this.show(target.dataset.startOpen);
      else if (target.hasAttribute('data-start-back')) this.goBack();
      else if (target.hasAttribute('data-start-retry')) this.phone?.request();
      else if (target.hasAttribute('data-start-together')) this.openRooms();
      else if (target.dataset.startChoose) this.choose(target.dataset.startChoose);
    });
    // Esc goes back a page; on the first it does nothing, since there is nothing behind this screen to return to
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.goBack();
    });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    onLocaleChange?.(() => this.refresh());
    rooms?.onChange?.(() => this.refresh());
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
    rememberChoice(this.storageKey, choice);
    this.isOpen = false;
    this.dialog.close();
    this.onChoose(choice);
    this.onOpenChange(false);
  }

  /** Play with others: the host draws its rooms for this game over the page; this screen stays behind them. */
  openRooms() {
    if (this.rooms?.state() === 'on') this.rooms.open();
  }

  show(view) {
    if (view !== 'main' && view !== 'phone') return;
    if (view === 'phone') this.phone?.request();
    const from = this.view;
    this.view = view;
    for (const el of this.dialog.querySelectorAll('[data-start-view]')) el.hidden = el.dataset.startView !== view;
    this.back.hidden = view === 'main';
    this.refresh();
    if (!this.isOpen) return;
    if (view === 'main' && from === 'phone') this.phoneOpen?.focus();
    else this.focusFirst();
  }

  items() {
    const page = this.dialog.querySelector(`[data-start-view="${this.view}"]`);
    return [...(this.view === 'main' ? [] : [this.back]), ...page.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden);
  }

  focusFirst() {
    const items = this.items().filter((el) => el !== this.back);
    const remembered = rememberedChoice(this.storageKey);
    const preferred = this.view !== 'main' ? null
      : remembered === 'gamepad' ? this.padButton
      : remembered === 'phone' ? this.phoneOpen
      : this.deviceButton;
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
    if (this.view !== 'main') this.show('main');
  }

  /** Gamepad Start: the pad that pressed it is the controller. */
  close() {
    if (this.phone?.connected) this.choose('phone');
    else if (this.gamepad().connected) this.choose('gamepad');
  }

  /** Redraws what depends on the gamepad, the phone, the rooms or the language. */
  refresh() {
    if (!this.dialog) return;
    const t = this.t;
    this.title.textContent = t(this.view === 'phone' ? 'start.phoneTitle' : 'start.title');
    this.refreshPhone();
    this.refreshTogether();
    const { connected, padName } = this.gamepad();
    this.padButton.disabled = !connected;
    this.padStatus.textContent = connected ? padName || t('start.padReady') : t('start.padWaiting');
    // A pad that turns up takes the focus from this device's choice: pressing its button says which one to play with
    const focus = document.activeElement;
    const arrived = connected && !this.padWas;
    this.padWas = connected;
    if (this.isOpen && this.view === 'main' && arrived && (focus === this.deviceButton || !this.dialog.contains(focus))) this.padButton.focus();
  }

  /** Play with others: hidden where the host has no rooms for this game, off with the reason where it refuses. */
  refreshTogether() {
    if (!this.togetherButton) return;
    const state = this.rooms?.state() ?? 'off';
    this.togetherButton.hidden = state === 'off';
    this.togetherButton.disabled = state !== 'on';
    if (this.togetherStatus) this.togetherStatus.textContent = this.t(state === 'denied' ? 'start.togetherDenied' : 'start.togetherHint');
  }

  /** The phone page: the QR and the code to pair with, and how the pairing stands. */
  refreshPhone() {
    if (!this.phoneButton) return;
    const t = this.t;
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
