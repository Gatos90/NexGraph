import { Component, input, output, inject, signal, effect, HostListener, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiRepository } from '../../../core/models/api.model';
import { GraphStats } from '../../../core/models/graph.model';
import { NODE_COLORS } from '../../../core/constants/colors';
import { ScreensaverService, ScreensaverMode } from '../../../core/services/screensaver.service';
import { IdleService } from '../../../core/services/idle.service';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { SearchDropdownComponent } from './search-dropdown.component';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [SearchDropdownComponent, FormsModule],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent {
  readonly repo = input.required<ApiRepository>();
  readonly stats = input<GraphStats | null>(null);
  readonly backToRepos = output<void>();
  readonly disconnect = output<void>();
  readonly searchNavigate = output<string>();

  readonly NODE_COLORS = NODE_COLORS;
  private elRef = inject(ElementRef);
  readonly screensaver = inject(ScreensaverService);
  readonly idle = inject(IdleService);
  readonly graphState = inject(GraphStateService);

  readonly ssMenuOpen = signal(false);

  constructor() {
    // Auto-close dropdown when screensaver starts (e.g. via idle timeout)
    effect(() => {
      if (this.screensaver.active()) {
        this.ssMenuOpen.set(false);
      }
    });
  }

  readonly SS_MODES: Array<{ value: ScreensaverMode | 'auto'; label: string }> = [
    { value: 'auto', label: 'Auto Rotate' },
    { value: 'walk', label: 'Random Walk' },
    { value: 'edgeFlow', label: 'Edge Flow' },
    { value: 'typeParade', label: 'Type Parade' },
    { value: 'breathing', label: 'Breathing' },
    { value: 'gitGrowth', label: 'Git Growth' },
  ];

  readonly IDLE_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 30_000, label: '30s' },
    { value: 60_000, label: '60s' },
    { value: 120_000, label: '2m' },
    { value: 0, label: 'Off' },
  ];

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.elRef.nativeElement.contains(event.target)) {
      this.ssMenuOpen.set(false);
    }
  }

  get repoDisplayName(): string {
    const r = this.repo();
    return r.name || r.url?.split('/').pop() || r.id;
  }

  get statPills(): Array<{ label: string; value: number; color: string }> {
    const s = this.stats();
    if (!s) return [];
    const pills: Array<{ label: string; value: number; color: string }> = [];
    if (s.nodes['File']) pills.push({ label: 'Files', value: s.nodes['File'], color: NODE_COLORS['File'].fill });
    if (s.nodes['Function']) pills.push({ label: 'Functions', value: s.nodes['Function'], color: NODE_COLORS['Function'].fill });
    if (s.nodes['Class']) pills.push({ label: 'Classes', value: s.nodes['Class'], color: NODE_COLORS['Class'].fill });
    if (s.nodes['Interface']) pills.push({ label: 'Interfaces', value: s.nodes['Interface'], color: NODE_COLORS['Interface'].fill });
    if (s.nodes['RouteHandler']) pills.push({ label: 'Routes', value: s.nodes['RouteHandler'], color: NODE_COLORS['RouteHandler'].fill });
    pills.push({ label: 'Edges', value: s.total_edges, color: '#666' });
    return pills;
  }

  toggleSsMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.ssMenuOpen.set(!this.ssMenuOpen());
  }

  startScreensaver(): void {
    this.idle.forceIdle();
    this.ssMenuOpen.set(false);
  }

  selectMode(mode: ScreensaverMode | 'auto'): void {
    this.screensaver.selectedMode.set(mode);
  }

  selectIdleTimeout(ms: number): void {
    this.idle.timeout.set(ms);
  }

  toggleRenderer(): void {
    const current = this.graphState.rendererMode();
    this.graphState.rendererMode.set(current === 'webgl' ? 'svg' : 'webgl');
  }
}
