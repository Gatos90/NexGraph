import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-tooltip',
  standalone: true,
  template: `
    @if (visible()) {
      <div
        class="tooltip"
        [style.left.px]="x()"
        [style.top.px]="y()"
      >
        {{ text() }}
      </div>
    }
  `,
  styleUrl: './tooltip.component.scss',
})
export class TooltipComponent {
  readonly visible = signal(false);
  readonly text = signal('');
  readonly x = signal(0);
  readonly y = signal(0);

  show(text: string, x: number, y: number): void {
    this.text.set(text);
    this.x.set(x + 12);
    this.y.set(y - 10);
    this.visible.set(true);
  }

  hide(): void {
    this.visible.set(false);
  }
}
