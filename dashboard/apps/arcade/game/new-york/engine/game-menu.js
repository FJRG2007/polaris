// The game menu (Esc, the menu button, or Start on a gamepad): resume, graphics, controls, sound, mode and, when the
// framing page can take the reader back to its list of games, exit. The game pauses while it is open (main.js stops
// the simulation and the sound) and the keyboard drives only the menu. It is a modal <dialog>, so focus stays inside
// it and it sits above every popover.
import { t, formatNumber, onLocaleChange } from './i18n.js';
import { exitAvailable, exitGame, onExitAvailability } from './embed.js';

const VIEWS = ['main', 'graphics', 'controls', 'sound', 'mode'];
const FOCUSABLE = 'button:not([hidden]):not(:disabled), input:not(:disabled)';

class GameMenu {
  /**
   * @param {object} options
   * @param {object} options.audio        CityAudioSystem
   * @param {() => string} options.mode   the active mode
   * @param {(mode: string) => Array} options.controls  sections of [keys, label] rows for the Controls page
   * @param {() => string} options.quality  the graphics setting's name, for the main page
   * @param {(open: boolean) => void} options.onOpenChange
   * @param {() => boolean} options.blocked  something else owns Esc right now (the map, a popover)
   */
  constructor({ audio, mode, controls, quality, onOpenChange, blocked }) {
    this.audio = audio;
    this.mode = mode;
    this.controls = controls;
    this.quality = quality;
    this.onOpenChange = onOpenChange;
    this.blocked = blocked;
    this.dialog = document.getElementById('game-menu');
    this.title = document.getElementById('menu-title');
    this.back = this.dialog.querySelector('[data-menu-back]');
    this.exitButton = this.dialog.querySelector('[data-menu-action="exit"]');
    this.soundToggle = document.getElementById('menu-sound-toggle');
    this.volume = document.getElementById('menu-volume');
    this.volumeValue = document.getElementById('menu-volume-value');
    this.view = 'main';
    this.isOpen = false;

    this.dialog.addEventListener('click', (e) => {
      // A click on the backdrop (the dialog element itself, outside the panel) resumes
      if (e.target === this.dialog) return this.close();
      const target = e.target instanceof Element ? e.target.closest('button') : null;
      if (!target) return;
      if (target.dataset.menuOpen) this.show(target.dataset.menuOpen);
      else if (target.hasAttribute('data-menu-back')) this.show('main');
      else if (target.dataset.menuAction === 'resume') this.close();
      else if (target.dataset.menuAction === 'exit') exitGame();
      else if (target.hasAttribute('data-menu-close')) this.close();
    });
    // The browser's own Esc handling would close the dialog without the game knowing why
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    this.soundToggle.addEventListener('click', () => this.audio.setEnabled(!this.audio.enabled));
    this.volume.addEventListener('input', () => this.audio.setVolume(Number(this.volume.value) / 100));
    document.getElementById('btn-menu')?.addEventListener('click', () => this.open());

    // Capture, ahead of every other key handler in the page: while the menu is open no key reaches the game
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    onExitAvailability(() => this.refresh());
    onLocaleChange(() => this.refresh());
    this.refresh();
  }

  onKey(e) {
    if (!this.isOpen) {
      if (e.code !== 'Escape' || e.repeat || this.blocked()) return;
      e.preventDefault();
      this.open();
      return;
    }
    e.stopImmediatePropagation();
    const onRange = e.target instanceof HTMLInputElement && e.target.type === 'range';
    if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      if (onRange) return;
      e.preventDefault();
      this.move(e.code === 'ArrowDown' ? 1 : -1);
    } else if ((e.code === 'ArrowLeft' || e.code === 'Backspace') && !onRange && this.view !== 'main') {
      e.preventDefault();
      this.show('main');
    }
  }

  open() {
    if (this.isOpen || this.blocked()) return;
    this.isOpen = true;
    this.show('main');
    this.dialog.showModal();
    this.focusFirst();
    this.onOpenChange(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dialog.close();
    this.onOpenChange(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Shows one page of the menu, with the way back on every page but the first. */
  show(view) {
    if (!VIEWS.includes(view)) return;
    const from = this.view;
    this.view = view;
    for (const el of this.dialog.querySelectorAll('[data-view]')) el.hidden = el.dataset.view !== view;
    this.back.hidden = view === 'main';
    this.refresh();
    if (!this.isOpen) return;
    if (view === 'main' && from !== 'main') this.dialog.querySelector(`[data-menu-open="${from}"]`)?.focus();
    else this.focusFirst();
  }

  items() {
    const page = this.dialog.querySelector(`[data-view="${this.view}"]`);
    return [...(this.view === 'main' ? [] : [this.back]), ...page.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden);
  }

  focusFirst() {
    const items = this.items();
    (items.find((el) => el !== this.back && el.classList.contains('active')) || items.find((el) => el !== this.back) || items[0])?.focus();
  }

  /** Moves the focus to the next (1) or previous (-1) item of the page, wrapping around. */
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

  /** Gamepad left and right: the volume, when it has the focus. */
  adjust(step) {
    if (document.activeElement !== this.volume) return;
    this.volume.value = String(Math.max(0, Math.min(100, Number(this.volume.value) + step * 10)));
    this.audio.setVolume(Number(this.volume.value) / 100);
  }

  /** Gamepad B: one page back, or resume from the first. */
  goBack() {
    if (this.view === 'main') this.close();
    else this.show('main');
  }

  /** Redraws what depends on the game's state or the language. */
  refresh() {
    this.title.textContent = t(this.view === 'main' ? 'menu.title' : `menu.${this.view}`);
    this.exitButton.hidden = !exitAvailable();
    const audio = this.audio;
    const value = (name, text) => {
      const el = this.dialog.querySelector(`[data-menu-value="${name}"]`);
      if (el) el.textContent = text;
    };
    value('graphics', this.quality());
    value('sound', !audio.supported ? '' : audio.enabled ? formatNumber(audio.volume, { style: 'percent' }) : t('menu.off'));
    value('mode', t(`modes.${this.mode()}`));
    this.soundToggle.setAttribute('aria-checked', String(audio.enabled));
    this.soundToggle.disabled = !audio.supported;
    this.volume.disabled = !audio.supported || !audio.enabled;
    this.volume.value = String(Math.round(audio.volume * 100));
    this.volume.setAttribute('aria-valuetext', formatNumber(audio.volume, { style: 'percent' }));
    this.volumeValue.textContent = formatNumber(audio.volume, { style: 'percent' });
    document.getElementById('menu-sound-unavailable').hidden = audio.supported;
    if (this.view === 'controls') this.drawControls();
  }

  drawControls() {
    const root = document.getElementById('menu-controls');
    const sections = this.controls(this.mode()).map(({ title, rows }) => {
      const section = document.createElement('section');
      section.className = 'menu-keys';
      const heading = document.createElement('h3');
      heading.textContent = title;
      const list = document.createElement('dl');
      for (const [keys, label] of rows) {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        for (const key of keys) {
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          term.appendChild(kbd);
        }
        const what = document.createElement('dd');
        what.textContent = label;
        row.append(term, what);
        list.appendChild(row);
      }
      section.append(heading, list);
      return section;
    });
    root.replaceChildren(...sections);
  }
}

export { GameMenu };
