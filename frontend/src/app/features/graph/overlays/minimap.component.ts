import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { GraphStateService } from '../../../core/services/graph-state.service';
import { D3GraphService } from '../../../core/services/d3-graph.service';
import { PixiGraphService } from '../../../core/services/pixi-graph.service';

@Component({
  selector: 'app-minimap',
  standalone: true,
  template: `
    <div class="minimap" #minimapContainer>
      <svg #minimapSvg [style.display]="state.rendererMode() === 'svg' ? 'block' : 'none'"></svg>
      <canvas #minimapCanvas
              [style.display]="state.rendererMode() === 'webgl' ? 'block' : 'none'"
              width="160" height="120"></canvas>
    </div>
  `,
  styleUrl: './minimap.component.scss',
})
export class MinimapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('minimapSvg', { static: true }) svgRef!: ElementRef<SVGSVGElement>;
  @ViewChild('minimapCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly state = inject(GraphStateService);
  private d3Graph = inject(D3GraphService);
  private pixiGraph = inject(PixiGraphService);

  ngAfterViewInit(): void {
    this.d3Graph.setMinimapElement(this.svgRef.nativeElement);
    this.pixiGraph.setMinimapElement(this.canvasRef.nativeElement);
  }

  ngOnDestroy(): void {
    this.d3Graph.setMinimapElement(null);
    this.pixiGraph.setMinimapElement(null);
  }
}
