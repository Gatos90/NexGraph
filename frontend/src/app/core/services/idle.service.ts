import { Injectable, signal, NgZone, inject } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class IdleService {
  private zone = inject(NgZone);

  readonly isIdle = signal(false);
  readonly timeout = signal(60_000); // configurable: 0 = disabled

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private rafPending = false;

  private readonly EVENTS: (keyof DocumentEventMap)[] = [
    'mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel',
  ];

  private readonly onActivity = () => {
    // Throttle mousemove via rAF flag (other events fire infrequently)
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.resetTimer();
    });
  };

  private readonly onVisibility = () => {
    if (document.hidden) {
      this.clearTimer();
    } else {
      this.resetTimer();
    }
  };

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;

    this.zone.runOutsideAngular(() => {
      for (const evt of this.EVENTS) {
        document.addEventListener(evt, this.onActivity, { passive: true });
      }
      document.addEventListener('visibilitychange', this.onVisibility);
      this.resetTimer();
    });
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearTimer();

    for (const evt of this.EVENTS) {
      document.removeEventListener(evt, this.onActivity);
    }
    document.removeEventListener('visibilitychange', this.onVisibility);

    this.isIdle.set(false);
  }

  /** Manually trigger idle (for the play button) */
  forceIdle(): void {
    this.clearTimer();
    if (!this.isIdle()) {
      this.zone.run(() => this.isIdle.set(true));
    }
  }

  private resetTimer(): void {
    this.clearTimer();

    if (this.isIdle()) {
      this.zone.run(() => this.isIdle.set(false));
    }

    const ms = this.timeout();
    if (ms <= 0) return; // disabled

    this.timerId = setTimeout(() => {
      this.zone.run(() => this.isIdle.set(true));
    }, ms);
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
