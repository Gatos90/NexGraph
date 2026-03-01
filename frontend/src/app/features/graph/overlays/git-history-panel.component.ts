import { Component, inject, signal } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { ApiService } from '../../../core/services/api.service';
import { D3GraphService } from '../../../core/services/d3-graph.service';
import { PixiGraphService } from '../../../core/services/pixi-graph.service';
import { REPO_COLORS } from '../../../core/constants/colors';
import { firstValueFrom } from 'rxjs';
import type { GitHistoryResponse, GitOverlayMode, GitFileInfo, GitAuthor } from '../../../core/models/api.model';

@Component({
  selector: 'app-git-history-panel',
  standalone: true,
  template: `
    @if (visible()) {
      <div class="git-panel">
        <div class="git-panel-header">
          <span>Git History</span>
          <button class="git-panel-close" (click)="close()">×</button>
        </div>

        @if (loading()) {
          <div class="git-loading">Loading git history...</div>
        } @else if (error()) {
          <div class="git-error">{{ error() }}</div>
        } @else if (data()) {
          <div class="git-mode-row">
            @for (m of MODES; track m.value) {
              <button
                class="git-mode-btn"
                [class.active]="state.gitOverlayMode() === m.value"
                (click)="setMode(m.value)"
              >{{ m.label }}</button>
            }
          </div>

          <div class="git-stats-row">
            <span class="git-stat">{{ data()!.total_commits }} commits</span>
            <span class="git-stat">{{ data()!.authors.length }} authors</span>
            <span class="git-stat">{{ data()!.files.length }} files</span>
          </div>

          @if (state.gitOverlayMode() === 'freshness') {
            <div class="git-legend freshness">
              <div class="legend-item"><span class="ldot" style="background:#22c55e"></span> &lt; 7 days</div>
              <div class="legend-item"><span class="ldot" style="background:#eab308"></span> 7–30 days</div>
              <div class="legend-item"><span class="ldot" style="background:#f97316"></span> 30–90 days</div>
              <div class="legend-item"><span class="ldot" style="background:#ef4444"></span> &gt; 90 days</div>
            </div>
          }

          @if (state.gitOverlayMode() === 'hotspots') {
            <div class="git-section">
              <div class="git-section-header">Most Changed Files</div>
              <div class="git-section-list">
                @for (f of topHotspots(); track f.file_path) {
                  <div class="git-file-item">
                    <span class="git-file-name" [title]="f.file_path">{{ fileName(f.file_path) }}</span>
                    <span class="git-file-count">{{ f.commit_count }}×</span>
                  </div>
                }
              </div>
            </div>
          }

          @if (state.gitOverlayMode() === 'authors') {
            <div class="git-section">
              <div class="git-section-header">Authors</div>
              <div class="git-section-list">
                @for (a of data()!.authors; track a.email) {
                  <div class="git-author-item">
                    <span class="author-dot" [style.background]="getAuthorColor(a.email)"></span>
                    <span class="author-name">{{ a.name }}</span>
                    <span class="author-stats">{{ a.file_count }}F · {{ a.commit_count }}C</span>
                  </div>
                }
              </div>
            </div>
          }

          @if (data()!.timeline.length > 0) {
            <div class="git-section">
              <div class="git-section-header">Activity (90d)</div>
              <div class="git-sparkline">
                @for (day of data()!.timeline; track day.date) {
                  <div
                    class="spark-bar"
                    [style.height.px]="sparkHeight(day.commits)"
                    [title]="day.date + ': ' + day.commits + ' commits'"
                  ></div>
                }
              </div>
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
    .git-panel {
      position: absolute;
      top: 52px;
      right: 12px;
      background: var(--surface-bg, #1a1a2e);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 8px;
      max-height: 500px;
      width: 260px;
      display: flex;
      flex-direction: column;
      z-index: 20;
      overflow: hidden;
      font-family: 'JetBrains Mono', monospace;
    }
    .git-panel-header {
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
    .git-panel-close {
      background: none;
      border: none;
      color: var(--text-dim, #888);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
    }
    .git-panel-close:hover { color: var(--text-primary, #eee); }
    .git-mode-row {
      display: flex;
      gap: 3px;
      margin-bottom: 6px;
      padding: 0 2px;
    }
    .git-mode-btn {
      flex: 1;
      background: var(--hover-bg, #ffffff10);
      border: 1px solid var(--border-color, #444);
      border-radius: 4px;
      color: var(--text-secondary, #aaa);
      font-size: 9px;
      font-weight: 500;
      padding: 4px 2px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }
    .git-mode-btn:hover {
      border-color: var(--border-bright, #666);
      color: var(--text-primary, #eee);
    }
    .git-mode-btn.active {
      background: #22c55e20;
      border-color: #22c55e;
      color: #4ade80;
    }
    .git-stats-row {
      display: flex;
      gap: 8px;
      padding: 2px 4px 6px;
      border-bottom: 1px solid var(--border-color, #333);
      margin-bottom: 4px;
    }
    .git-stat {
      font-size: 9px;
      color: var(--text-dim, #888);
    }
    .git-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 4px;
      margin-bottom: 4px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: var(--text-secondary, #aaa);
    }
    .ldot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .git-section {
      border-top: 1px solid var(--border-color, #333);
      margin-top: 4px;
      padding-top: 4px;
    }
    .git-section-header {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim, #888);
      margin-bottom: 3px;
      padding: 0 4px;
    }
    .git-section-list {
      overflow-y: auto;
      max-height: 120px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .git-file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 4px;
      font-size: 9px;
    }
    .git-file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
      flex: 1;
    }
    .git-file-count {
      color: #f97316;
      font-weight: 600;
      flex-shrink: 0;
      margin-left: 4px;
    }
    .git-author-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      font-size: 9px;
    }
    .author-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .author-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
      flex: 1;
    }
    .author-stats {
      color: var(--text-dim, #888);
      font-size: 8px;
      flex-shrink: 0;
    }
    .git-sparkline {
      display: flex;
      align-items: flex-end;
      gap: 1px;
      height: 32px;
      padding: 4px;
    }
    .spark-bar {
      flex: 1;
      min-width: 2px;
      max-width: 4px;
      background: #22c55e;
      border-radius: 1px 1px 0 0;
      opacity: 0.7;
    }
    .git-loading, .git-error {
      padding: 12px;
      text-align: center;
      font-size: 10px;
    }
    .git-loading { color: var(--text-dim, #888); }
    .git-error { color: #f87171; }
  `],
})
export class GitHistoryPanelComponent {
  readonly state = inject(GraphStateService);
  private api = inject(ApiService);
  private d3Graph = inject(D3GraphService);
  private pixiGraph = inject(PixiGraphService);

  readonly visible = signal(false);
  readonly loading = signal(false);
  readonly data = signal<GitHistoryResponse | null>(null);
  readonly error = signal<string | null>(null);

  private authorColorMap = new Map<string, string>();

  readonly MODES: Array<{ value: GitOverlayMode; label: string }> = [
    { value: 'freshness', label: 'Freshness' },
    { value: 'hotspots', label: 'Hotspots' },
    { value: 'authors', label: 'Authors' },
  ];

  async show(): Promise<void> {
    this.visible.set(true);
    if (!this.data()) {
      await this.loadData();
    }
  }

  close(): void {
    this.visible.set(false);
    this.setMode('none');
  }

  private async loadData(): Promise<void> {
    const repoId = this.state.repoId();
    if (!repoId) return;

    this.loading.set(true);
    this.error.set(null);

    try {
      const resp = await firstValueFrom(this.api.getGitHistory(repoId));
      this.data.set(resp);
      this.buildAuthorColors(resp.authors);

      // Auto-activate freshness mode
      this.setMode('freshness');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load git history';
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }

  private buildAuthorColors(authors: GitAuthor[]): void {
    this.authorColorMap.clear();
    authors.forEach((a, i) => {
      this.authorColorMap.set(a.email, REPO_COLORS[i % REPO_COLORS.length]);
    });
  }

  setMode(mode: GitOverlayMode): void {
    const d = this.data();
    if (!d && mode !== 'none') return;

    const renderer = this.state.rendererMode() === 'webgl' ? this.pixiGraph : this.d3Graph;

    if (mode === 'none') {
      this.state.setGitOverlay('none');
      renderer.applyGitOverlay('none', new Map(), new Map());
      return;
    }

    // Build file data map
    const fileMap = new Map<string, GitFileInfo>();
    for (const f of d!.files) {
      fileMap.set(f.file_path, f);
    }

    this.state.setGitOverlay(mode, fileMap, d!.authors, this.authorColorMap);
    renderer.applyGitOverlay(mode, fileMap, this.authorColorMap);
  }

  fileName(path: string): string {
    return path.split('/').pop() || path;
  }

  getAuthorColor(email: string): string {
    return this.authorColorMap.get(email) || '#888';
  }

  topHotspots(): GitFileInfo[] {
    const d = this.data();
    if (!d) return [];
    return [...d.files]
      .sort((a, b) => b.commit_count - a.commit_count)
      .slice(0, 15);
  }

  sparkHeight(commits: number): number {
    const d = this.data();
    if (!d || d.timeline.length === 0) return 0;
    const max = Math.max(...d.timeline.map(t => t.commits));
    if (max === 0) return 0;
    return Math.max(2, Math.round((commits / max) * 28));
  }
}
