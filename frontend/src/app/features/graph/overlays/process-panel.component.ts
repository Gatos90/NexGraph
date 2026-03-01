import { Component, inject, signal, computed } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { ApiService } from '../../../core/services/api.service';
import { firstValueFrom } from 'rxjs';

interface ProcessEntry {
  process_id: string;
  label: string;
  process_type: string;
  step_count: number;
  entry_point_name: string;
  terminal_name: string;
}

interface ProcessStep {
  step: number;
  id: string | number;
  name: string;
  label: string;
  file_path?: string;
}

@Component({
  selector: 'app-process-panel',
  standalone: true,
  template: `
    @if (visible()) {
      <div class="process-panel">
        <div class="process-panel-header">
          <span>Flows</span>
          <button class="process-panel-close" (click)="close()">×</button>
        </div>
        <div class="process-panel-list">
          @for (proc of processes(); track proc.process_id) {
            <button
              class="process-item"
              [class.active]="state.activeProcess() === proc.process_id"
              (click)="toggleProcess(proc)"
            >
              <div class="process-item-header">
                <span class="process-type-badge" [class.cross]="proc.process_type === 'cross_community'">
                  {{ proc.process_type === 'cross_community' ? 'CROSS' : 'INTRA' }}
                </span>
                <span class="process-step-count">{{ proc.step_count }} steps</span>
              </div>
              <div class="process-item-label">{{ proc.entry_point_name }} → {{ proc.terminal_name }}</div>
            </button>
          }
          @if (processes().length === 0 && !loading()) {
            <div class="process-empty">No processes detected</div>
          }
          @if (loading()) {
            <div class="process-empty">Loading...</div>
          }
        </div>

        @if (expandedSteps().length > 0) {
          <div class="process-steps-section">
            <div class="process-steps-header">Step Sequence</div>
            @for (step of expandedSteps(); track step.step) {
              <div class="process-step">
                <span class="step-number">{{ step.step }}</span>
                <span class="step-label">{{ step.label }}</span>
                <span class="step-name">{{ step.name }}</span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .process-panel {
      position: absolute;
      top: 52px;
      left: 12px;
      background: var(--surface-bg, #1a1a2e);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 8px;
      max-height: 420px;
      width: 260px;
      display: flex;
      flex-direction: column;
      z-index: 20;
      overflow: hidden;
    }
    .process-panel-header {
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
    .process-panel-close {
      background: none;
      border: none;
      color: var(--text-dim, #888);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
    }
    .process-panel-close:hover {
      color: var(--text-primary, #eee);
    }
    .process-panel-list {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 200px;
    }
    .process-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px;
      border: none;
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--text-primary, #eee);
      text-align: left;
      transition: background 0.15s;
    }
    .process-item:hover {
      background: var(--hover-bg, #ffffff10);
    }
    .process-item.active {
      background: var(--hover-bg, #ffffff18);
      border-left: 2px solid #34d399;
    }
    .process-item-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .process-type-badge {
      font-size: 8px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      background: #34d39930;
      color: #34d399;
    }
    .process-type-badge.cross {
      background: #3b82f630;
      color: #60a5fa;
    }
    .process-step-count {
      font-size: 9px;
      color: var(--text-dim, #888);
    }
    .process-item-label {
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .process-empty {
      padding: 12px;
      text-align: center;
      font-size: 11px;
      color: var(--text-dim, #888);
    }
    .process-steps-section {
      border-top: 1px solid var(--border-color, #333);
      margin-top: 6px;
      padding-top: 6px;
      overflow-y: auto;
      max-height: 180px;
    }
    .process-steps-header {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim, #888);
      margin-bottom: 4px;
      padding: 0 4px;
    }
    .process-step {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
    }
    .step-number {
      width: 18px;
      text-align: right;
      color: #34d399;
      font-weight: 600;
      flex-shrink: 0;
    }
    .step-label {
      font-size: 8px;
      color: var(--text-dim, #888);
      flex-shrink: 0;
    }
    .step-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-primary, #eee);
    }
  `],
})
export class ProcessPanelComponent {
  readonly state = inject(GraphStateService);
  private api = inject(ApiService);

  readonly visible = signal(false);
  readonly processes = signal<ProcessEntry[]>([]);
  readonly expandedSteps = signal<ProcessStep[]>([]);
  readonly loading = signal(false);

  async show(): Promise<void> {
    this.visible.set(true);
    if (this.processes().length === 0) {
      await this.loadProcesses();
    }
  }

  close(): void {
    this.visible.set(false);
    this.state.setActiveProcess(null);
    this.state.setProcessStepIds([]);
    this.expandedSteps.set([]);
  }

  async toggleProcess(proc: ProcessEntry): Promise<void> {
    if (this.state.activeProcess() === proc.process_id) {
      // Deselect
      this.state.setActiveProcess(null);
      this.state.setProcessStepIds([]);
      this.expandedSteps.set([]);
    } else {
      // Select and load steps
      this.state.setActiveProcess(proc.process_id);
      await this.loadSteps(proc.process_id);
    }
  }

  private async loadProcesses(): Promise<void> {
    const repoId = this.state.repoId();
    if (!repoId) return;

    this.loading.set(true);
    try {
      const resp = await firstValueFrom(
        this.api.postCypher(repoId,
          'MATCH (p:Process) RETURN p ORDER BY p.step_count DESC LIMIT 50',
          [{ name: 'p' }])
      );

      const processes: ProcessEntry[] = (resp?.rows || []).map((row: Record<string, unknown>) => {
        const p = row['p'] as Record<string, unknown>;
        const props = (p?.['properties'] || {}) as Record<string, unknown>;
        return {
          process_id: (props['process_id'] as string) || '',
          label: (props['label'] as string) || '',
          process_type: (props['process_type'] as string) || '',
          step_count: (props['step_count'] as number) || 0,
          entry_point_name: (props['entry_point_name'] as string) || '',
          terminal_name: (props['terminal_name'] as string) || '',
        };
      });

      this.processes.set(processes);
    } catch (err) {
      console.warn('Failed to load processes:', err);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSteps(processId: string): Promise<void> {
    const repoId = this.state.repoId();
    if (!repoId) return;

    try {
      const resp = await firstValueFrom(
        this.api.postCypher(repoId,
          `MATCH (s)-[e:STEP_IN_PROCESS]->(p:Process {process_id: '${processId}'}) RETURN s, e ORDER BY e.step`,
          [{ name: 's' }, { name: 'e' }])
      );

      const steps: ProcessStep[] = [];
      const ids: (string | number)[] = [];

      for (const row of resp?.rows || []) {
        const s = row['s'] as Record<string, unknown>;
        const e = row['e'] as Record<string, unknown>;
        const sProps = (s?.['properties'] || {}) as Record<string, unknown>;
        const eProps = (e?.['properties'] || {}) as Record<string, unknown>;

        const nodeId = s?.['id'] as string | number;
        ids.push(nodeId);

        steps.push({
          step: (eProps['step'] as number) || steps.length + 1,
          id: nodeId,
          name: (sProps['name'] as string) || '',
          label: (s?.['label'] as string) || '',
          file_path: sProps['file_path'] as string | undefined,
        });
      }

      this.expandedSteps.set(steps);
      this.state.setProcessStepIds(ids);
    } catch (err) {
      console.warn('Failed to load process steps:', err);
    }
  }
}
