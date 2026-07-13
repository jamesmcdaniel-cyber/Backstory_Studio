-- Workbook-style grouping: flows can live in a named folder ('' = ungrouped).
ALTER TABLE "flows" ADD COLUMN "folder" TEXT NOT NULL DEFAULT '';
