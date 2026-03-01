# Graph Viewer

NexGraph includes an interactive graph visualization tool (`graph-viewer.html`) for exploring code knowledge graphs in the browser.

## Opening the Viewer

Serve the file from the project root:

```bash
npx serve . -l 8080
# Open http://localhost:8080/graph-viewer.html
```

Or simply open the file directly in your browser.

## Connecting to NexGraph

1. Enter your NexGraph server URL (e.g., `http://localhost:3000`)
2. Enter your API key (starts with `nxg_`)
3. Select a repository to visualize

The viewer fetches all graph nodes/edges via the [Export API](/api/export) and renders them using D3.js force-directed simulation.

## Layout Modes

### Force (default)

D3.js force-directed simulation. Nodes attract/repel based on their relationships. Good for exploring cluster structure.

### Flow

Hierarchical left-to-right layout using [dagre.js](https://github.com/dagrejs/dagre). Only flow edges (`CALLS`, `IMPORTS`, `EXPOSES`, `EXTENDS`, `IMPLEMENTS`) drive the ranking — structural edges like `CONTAINS`/`DEFINES` are excluded to avoid deep vertical chains.

Best for understanding call chains and data flow.

### Components

Aggregates all symbols inside each file into a single **component node**, showing only inter-file relationships. Each component displays:

- The filename
- A summary of contained symbols (e.g., "3 Fn, 2 Iface")
- Color-coding based on dominant symbol type (orange for route files, pink for class files, cyan for interface files)

Best for understanding high-level architecture and service boundaries.

## Focus Mode (Click-to-Isolate)

Click any node to activate focus mode:

- The selected node and its **neighborhood** are highlighted at full opacity
- Everything else dims to 6% opacity
- Edges are colored directionally:
  - **Orange** — outgoing (calls, depends on)
  - **Blue** — incoming (called by, used by)

### Depth Control

A floating control bar appears at the bottom with depth buttons:

| Depth | What it shows |
|-------|--------------|
| **1** | Direct neighbors only |
| **2** | Neighbors of neighbors |
| **3** | 3-hop transitive dependencies |

Press **Escape** or click **Exit** to leave focus mode.

## Node Types

| Type | Color | Description |
|------|-------|-------------|
| File | Blue | Source files |
| Folder | Yellow | Directories |
| Function | Green | Standalone functions |
| Class | Pink | Class definitions |
| Interface | Cyan | Interface/type definitions |
| Method | Lime | Class methods |
| CodeElement | Purple | Constants, enums, type aliases |
| RouteHandler | Orange | HTTP route handlers |

## Filtering

### Node Filters

Toggle visibility of specific node types using the filter buttons in the toolbar.

### Edge Filters

Toggle visibility of specific edge types. Available edge types: `DEFINES`, `CONTAINS`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `EXPOSES`, `HANDLES`.

### Cross-Repo Toggle

Enable/disable cross-repo edges and phantom nodes. When enabled, connected external repositories appear as red hub nodes with dashed edges to linked symbols.

### Confidence Slider

Adjust the minimum confidence threshold (0–100%) for cross-repo edges. Higher values show only high-confidence matches.

## Search

Type in the search bar to find files by content (uses BM25 full-text search). Click a result to navigate to that file node in the graph.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Escape` | Exit focus mode / close side panel |
| `+` / `-` | Zoom in / out |

## Side Panel

Click any node to open the side panel showing:

- **Properties** — Node metadata (name, file path, line numbers, etc.)
- **Called by / Used by** — Incoming relationships (blue dot)
- **Calls / Depends on** — Outgoing relationships (orange dot)
- **Cross-Repo Links** — Connections to other repositories

Click any relationship in the side panel to navigate to that node.
