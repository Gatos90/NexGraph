import { defineConfig } from "vitepress";

export default defineConfig({
  title: "NexGraph",
  description:
    "Headless Code Intelligence Engine — Build Knowledge Graphs, Let AI Agents Consume Them",

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API Reference", link: "/api/" },
      { text: "MCP", link: "/mcp/" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Introduction", link: "/guide/getting-started" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "Graph Viewer", link: "/guide/graph-viewer" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "Authentication", link: "/api/authentication" },
          ],
        },
        {
          text: "Core Resources",
          items: [
            { text: "System", link: "/api/system" },
            { text: "Projects", link: "/api/projects" },
            { text: "API Keys", link: "/api/api-keys" },
            { text: "Repositories", link: "/api/repositories" },
            { text: "Indexing", link: "/api/indexing" },
          ],
        },
        {
          text: "Code Intelligence",
          items: [
            { text: "Graph", link: "/api/graph" },
            { text: "Search", link: "/api/search" },
            { text: "Files", link: "/api/files" },
            { text: "Export", link: "/api/export" },
          ],
        },
        {
          text: "Cross-Repo",
          items: [
            { text: "Connections", link: "/api/connections" },
            { text: "Cross-Repo Graph", link: "/api/cross-repo-graph" },
          ],
        },
      ],
      "/mcp/": [
        {
          text: "MCP Guide",
          items: [
            { text: "Overview", link: "/mcp/" },
            { text: "Integration Guide", link: "/mcp/integration-guide" },
            { text: "Claude Plugin Bundle", link: "/mcp/claude-plugin" },
            { text: "Stdio Transport", link: "/mcp/stdio" },
            { text: "HTTP Transport", link: "/mcp/http" },
            { text: "Tools Reference", link: "/mcp/tools" },
          ],
        },
      ],
      "/architecture/": [
        {
          text: "Architecture",
          items: [
            { text: "Overview", link: "/architecture/" },
            { text: "Ingestion Pipeline", link: "/architecture/ingestion" },
            { text: "Graph Model", link: "/architecture/graph-model" },
            { text: "Database Layer", link: "/architecture/database" },
            { text: "Cross-Repo Resolution", link: "/architecture/cross-repo" },
          ],
        },
      ],
      "/tutorials/": [
        {
          text: "Tutorials",
          items: [
            { text: "Index Your First Repo", link: "/tutorials/" },
            { text: "Query the Graph", link: "/tutorials/query-graph" },
            { text: "Multi-Repo Setup", link: "/tutorials/multi-repo" },
          ],
        },
      ],
      "/configuration/": [
        {
          text: "Configuration",
          items: [
            { text: "Environment Variables", link: "/configuration/" },
            { text: "Project Settings", link: "/configuration/project-settings" },
            { text: "Worker Pool", link: "/configuration/worker-pool" },
            { text: "Docker Compose", link: "/configuration/docker" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/nexgraph/nexgraph" },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
    },
  },
});
