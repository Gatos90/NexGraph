import { Component, inject, output, signal, ElementRef, HostListener } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { ALL_NODE_TYPES, ALL_EDGE_TYPES } from '../../../core/constants/types';
import { NODE_COLORS, EDGE_COLORS, REPO_COLORS } from '../../../core/constants/colors';
import { LayoutMode, NodeType, EdgeType } from '../../../core/models/graph.model';
import { ConnectedRepo } from '../../../core/models/cross-repo.model';

@Component({
  selector: 'app-filter-bar',
  standalone: true,
  templateUrl: './filter-bar.component.html',
  styleUrl: './filter-bar.component.scss',
})
export class FilterBarComponent {
  readonly state = inject(GraphStateService);
  private elRef = inject(ElementRef);

  readonly expandRepo = output<ConnectedRepo>();
  readonly collapseRepo = output<string>();
  readonly expandAllRepos = output<void>();
  readonly collapseAllRepos = output<void>();

  readonly NODE_TYPES = ALL_NODE_TYPES;
  readonly EDGE_TYPES = ALL_EDGE_TYPES;
  readonly NODE_COLORS = NODE_COLORS;
  readonly EDGE_COLORS = EDGE_COLORS;
  readonly REPO_COLORS = REPO_COLORS;
  readonly LAYOUT_MODES: LayoutMode[] = ['force', 'flow', 'components'];

  readonly openDropdown = signal<'nodes' | 'edges' | null>(null);

  toggleDropdown(which: 'nodes' | 'edges'): void {
    this.openDropdown.set(this.openDropdown() === which ? null : which);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.elRef.nativeElement.contains(event.target)) {
      this.openDropdown.set(null);
    }
  }

  get activeNodeCount(): number {
    return this.state.activeNodeFilters().size;
  }

  get activeEdgeCount(): number {
    return this.state.activeEdgeFilters().size;
  }

  isNodeActive(type: string): boolean {
    return this.state.activeNodeFilters().has(type);
  }

  isEdgeActive(type: string): boolean {
    return this.state.activeEdgeFilters().has(type);
  }

  toggleNode(type: NodeType): void {
    this.state.toggleNodeFilter(type);
  }

  toggleEdge(type: EdgeType | 'CROSS_REPO'): void {
    this.state.toggleEdgeFilter(type);
  }

  setLayout(mode: LayoutMode): void {
    this.state.setLayoutMode(mode);
  }

  onConfidenceChange(event: Event): void {
    const value = +(event.target as HTMLInputElement).value;
    this.state.setMinConfidence(value / 100);
  }

  get confidencePercent(): number {
    return Math.round(this.state.minConfidence() * 100);
  }

  isRepoExpanded(repoId: string): boolean {
    return this.state.expandedRepos().has(repoId);
  }

  isRepoLoading(repoId: string): boolean {
    return this.state.expandingRepoIds().has(repoId);
  }

  get anyRepoLoading(): boolean {
    return this.state.expandingRepoIds().size > 0;
  }

  getRepoColor(index: number): string {
    return REPO_COLORS[index % REPO_COLORS.length];
  }

  get hasAnyExpanded(): boolean {
    return this.state.expandedRepos().size > 0;
  }

  get allExpanded(): boolean {
    const connected = this.state.connectedRepos();
    const expanded = this.state.expandedRepos();
    return connected.length > 0 && connected.every(r => expanded.has(r.id));
  }

  onToggleRepo(repo: ConnectedRepo): void {
    if (this.isRepoExpanded(repo.id)) {
      this.collapseRepo.emit(repo.id);
    } else {
      this.expandRepo.emit(repo);
    }
  }

  onExpandAll(): void {
    this.expandAllRepos.emit();
  }

  onCollapseAll(): void {
    this.collapseAllRepos.emit();
  }

  toggleCommunityOverlay(): void {
    this.state.setCommunityOverlay(!this.state.communityOverlay());
  }

  readonly toggleFlows = output<void>();
  readonly toggleDiffImpact = output<void>();
  readonly toggleGitHistory = output<void>();

  onToggleFlows(): void {
    this.toggleFlows.emit();
  }

  onToggleDiffImpact(): void {
    this.toggleDiffImpact.emit();
  }

  onToggleGitHistory(): void {
    this.toggleGitHistory.emit();
  }
}
