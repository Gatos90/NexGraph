/**
 * Framework detection from file paths using regex patterns.
 * Provides framework multipliers for entry-point scoring.
 */

// ─── Framework Multiplier Patterns ──────────────────────

interface FrameworkPattern {
  pattern: RegExp;
  multiplier: number;
}

const FRAMEWORK_PATTERNS: FrameworkPattern[] = [
  // Controllers / pages / api routes → 3.0
  { pattern: /\/controllers?\//i, multiplier: 3.0 },
  { pattern: /\/pages\//i, multiplier: 3.0 },
  { pattern: /\/api[-/]route/i, multiplier: 3.0 },
  { pattern: /\/api\/.*\/route\.(ts|js)$/i, multiplier: 3.0 },
  { pattern: /\/app\/api\//i, multiplier: 3.0 },

  // Routes / routers → 2.5
  { pattern: /\/routes?\//i, multiplier: 2.5 },
  { pattern: /\/routers?\//i, multiplier: 2.5 },
  { pattern: /\.routes?\.(ts|js)$/i, multiplier: 2.5 },

  // Handlers → 2.0
  { pattern: /\/handlers?\//i, multiplier: 2.0 },

  // Services / middleware → 1.5
  { pattern: /\/services?\//i, multiplier: 1.5 },
  { pattern: /\/middleware\//i, multiplier: 1.5 },

  // Commands / workers → 2.0
  { pattern: /\/commands?\//i, multiplier: 2.0 },
  { pattern: /\/workers?\//i, multiplier: 2.0 },

  // Tests / spec → 0.5
  { pattern: /\/tests?\//i, multiplier: 0.5 },
  { pattern: /\/spec\//i, multiplier: 0.5 },
  { pattern: /\/__tests__\//i, multiplier: 0.5 },
  { pattern: /\.test\./i, multiplier: 0.5 },
  { pattern: /\.spec\./i, multiplier: 0.5 },
];

/**
 * Detect framework multiplier from file path.
 * Returns the highest matching multiplier, or 1.0 if no match.
 */
export function getFrameworkMultiplier(filePath: string): number {
  let maxMultiplier = 1.0;
  for (const { pattern, multiplier } of FRAMEWORK_PATTERNS) {
    if (pattern.test(filePath)) {
      if (multiplier > maxMultiplier) {
        maxMultiplier = multiplier;
      }
      // For test patterns (< 1.0), return immediately — tests always penalized
      if (multiplier < 1.0) {
        return multiplier;
      }
    }
  }
  return maxMultiplier;
}

/**
 * Check if a file path belongs to a test file.
 */
export function isTestFile(filePath: string): boolean {
  return (
    /\/test\//i.test(filePath) ||
    /\/spec\//i.test(filePath) ||
    /\/__tests__\//i.test(filePath) ||
    /\.test\./i.test(filePath) ||
    /\.spec\./i.test(filePath)
  );
}
