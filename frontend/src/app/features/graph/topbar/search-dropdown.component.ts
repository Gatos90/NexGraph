import { Component, input, output, inject, signal, ElementRef, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/services/api.service';
import { SearchResult, SearchMode } from '../../../core/models/api.model';

@Component({
  selector: 'app-search-dropdown',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './search-dropdown.component.html',
  styleUrl: './search-dropdown.component.scss',
})
export class SearchDropdownComponent {
  readonly repoId = input.required<string>();
  readonly navigate = output<string>();

  private api = inject(ApiService);
  private elRef = inject(ElementRef);
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly query = signal('');
  readonly results = signal<SearchResult[]>([]);
  readonly showResults = signal(false);
  readonly searchMode = signal<SearchMode>('keyword');
  readonly responseMode = signal<SearchMode>('keyword');

  readonly modes: SearchMode[] = ['keyword', 'semantic', 'hybrid'];
  readonly modeLabels: Record<SearchMode, string> = {
    keyword: 'Text',
    semantic: 'Semantic',
    hybrid: 'Hybrid',
  };

  setMode(mode: SearchMode): void {
    this.searchMode.set(mode);
    const q = this.query();
    if (q.trim()) {
      this.search(q);
    }
  }

  onInput(value: string): void {
    this.query.set(value);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!value.trim()) {
      this.results.set([]);
      this.showResults.set(false);
      return;
    }
    this.debounceTimer = setTimeout(() => this.search(value), 300);
  }

  private search(q: string): void {
    this.api.postSearch(this.repoId(), q, 12, this.searchMode()).subscribe({
      next: resp => {
        this.results.set(resp.results || []);
        this.responseMode.set(resp.mode || this.searchMode());
        this.showResults.set(true);
      },
      error: () => {
        this.results.set([]);
        this.showResults.set(false);
      },
    });
  }

  selectResult(result: SearchResult): void {
    this.navigate.emit(result.file_path);
    this.showResults.set(false);
    this.query.set('');
    this.results.set([]);
  }

  getBadge(result: SearchResult): string | null {
    const mode = this.responseMode();
    if (mode === 'semantic' && result.similarity != null) {
      return `${Math.round(result.similarity * 100)}%`;
    }
    if (mode === 'hybrid' && result.rrf_rank != null) {
      return `#${result.rrf_rank}`;
    }
    return null;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elRef.nativeElement.contains(event.target)) {
      this.showResults.set(false);
    }
  }
}
