import { Component, output, signal, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { ApiService } from '../../core/services/api.service';

@Component({
  selector: 'app-auth-screen',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth-screen.component.html',
  styleUrl: './auth-screen.component.scss',
})
export class AuthScreenComponent {
  private auth = inject(AuthService);
  private api = inject(ApiService);

  server = signal('http://localhost:3000');
  apiKey = signal('');
  error = signal('');
  loading = signal(false);

  authenticated = output<void>();

  async connect(): Promise<void> {
    this.error.set('');
    this.loading.set(true);

    try {
      this.auth.setCredentials(this.server(), this.apiKey());
      const response = await this.api.getProjects().toPromise();
      if (response?.projects?.length) {
        this.auth.setProjectId(response.projects[0].id);
      }
      this.authenticated.emit();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      this.error.set(message);
      this.auth.disconnect();
    } finally {
      this.loading.set(false);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.connect();
    }
  }
}
