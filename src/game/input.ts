import type { Controls } from './simulation';
import type { Point } from './world';

const handled = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyE', 'KeyQ', 'KeyF']);
export class Input {
  enabled = false;
  careful = false;
  private keys = new Set<string>();
  private actions = { dash: false, interact: false, pulse: false, home: false };
  private joystick: Point = { x: 0, y: 0 };
  private pointerId: number | null = null;
  private touchBoost = false;
  private resetJoystick = (): void => {};
  onMap = (): void => {};
  onPause = (): void => {};

  constructor(joystick: HTMLElement, boost: HTMLButtonElement, action: HTMLButtonElement, scan: HTMLButtonElement) {
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) this.onPause(); return; }
      if (e.code === 'KeyM') { e.preventDefault(); if (!e.repeat) this.onMap(); return; }
      if (!this.enabled) return;
      if (handled.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'Space') this.actions.dash = true;
      if (e.code === 'KeyE' || e.code === 'KeyF') this.actions.interact = true;
      if (e.code === 'KeyQ') this.actions.pulse = true;
      if (e.code === 'KeyB') { e.preventDefault(); this.actions.home = true; }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    const knob = joystick.querySelector<HTMLElement>('.stick-knob')!;
    this.resetJoystick = () => { this.pointerId = null; knob.style.transform = 'translate(0,0)'; };
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return;
      const rect = joystick.getBoundingClientRect(), x = (e.clientX - rect.left - rect.width / 2) / 30, y = (e.clientY - rect.top - rect.height / 2) / 30;
      const length = Math.max(1, Math.hypot(x, y)); this.joystick = { x: x / length, y: y / length };
      knob.style.transform = `translate(${this.joystick.x * 25}px,${this.joystick.y * 25}px)`;
    };
    joystick.addEventListener('pointerdown', e => {
      if (!this.enabled || this.pointerId !== null) return;
      e.preventDefault(); this.pointerId = e.pointerId; joystick.setPointerCapture(e.pointerId); move(e);
    });
    joystick.addEventListener('pointermove', move);
    const release = (e: PointerEvent): void => { if (e.pointerId === this.pointerId) { this.joystick = { x: 0, y: 0 }; this.resetJoystick(); } };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) joystick.addEventListener(name, release);
    boost.addEventListener('pointerdown', e => {
      if (!this.enabled) return; e.preventDefault(); boost.setPointerCapture(e.pointerId); this.touchBoost = true; this.actions.dash = true;
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) boost.addEventListener(name, () => { this.touchBoost = false; });
    action.addEventListener('click', () => { if (this.enabled) this.actions.interact = true; });
    scan.addEventListener('click', () => { if (this.enabled) this.actions.pulse = true; });
  }

  read(): Controls {
    if (!this.enabled) return { x: 0, y: 0, boost: false, brake: false, dash: false, interact: false, pulse: false };
    const x = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) + this.joystick.x;
    const y = (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) + this.joystick.y;
    const boost = this.keys.has('Space') || this.touchBoost;
    const controls = { x, y, boost, brake: this.careful && !boost || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'), ...this.actions };
    this.actions = { dash: false, interact: false, pulse: false, home: false }; return controls;
  }

  clear(): void {
    this.keys.clear(); this.joystick = { x: 0, y: 0 }; this.touchBoost = false;
    this.actions = { dash: false, interact: false, pulse: false, home: false }; this.resetJoystick();
  }
}
