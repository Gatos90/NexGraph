import { Component, inject } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { FOCUS_COLORS } from '../../../core/constants/colors';

@Component({
  selector: 'app-focus-legend',
  standalone: true,
  template: `
    @if (state.focusMode()) {
      <div class="focus-legend">
        <div class="legend-item">
          <span class="legend-line" [style.background]="FOCUS_COLORS.outgoing"></span>
          <span class="legend-arrow">&#x2192;</span>
          <span class="legend-text">Calls / Depends on</span>
        </div>
        <div class="legend-item">
          <span class="legend-line" [style.background]="FOCUS_COLORS.incoming"></span>
          <span class="legend-arrow">&#x2190;</span>
          <span class="legend-text">Called by / Used by</span>
        </div>
      </div>
    }
  `,
  styleUrl: './focus-legend.component.scss',
})
export class FocusLegendComponent {
  readonly state = inject(GraphStateService);
  readonly FOCUS_COLORS = FOCUS_COLORS;
}
