import { Component, inject, computed } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';

interface CommunityEntry {
  communityId: string;
  color: string;
  memberCount: number;
}

@Component({
  selector: 'app-community-legend',
  standalone: true,
  template: `
    @if (state.communityOverlay() && entries().length) {
      <div class="community-legend">
        <div class="community-legend-header">Communities</div>
        <div class="community-legend-list">
          @for (entry of entries(); track entry.communityId) {
            <button
              class="community-legend-item"
              [class.active]="state.activeCommunityId() === entry.communityId"
              (click)="toggleCommunity(entry.communityId)"
            >
              <span class="community-swatch" [style.background]="entry.color"></span>
              <span class="community-label">{{ entry.communityId.replace('community_', '#') }}</span>
              <span class="community-count">{{ entry.memberCount }}</span>
            </button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .community-legend {
      position: absolute;
      top: 52px;
      right: 12px;
      background: var(--surface-bg, #1a1a2e);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 8px;
      max-height: 320px;
      width: 180px;
      display: flex;
      flex-direction: column;
      z-index: 20;
    }
    .community-legend-header {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim, #888);
      margin-bottom: 6px;
      padding: 0 4px;
    }
    .community-legend-list {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .community-legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border: none;
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-primary, #eee);
      transition: background 0.15s;
    }
    .community-legend-item:hover {
      background: var(--hover-bg, #ffffff10);
    }
    .community-legend-item.active {
      background: var(--hover-bg, #ffffff18);
    }
    .community-swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .community-label {
      flex: 1;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .community-count {
      font-size: 9px;
      color: var(--text-dim, #888);
    }
  `],
})
export class CommunityLegendComponent {
  readonly state = inject(GraphStateService);

  readonly entries = computed<CommunityEntry[]>(() => {
    const colors = this.state.communityColors();
    const communityMap = this.state.communityMap();
    if (colors.size === 0) return [];

    // Count members per community
    const counts = new Map<string, number>();
    for (const communityId of communityMap.values()) {
      counts.set(communityId, (counts.get(communityId) ?? 0) + 1);
    }

    return [...colors.entries()]
      .map(([communityId, color]) => ({
        communityId,
        color,
        memberCount: counts.get(communityId) ?? 0,
      }))
      .sort((a, b) => b.memberCount - a.memberCount);
  });

  toggleCommunity(communityId: string): void {
    if (this.state.activeCommunityId() === communityId) {
      this.state.setActiveCommunityId(null);
    } else {
      this.state.setActiveCommunityId(communityId);
    }
  }
}
