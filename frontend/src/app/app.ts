import { Component, signal, inject, OnInit } from '@angular/core';
import { AuthScreenComponent } from './features/auth/auth-screen.component';
import { RepoSelectorComponent } from './features/repo-selector/repo-selector.component';
import { GraphShellComponent } from './features/graph/graph-shell.component';
import { AuthService } from './core/services/auth.service';
import { ApiService } from './core/services/api.service';
import { ApiRepository } from './core/models/api.model';

export type Screen = 'auth' | 'repo-selector' | 'graph';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [AuthScreenComponent, RepoSelectorComponent, GraphShellComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private auth = inject(AuthService);
  private api = inject(ApiService);

  currentScreen = signal<Screen>('auth');
  selectedRepo = signal<ApiRepository | null>(null);

  ngOnInit(): void {
    this.tryAutoConnect();
  }

  private async tryAutoConnect(): Promise<void> {
    const fromParams = this.auth.loadFromQueryParams();
    const fromStorage = this.auth.loadFromStorage();
    const creds = fromParams || fromStorage;

    if (!creds) return;

    try {
      this.auth.setCredentials(creds.server, creds.apiKey);
      const response = await this.api.getProjects().toPromise();
      if (response?.projects?.length) {
        this.auth.setProjectId(response.projects[0].id);
      }

      const repoId = (creds as { repoId?: string }).repoId;
      if (repoId) {
        const repoResp = await this.api.getRepository(repoId).toPromise();
        if (repoResp) {
          this.selectedRepo.set(repoResp);
          this.currentScreen.set('graph');
          return;
        }
      }

      this.currentScreen.set('repo-selector');
    } catch {
      this.auth.disconnect();
    }
  }

  onAuthenticated(): void {
    this.currentScreen.set('repo-selector');
  }

  onRepoSelected(repo: ApiRepository): void {
    this.selectedRepo.set(repo);
    this.auth.updateUrlParams({ repoId: repo.id });
    this.currentScreen.set('graph');
  }

  onBackToRepos(): void {
    this.selectedRepo.set(null);
    this.currentScreen.set('repo-selector');
  }

  onDisconnect(): void {
    this.auth.disconnect();
    this.selectedRepo.set(null);
    this.currentScreen.set('auth');
  }
}
