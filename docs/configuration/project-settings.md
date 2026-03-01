# Project Settings

Each project has a `settings` JSON object that controls indexing behavior. Settings are stored in the `projects.settings` column and can be updated via the API.

## Update Settings

```http
PATCH /api/v1/projects/{projectId}
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "settings": {
    "include_globs": ["src/**/*.ts", "lib/**/*.js"],
    "exclude_globs": ["**/*.test.ts", "**/__mocks__/**"]
  }
}
```

## Available Settings

### `include_globs`

Array of glob patterns. Only files matching at least one pattern will be indexed.

```json
{
  "include_globs": ["src/**/*.ts", "src/**/*.tsx"]
}
```

If not set, all files (subject to exclude rules) are indexed.

### `exclude_globs`

Array of glob patterns. Files matching any pattern will be excluded from indexing.

```json
{
  "exclude_globs": [
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/node_modules/**",
    "**/dist/**"
  ]
}
```

These patterns are applied in addition to `.gitignore` rules.

## Glob Pattern Syntax

| Pattern | Matches |
|---------|---------|
| `*.ts` | TypeScript files in root |
| `**/*.ts` | TypeScript files in any directory |
| `src/**` | Everything under src/ |
| `!**/*.test.ts` | Exclude test files |
| `{src,lib}/**` | Files under src/ or lib/ |
