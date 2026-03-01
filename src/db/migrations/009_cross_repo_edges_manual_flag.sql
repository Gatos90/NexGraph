-- Add manual flag to cross_repo_edges to distinguish auto-detected vs manually created edges
ALTER TABLE cross_repo_edges ADD COLUMN manual BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_cross_repo_edges_manual ON cross_repo_edges(manual) WHERE manual = TRUE;
