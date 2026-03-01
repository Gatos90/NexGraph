import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { ApiService } from '../../../core/services/api.service';
import { firstValueFrom } from 'rxjs';
import type { DiffImpactResponse, DiffScope, RiskLevel } from '../../../core/models/api.model';

@Component({
  selector: 'app-diff-impact-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (visible()) {
      <div class="diff-panel">
        <div class="diff-panel-header">
          <span>Diff Impact</span>
          <button class="diff-panel-close" (click)="close()">×</button>
        </div>

        <div class="diff-controls">
          <select class="diff-scope-select" [(ngModel)]="scope" (ngModelChange)="onScopeChange()">
            <option value="all">All (HEAD)</option>
            <option value="unstaged">Unstaged</option>
            <option value="staged">Staged</option>
            <option value="compare">Compare</option>
          </select>
          @if (scope === 'compare') {
            <input
              class="diff-ref-input"
              type="text"
              placeholder="e.g. main, v1.0"
              [(ngModel)]="compareRef"
            />
          }
          <button class="diff-analyze-btn" [disabled]="loading()" (click)="analyze()">
            {{ loading() ? 'Analyzing...' : 'Analyze' }}
          </button>
        </div>

        @if (result()) {
          <div class="diff-risk-badge" [class]="'risk-' + result()!.risk.toLowerCase()">
            {{ result()!.risk }}
          </div>
          <div class="diff-summary">{{ result()!.summary }}</div>

          <div class="diff-section">
            <div class="diff-section-header">Changed Files ({{ result()!.changed_files.length }})</div>
            <div class="diff-section-list">
              @for (file of result()!.changed_files; track file.filePath) {
                <div class="diff-file-item">
                  <span class="diff-file-name">{{ file.filePath }}</span>
                  <span class="diff-file-counts">
                    <span class="diff-add">+{{ file.additions }}</span>
                    <span class="diff-del">-{{ file.deletions }}</span>
                  </span>
                </div>
              }
            </div>
          </div>

          <div class="diff-section">
            <div class="diff-section-header">
              <span class="diff-dot direct"></span>
              Direct Symbols ({{ result()!.direct_symbols.length }})
            </div>
            <div class="diff-section-list">
              @for (sym of result()!.direct_symbols; track sym.id) {
                <div class="diff-symbol-item">
                  <span class="diff-sym-label">{{ sym.label }}</span>
                  <span class="diff-sym-name">{{ sym.name }}</span>
                </div>
              }
            </div>
          </div>

          <div class="diff-section">
            <div class="diff-section-header">
              <span class="diff-dot impacted"></span>
              Impacted Symbols ({{ result()!.impacted_symbols.length }})
            </div>
            <div class="diff-section-list">
              @for (sym of result()!.impacted_symbols; track sym.id) {
                <div class="diff-symbol-item">
                  <span class="diff-sym-label">{{ sym.label }}</span>
                  <span class="diff-sym-name">{{ sym.name }}</span>
                </div>
              }
            </div>
          </div>

          @if (result()!.affected_processes.length > 0) {
            <div class="diff-section">
              <div class="diff-section-header">Affected Processes ({{ result()!.affected_processes.length }})</div>
              <div class="diff-section-list">
                @for (proc of result()!.affected_processes; track proc.processId) {
                  <div class="diff-process-item">
                    <span class="diff-proc-type">{{ proc.processType === 'cross_community' ? 'CROSS' : 'INTRA' }}</span>
                    <span class="diff-proc-label">{{ proc.label }}</span>
                  </div>
                }
              </div>
            </div>
          }
        }

        @if (error()) {
          <div class="diff-error">{{ error() }}</div>
        }
      </div>
    }
  `,
  styles: [`
    .diff-panel {
      position: absolute;
      top: 52px;
      right: 12px;
      background: var(--surface-bg, #1a1a2e);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 8px;
      max-height: 500px;
      width: 280px;
      display: flex;
      flex-direction: column;
      z-index: 20;
      overflow: hidden;
      font-family: 'JetBrains Mono', monospace;
    }
    .diff-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim, #888);
      margin-bottom: 6px;
      padding: 0 4px;
    }
    .diff-panel-close {
      background: none;
      border: none;
      color: var(--text-dim, #888);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
    }
    .diff-panel-close:hover {
      color: var(--text-primary, #eee);
    }
    .diff-controls {
      display: flex;
      gap: 4px;
      margin-bottom: 6px;
      padding: 0 2px;
    }
    .diff-scope-select {
      background: var(--hover-bg, #ffffff10);
      border: 1px solid var(--border-color, #444);
      border-radius: 4px;
      color: var(--text-primary, #eee);
      font-size: 10px;
      padding: 3px 4px;
      flex: 1;
      font-family: inherit;
    }
    .diff-ref-input {
      background: var(--hover-bg, #ffffff10);
      border: 1px solid var(--border-color, #444);
      border-radius: 4px;
      color: var(--text-primary, #eee);
      font-size: 10px;
      padding: 3px 4px;
      width: 70px;
      font-family: inherit;
    }
    .diff-analyze-btn {
      background: #3b82f640;
      border: 1px solid #3b82f6;
      border-radius: 4px;
      color: #93c5fd;
      font-size: 9px;
      font-weight: 600;
      padding: 3px 8px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .diff-analyze-btn:hover:not(:disabled) {
      background: #3b82f660;
    }
    .diff-analyze-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .diff-risk-badge {
      text-align: center;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      margin: 2px 4px 4px;
    }
    .risk-low {
      background: #22c55e30;
      color: #4ade80;
    }
    .risk-medium {
      background: #eab30830;
      color: #fbbf24;
    }
    .risk-high {
      background: #f9731630;
      color: #fb923c;
    }
    .risk-critical {
      background: #ef444430;
      color: #f87171;
    }
    .diff-summary {
      font-size: 9px;
      color: var(--text-dim, #888);
      padding: 0 4px 4px;
      text-align: center;
    }
    .diff-section {
      border-top: 1px solid var(--border-color, #333);
      margin-top: 4px;
      padding-top: 4px;
    }
    .diff-section-header {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim, #888);
      margin-bottom: 3px;
      padding: 0 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .diff-section-list {
      overflow-y: auto;
      max-height: 80px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .diff-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .diff-dot.direct {
      background: #ef4444;
    }
    .diff-dot.impacted {
      background: #f97316;
    }
    .diff-file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 4px;
      font-size: 9px;
    }
    .diff-file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
      flex: 1;
    }
    .diff-file-counts {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
      margin-left: 4px;
    }
    .diff-add {
      color: #4ade80;
      font-size: 9px;
    }
    .diff-del {
      color: #f87171;
      font-size: 9px;
    }
    .diff-symbol-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
      font-size: 9px;
    }
    .diff-sym-label {
      font-size: 8px;
      color: var(--text-dim, #888);
      flex-shrink: 0;
    }
    .diff-sym-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
    }
    .diff-process-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
      font-size: 9px;
    }
    .diff-proc-type {
      font-size: 8px;
      font-weight: 700;
      padding: 1px 3px;
      border-radius: 3px;
      background: #34d39930;
      color: #34d399;
      flex-shrink: 0;
    }
    .diff-proc-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
    }
    .diff-error {
      padding: 8px;
      text-align: center;
      font-size: 10px;
      color: #f87171;
    }
  `],
})
export class DiffImpactPanelComponent {
  readonly state = inject(GraphStateService);
  private api = inject(ApiService);

  readonly visible = signal(false);
  readonly loading = signal(false);
  readonly result = signal<DiffImpactResponse | null>(null);
  readonly error = signal<string | null>(null);

  scope: DiffScope = 'all';
  compareRef = '';

  show(): void {
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
    this.state.setDiffImpact(false);
    this.result.set(null);
    this.error.set(null);
  }

  onScopeChange(): void {
    // Clear results when scope changes
    this.result.set(null);
    this.error.set(null);
    this.state.setDiffImpact(false);
  }

  async analyze(): Promise<void> {
    const repoId = this.state.repoId();
    if (!repoId) return;

    this.loading.set(true);
    this.error.set(null);

    try {
      const ref = this.scope === 'compare' ? this.compareRef : undefined;
      const resp = await firstValueFrom(
        this.api.postDiffImpact(repoId, this.scope, ref, 3)
      );

      this.result.set(resp);

      // Build ID sets for graph highlighting
      const directIds = new Set<string | number>(resp.direct_symbols.map(s => s.id));
      const impactedIds = new Set<string | number>(resp.impacted_symbols.map(s => s.id));
      this.state.setDiffImpact(true, directIds, impactedIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      this.error.set(message);
      this.state.setDiffImpact(false);
    } finally {
      this.loading.set(false);
    }
  }
}
