import { Component, input, output } from '@angular/core';
import { ApiRepository } from '../../core/models/api.model';

@Component({
  selector: 'app-repo-card',
  standalone: true,
  templateUrl: './repo-card.component.html',
  styleUrl: './repo-card.component.scss',
})
export class RepoCardComponent {
  repo = input.required<ApiRepository>();
  connectionCount = input<number>(0);
  selected = output<void>();

  get displayName(): string {
    return this.repo().name || this.repo().url.split('/').pop()?.replace('.git', '') || 'Unknown';
  }

  get indexingStatus(): string {
    const status = this.repo().indexing_status?.status;
    if (!status) return this.repo().graph_name ? 'Indexed' : 'Not indexed';
    if (status === 'completed') return 'Indexed';
    if (status === 'running' || status === 'queued') return 'Indexing';
    if (status === 'failed') return 'Failed';
    return status;
  }

  get statusClass(): string {
    const s = this.indexingStatus.toLowerCase();
    if (s === 'indexed') return 'rc-status-indexed';
    if (s === 'indexing') return 'rc-status-indexing';
    if (s === 'failed') return 'rc-status-failed';
    return '';
  }

  get lastIndexed(): string | null {
    const date = this.repo().last_indexed_at;
    if (!date) return null;
    return new Date(date).toLocaleDateString();
  }

  onClick(): void {
    this.selected.emit();
  }
}
