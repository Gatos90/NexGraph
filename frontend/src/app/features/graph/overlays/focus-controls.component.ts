import { Component, inject } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { D3GraphService } from '../../../core/services/d3-graph.service';
import { PixiGraphService } from '../../../core/services/pixi-graph.service';

@Component({
  selector: 'app-focus-controls',
  standalone: true,
  template: `
    @if (state.focusMode()) {
      <div class="focus-controls">
        <span class="focus-label">Depth</span>
        @for (d of depths; track d) {
          <button
            class="focus-depth-btn"
            [class.active]="state.focusDepth() === d"
            (click)="onSetDepth(d)"
          >
            {{ d }}
          </button>
        }
        <button class="focus-exit-btn" (click)="state.exitFocusMode()">&#x2715; Exit</button>
      </div>
    }
  `,
  styleUrl: './focus-controls.component.scss',
})
export class FocusControlsComponent {
  readonly state = inject(GraphStateService);
  private d3Graph = inject(D3GraphService);
  private pixiGraph = inject(PixiGraphService);
  readonly depths = [1, 2, 3];

  onSetDepth(depth: number): void {
    const renderer = this.state.rendererMode() === 'webgl' ? this.pixiGraph : this.d3Graph;
    const compEdges = this.state.layoutMode() === 'components'
      ? renderer.getRenderedEdgeData() : undefined;
    this.state.setFocusDepth(depth, compEdges);
  }
}
