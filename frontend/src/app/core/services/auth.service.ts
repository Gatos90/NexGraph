import { Injectable, signal, computed } from '@angular/core';

const STORAGE_KEY_SERVER = 'nexgraph_server';
const STORAGE_KEY_API_KEY = 'nexgraph_api_key';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly server = signal('');
  readonly apiKey = signal('');
  readonly projectId = signal('');
  readonly apiBase = computed(() => this.server() ? `${this.server()}/api/v1` : '');
  readonly isAuthenticated = computed(() => !!this.apiKey() && !!this.server());

  loadFromStorage(): { server: string; apiKey: string } | null {
    const server = localStorage.getItem(STORAGE_KEY_SERVER);
    const apiKey = localStorage.getItem(STORAGE_KEY_API_KEY);
    if (server && apiKey) {
      return { server, apiKey };
    }
    return null;
  }

  loadFromQueryParams(): { server: string; apiKey: string; repoId?: string } | null {
    const params = new URLSearchParams(window.location.search);
    const server = params.get('server');
    const apiKey = params.get('apiKey');
    if (server && apiKey) {
      return { server, apiKey, repoId: params.get('repoId') || undefined };
    }
    return null;
  }

  setCredentials(server: string, apiKey: string): void {
    this.server.set(server.replace(/\/+$/, ''));
    this.apiKey.set(apiKey);
    localStorage.setItem(STORAGE_KEY_SERVER, this.server());
    localStorage.setItem(STORAGE_KEY_API_KEY, apiKey);
  }

  setProjectId(projectId: string): void {
    this.projectId.set(projectId);
  }

  disconnect(): void {
    this.server.set('');
    this.apiKey.set('');
    this.projectId.set('');
    localStorage.removeItem(STORAGE_KEY_SERVER);
    localStorage.removeItem(STORAGE_KEY_API_KEY);
  }

  updateUrlParams(extra: Record<string, string> = {}): void {
    const params = new URLSearchParams();
    if (this.server()) params.set('server', this.server());
    if (this.apiKey()) params.set('apiKey', this.apiKey());
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
    const url = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', url);
  }
}
