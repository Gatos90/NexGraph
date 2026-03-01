import { pool } from "../db/index.js";
import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("rename");

// ─── Types ───────────────────────────────────────────────────

export interface RenameEdit {
  file_path: string;
  line: number;
  column_start: number;
  column_end: number;
  old_text: string;
  new_text: string;
  confidence: number;
  reason: string;
}

export interface RenameResult {
  symbol: string;
  edits: RenameEdit[];
  affected_files: string[];
  total_edits: number;
  applied: boolean;
  warnings: string[];
}

export interface RenameOptions {
  symbol: string;
  new_name: string;
  repo?: string;
  file_path?: string;
  label?: string;
  dry_run?: boolean;
  min_confidence?: number;
}

interface SymbolCandidate {
  id: number;
  name: string;
  label: string;
  file_path: string;
  line: number;
}

// ─── Symbol Lookup ───────────────────────────────────────────

async function findSymbolCandidates(
  graphName: string,
  symbolName: string,
  filePath?: string,
  label?: string,
): Promise<SymbolCandidate[]> {
  const baseQuery = filePath
    ? `MATCH (f:File {path: $filePath})-[:DEFINES]->(n)
       WHERE n.name = $symbolName
       RETURN n, f.path AS file_path, n.start_line AS start_line`
    : `MATCH (f:File)-[:DEFINES]->(n)
       WHERE n.name = $symbolName
       RETURN n, f.path AS file_path, n.start_line AS start_line`;

  const baseParams: Record<string, unknown> = { symbolName };
  if (filePath) baseParams.filePath = filePath;

  const rows = await cypher<{ n: AgeVertex; file_path: unknown; start_line: unknown }>(
    graphName,
    baseQuery,
    baseParams,
    [{ name: "n" }, { name: "file_path" }, { name: "start_line" }],
  );

  const candidates: SymbolCandidate[] = [];
  for (const row of rows) {
    const props = row.n.properties;
    const nodeName = typeof props.name === "string" ? props.name : "";
    const nodeFilePath = typeof row.file_path === "string" ? row.file_path : "";
    const nodeLine = typeof row.start_line === "number"
      ? row.start_line
      : typeof props.start_line === "number"
        ? props.start_line
        : typeof props.line === "number"
          ? props.line
          : 0;

    // Filter by label if specified
    if (label && row.n.label !== label) continue;

    // Skip structural nodes that don't represent symbols
    if (["File", "Folder", "Community"].includes(row.n.label)) continue;

    candidates.push({
      id: row.n.id,
      name: nodeName,
      label: row.n.label,
      file_path: nodeFilePath,
      line: nodeLine,
    });
  }

  return candidates;
}

// ─── Reference Discovery via Graph Edges ─────────────────────

interface SymbolReference {
  file_path: string;
  line: number;
  confidence: number;
  reason: string;
}

async function findDefinitionSite(
  candidate: SymbolCandidate,
): Promise<SymbolReference> {
  return {
    file_path: candidate.file_path,
    line: candidate.line,
    confidence: 1.0,
    reason: "definition",
  };
}

async function findCallSites(
  graphName: string,
  candidate: SymbolCandidate,
): Promise<SymbolReference[]> {
  const refs: SymbolReference[] = [];

  // Find callers: (caller)-[:CALLS]->(this)
  try {
    const rows = await cypher<{ file_path: unknown; line: unknown }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(caller)-[e:CALLS]->(target)
       WHERE id(target) = $targetId
       RETURN f.path AS file_path, coalesce(e.line, caller.start_line, caller.line, 0) AS line`,
      { targetId: candidate.id },
      [{ name: "file_path" }, { name: "line" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
      refs.push({
        file_path: filePath,
        line,
        confidence: 0.9,
        reason: "call_site",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find call sites");
  }

  return refs;
}

async function findImportSites(
  graphName: string,
  candidate: SymbolCandidate,
): Promise<SymbolReference[]> {
  const refs: SymbolReference[] = [];
  if (!candidate.file_path) return refs;

  // Find import edges targeting the candidate's file
  try {
    const rows = await cypher<{ file_path: unknown }>(
      graphName,
      `MATCH (importer:File)-[:IMPORTS]->(target:File {path: $targetFilePath})
       RETURN DISTINCT importer.path AS file_path`,
      { targetFilePath: candidate.file_path },
      [{ name: "file_path" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      refs.push({
        file_path: filePath,
        line: 0,
        confidence: 0.95,
        reason: "import_statement",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find import sites");
  }

  return refs;
}

async function findTypeReferences(
  graphName: string,
  candidate: SymbolCandidate,
): Promise<SymbolReference[]> {
  const refs: SymbolReference[] = [];

  // Find EXTENDS edges: (child)-[:EXTENDS]->(this)
  try {
    const rows = await cypher<{ file_path: unknown; line: unknown }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(child)-[e:EXTENDS]->(target)
       WHERE id(target) = $targetId
       RETURN DISTINCT f.path AS file_path, coalesce(e.line, child.start_line, child.line, 0) AS line`,
      { targetId: candidate.id },
      [{ name: "file_path" }, { name: "line" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
      refs.push({
        file_path: filePath,
        line,
        confidence: 0.95,
        reason: "extends_reference",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find EXTENDS references");
  }

  // Find IMPLEMENTS edges: (implementor)-[:IMPLEMENTS]->(this)
  try {
    const rows = await cypher<{ file_path: unknown; line: unknown }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(impl)-[e:IMPLEMENTS]->(target)
       WHERE id(target) = $targetId
       RETURN DISTINCT f.path AS file_path, coalesce(e.line, impl.start_line, impl.line, 0) AS line`,
      { targetId: candidate.id },
      [{ name: "file_path" }, { name: "line" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
      refs.push({
        file_path: filePath,
        line,
        confidence: 0.95,
        reason: "implements_reference",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find IMPLEMENTS references");
  }

  return refs;
}

async function findOverrideChain(
  graphName: string,
  candidate: SymbolCandidate,
): Promise<SymbolReference[]> {
  const refs: SymbolReference[] = [];

  // Find OVERRIDES edges in both directions:
  // (child)-[:OVERRIDES]->(this) — things that override this symbol
  try {
    const rows = await cypher<{ file_path: unknown; line: unknown }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(child)-[e:OVERRIDES]->(target)
       WHERE id(target) = $targetId
       RETURN DISTINCT f.path AS file_path, coalesce(e.line, child.start_line, child.line, 0) AS line`,
      { targetId: candidate.id },
      [{ name: "file_path" }, { name: "line" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
      refs.push({
        file_path: filePath,
        line,
        confidence: 0.9,
        reason: "override_child",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find override children");
  }

  // (this)-[:OVERRIDES]->(parent) — what this symbol overrides
  try {
    const rows = await cypher<{ file_path: unknown; line: unknown }>(
      graphName,
      `MATCH (f:File)-[:DEFINES]->(parent)<-[e:OVERRIDES]-(source)
       WHERE id(source) = $sourceId
       RETURN DISTINCT f.path AS file_path, coalesce(e.line, parent.start_line, parent.line, 0) AS line`,
      { sourceId: candidate.id },
      [{ name: "file_path" }, { name: "line" }],
    );
    for (const row of rows) {
      const filePath = typeof row.file_path === "string" ? row.file_path : "";
      const line = typeof row.line === "number" ? row.line : Number(row.line) || 0;
      refs.push({
        file_path: filePath,
        line,
        confidence: 0.9,
        reason: "override_parent",
      });
    }
  } catch (err) {
    log.debug({ err, symbol: candidate.name }, "Failed to find override parents");
  }

  return refs;
}

// ─── Position Resolution ─────────────────────────────────────

const LINE_TOLERANCE = 5;

function locateSymbolInContent(
  content: string,
  symbolName: string,
  expectedLine: number,
): Array<{ line: number; column_start: number; column_end: number }> {
  const lines = content.split("\n");
  const pattern = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, "g");
  const results: Array<{ line: number; column_start: number; column_end: number }> = [];

  // Search the full file when expected line is unknown.
  const startLine = expectedLine > 0
    ? Math.max(0, expectedLine - 1 - LINE_TOLERANCE)
    : 0;
  const endLine = expectedLine > 0
    ? Math.min(lines.length, expectedLine - 1 + LINE_TOLERANCE + 1)
    : lines.length;

  for (let i = startLine; i < endLine; i++) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[i])) !== null) {
      results.push({
        line: i + 1, // 1-based
        column_start: match.index + 1, // 1-based
        column_end: match.index + symbolName.length + 1, // exclusive, 1-based
      });
    }
  }

  return results;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── File Content Access ─────────────────────────────────────

async function getFileContent(
  repoId: string,
  filePath: string,
): Promise<string | null> {
  const result = await pool.query<{ content: string }>(
    `SELECT content FROM file_contents WHERE repository_id = $1 AND file_path = $2`,
    [repoId, filePath],
  );
  return result.rows.length > 0 ? result.rows[0].content : null;
}

async function writeFileContent(
  repoId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await pool.query(
    `UPDATE file_contents SET content = $3, search_vector = to_tsvector('simple', $3)
     WHERE repository_id = $1 AND file_path = $2`,
    [repoId, filePath, content],
  );
}

// ─── Apply Edits ─────────────────────────────────────────────

function applyEditsToContent(
  content: string,
  edits: RenameEdit[],
): string {
  const lines = content.split("\n");

  // Sort bottom-up: highest line first, then rightmost column first
  const sorted = [...edits].sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    return b.column_start - a.column_start;
  });

  for (const edit of sorted) {
    const lineIdx = edit.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const line = lines[lineIdx];
    const colStart = edit.column_start - 1; // 0-based
    const colEnd = edit.column_end - 1; // 0-based, exclusive

    lines[lineIdx] =
      line.substring(0, colStart) + edit.new_text + line.substring(colEnd);
  }

  return lines.join("\n");
}

// ─── Main Function ───────────────────────────────────────────

export async function renameSymbol(
  repoId: string,
  graphName: string,
  options: RenameOptions,
): Promise<RenameResult> {
  const {
    symbol: symbolName,
    new_name: newName,
    file_path: filterFilePath,
    label: filterLabel,
    dry_run = true,
    min_confidence = 0.8,
  } = options;

  const warnings: string[] = [];

  // 1. Find symbol candidates
  const candidates = await findSymbolCandidates(
    graphName,
    symbolName,
    filterFilePath,
    filterLabel,
  );

  if (candidates.length === 0) {
    return {
      symbol: symbolName,
      edits: [],
      affected_files: [],
      total_edits: 0,
      applied: false,
      warnings: [`No symbol found matching '${symbolName}'`],
    };
  }

  if (candidates.length > 1 && !filterFilePath && !filterLabel) {
    // Ambiguous — return candidate list for user selection
    return {
      symbol: symbolName,
      edits: [],
      affected_files: [],
      total_edits: 0,
      applied: false,
      warnings: [
        `Ambiguous symbol '${symbolName}': found ${candidates.length} candidates. ` +
        `Specify file_path or label to disambiguate. Candidates: ${JSON.stringify(
          candidates.map((c) => ({
            label: c.label,
            file_path: c.file_path,
            line: c.line,
          })),
        )}`,
      ],
    };
  }

  // Use first candidate (or the single one if filtered)
  const target = candidates[0];

  // 2. Collect all references via graph edges
  const allRefs: SymbolReference[] = [];

  // Definition site
  allRefs.push(await findDefinitionSite(target));

  // Call sites
  const callRefs = await findCallSites(graphName, target);
  allRefs.push(...callRefs);

  // Import sites
  const importRefs = await findImportSites(graphName, target);
  allRefs.push(...importRefs);

  // Type references (EXTENDS, IMPLEMENTS)
  const typeRefs = await findTypeReferences(graphName, target);
  allRefs.push(...typeRefs);

  // Override chain
  const overrideRefs = await findOverrideChain(graphName, target);
  allRefs.push(...overrideRefs);

  // 3. Deduplicate references by file_path + line
  const uniqueRefs = deduplicateRefs(allRefs);

  // 4. Resolve exact positions in file contents
  const edits: RenameEdit[] = [];
  const fileContentCache = new Map<string, string>();

  for (const ref of uniqueRefs) {
    if (!ref.file_path) {
      warnings.push(`Skipping reference with empty file_path (reason: ${ref.reason})`);
      continue;
    }

    let content = fileContentCache.get(ref.file_path);
    if (content === undefined) {
      const fetched = await getFileContent(repoId, ref.file_path);
      if (fetched === null) {
        warnings.push(`File '${ref.file_path}' not found in content store (reason: ${ref.reason})`);
        continue;
      }
      content = fetched;
      fileContentCache.set(ref.file_path, content);
    }

    const positions = locateSymbolInContent(content, symbolName, ref.line);
    if (positions.length === 0) {
      warnings.push(
        `Symbol '${symbolName}' not found near line ${ref.line} in ${ref.file_path} (reason: ${ref.reason})`,
      );
      continue;
    }

    // Pick the closest position to expected line
    const closest = positions.reduce((best, pos) =>
      Math.abs(pos.line - ref.line) < Math.abs(best.line - ref.line) ? pos : best,
    );

    edits.push({
      file_path: ref.file_path,
      line: closest.line,
      column_start: closest.column_start,
      column_end: closest.column_end,
      old_text: symbolName,
      new_text: newName,
      confidence: ref.confidence,
      reason: ref.reason,
    });
  }

  // 5. Deduplicate edits at the same position
  const uniqueEdits = deduplicateEdits(edits);

  // 6. Filter by min_confidence and sort by confidence desc
  const filteredEdits: RenameEdit[] = [];
  for (const edit of uniqueEdits) {
    if (edit.confidence < min_confidence) {
      warnings.push(
        `Edit skipped (confidence ${edit.confidence} < ${min_confidence}): ` +
        `${edit.file_path}:${edit.line} (${edit.reason})`,
      );
      continue;
    }
    filteredEdits.push(edit);
  }
  filteredEdits.sort((a, b) => b.confidence - a.confidence);

  const affectedFiles = [...new Set(filteredEdits.map((e) => e.file_path))];

  // 7. Apply edits if not dry_run
  let applied = false;
  if (!dry_run && filteredEdits.length > 0) {
    // Group edits by file
    const editsByFile = new Map<string, RenameEdit[]>();
    for (const edit of filteredEdits) {
      const existing = editsByFile.get(edit.file_path) ?? [];
      existing.push(edit);
      editsByFile.set(edit.file_path, existing);
    }

    for (const [filePath, fileEdits] of editsByFile) {
      const content = fileContentCache.get(filePath);
      if (!content) {
        warnings.push(`Cannot apply edits to '${filePath}': content not loaded`);
        continue;
      }

      const updatedContent = applyEditsToContent(content, fileEdits);
      await writeFileContent(repoId, filePath, updatedContent);
    }
    applied = true;
    log.info(
      { symbol: symbolName, newName, editCount: filteredEdits.length, fileCount: affectedFiles.length },
      "Rename applied",
    );
  }

  return {
    symbol: symbolName,
    edits: filteredEdits,
    affected_files: affectedFiles,
    total_edits: filteredEdits.length,
    applied,
    warnings,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function deduplicateRefs(refs: SymbolReference[]): SymbolReference[] {
  const seen = new Map<string, SymbolReference>();
  for (const ref of refs) {
    const key = `${ref.file_path}:${ref.line}`;
    const existing = seen.get(key);
    if (!existing || ref.confidence > existing.confidence) {
      seen.set(key, ref);
    }
  }
  return [...seen.values()];
}

function deduplicateEdits(edits: RenameEdit[]): RenameEdit[] {
  const seen = new Map<string, RenameEdit>();
  for (const edit of edits) {
    const key = `${edit.file_path}:${edit.line}:${edit.column_start}`;
    const existing = seen.get(key);
    if (!existing || edit.confidence > existing.confidence) {
      seen.set(key, edit);
    }
  }
  return [...seen.values()];
}
