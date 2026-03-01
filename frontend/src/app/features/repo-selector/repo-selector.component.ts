import { Component, output, inject, OnInit, signal } from '@angular/core';
import { ApiRepository } from '../../core/models/api.model';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { RepoCardComponent } from './repo-card.component';

@Component({
  selector: 'app-repo-selector',
  standalone: true,
  imports: [RepoCardComponent],
  templateUrl: './repo-selector.component.html',
  styleUrl: './repo-selector.component.scss',
})
export class RepoSelectorComponent implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  repos = signal<ApiRepository[]>([]);
  connectionCounts = signal<Record<string, number>>({});
  loading = signal(true);

  repoSelected = output<ApiRepository>();
  disconnect = output<void>();

  ngOnInit(): void {
    this.loadRepos();
  }

  private async loadRepos(): Promise<void> {
    this.loading.set(true);
    try {
      const resp = await this.api.getRepositories().toPromise();
      this.repos.set(resp?.repositories ?? []);

      // Load cross-repo connection counts
      const projectId = this.auth.projectId();
      if (projectId) {
        try {
          const connResp = await this.api.getConnections(projectId).toPromise();
          const counts: Record<string, number> = {};
          for (const conn of connResp?.connections ?? []) {
            counts[conn.source_repo_id] = (counts[conn.source_repo_id] || 0) + 1;
            counts[conn.target_repo_id] = (counts[conn.target_repo_id] || 0) + 1;
          }
          this.connectionCounts.set(counts);
        } catch {
          // Cross-repo connections are optional
        }
      }
    } catch {
      this.repos.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  onSelectRepo(repo: ApiRepository): void {
    this.repoSelected.emit(repo);
  }

  onDisconnect(): void {
    this.disconnect.emit();
  }
}
