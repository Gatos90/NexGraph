import { Component, output } from '@angular/core';

@Component({
  selector: 'app-zoom-controls',
  standalone: true,
  template: `
    <div class="zoom-controls">
      <button class="zoom-btn" (click)="zoomIn.emit()">+</button>
      <button class="zoom-btn" (click)="zoomOut.emit()">&minus;</button>
      <button class="zoom-btn" (click)="fitGraph.emit()">&#x2B1A;</button>
    </div>
  `,
  styleUrl: './zoom-controls.component.scss',
})
export class ZoomControlsComponent {
  readonly zoomIn = output<void>();
  readonly zoomOut = output<void>();
  readonly fitGraph = output<void>();
}
