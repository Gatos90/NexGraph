import { Component, inject, computed } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { REPO_COLORS } from '../../../core/constants/colors';

@Component({
  selector: 'app-repo-legend',
  standalone: true,
  template: `
    @if (entries().length) {
      <div class="repo-legend">
        @for (entry of entries(); track entry.repoId) {
          <div class="repo-legend-item">
            <span class="repo-legend-dot" [style.background]="entry.color"></span>
            <span class="repo-legend-name">{{ entry.name }}</span>
            <span class="repo-legend-count">{{ entry.nodeCount }}</span>
          </div>
        }
      </div>
    }
  `,
  styleUrl: './repo-legend.component.scss',
})
export class RepoLegendComponent {
  private state = inject(GraphStateService);

  readonly entries = computed(() => {
    const expanded = this.state.expandedRepos();
    if (expanded.size === 0) return [];

    const result: Array<{ repoId: string; name: string; color: string; nodeCount: number }> = [];

    // Current repo
    const localNodes = this.state.allNodes();
    result.push({
      repoId: 'current',
      name: 'Current Repo',
      color: '#ffffff',
      nodeCount: localNodes.length,
    });

    // Expanded repos
    for (const [, data] of expanded) {
      result.push({
        repoId: data.repoId,
        name: data.repoName,
        color: data.color,
        nodeCount: data.nodes.length,
      });
    }

    return result;
  });
}
