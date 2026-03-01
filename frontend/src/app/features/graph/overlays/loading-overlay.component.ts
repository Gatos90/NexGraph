import { Component, input } from '@angular/core';

@Component({
  selector: 'app-loading-overlay',
  standalone: true,
  template: `
    @if (visible()) {
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <div class="loading-text">{{ message() }}</div>
      </div>
    }
  `,
  styleUrl: './loading-overlay.component.scss',
})
export class LoadingOverlayComponent {
  readonly visible = input(false);
  readonly message = input('Loading graph data...');
}
