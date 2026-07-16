-- Klavis has been replaced by Nango-backed provider tools. Remove legacy
-- Strata/custom rows and migrate agent selections before dropping its model.

DELETE FROM "public"."agent_connectors" legacy
USING "public"."agent_connectors" duplicate
WHERE legacy."id" > duplicate."id"
  AND legacy."agentTaskId" = duplicate."agentTaskId"
  AND (legacy."kind" = 'klavis' OR lower(legacy."connectorKey") LIKE 'strata:%')
  AND (duplicate."kind" = 'klavis' OR lower(duplicate."connectorKey") LIKE 'strata:%')
  AND regexp_replace(lower(legacy."connectorKey"), '^(strata:)?', '') =
      regexp_replace(lower(duplicate."connectorKey"), '^(strata:)?', '');

DELETE FROM "public"."agent_connectors" legacy
WHERE (legacy."kind" = 'klavis' OR lower(legacy."connectorKey") LIKE 'strata:%')
  AND EXISTS (
    SELECT 1
    FROM "public"."agent_connectors" current
    WHERE current."agentTaskId" = legacy."agentTaskId"
      AND lower(current."connectorKey") = 'nango:' || regexp_replace(lower(legacy."connectorKey"), '^(strata:)?', '')
  );

UPDATE "public"."agent_connectors"
SET "connectorKey" = 'nango:' || regexp_replace(lower("connectorKey"), '^(strata:)?', ''),
    "kind" = 'nango'
WHERE "kind" = 'klavis' OR lower("connectorKey") LIKE 'strata:%';

UPDATE "public"."agent_tasks" agent
SET "metadata" = jsonb_set(
  agent."metadata",
  '{integrations}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN lower(value) LIKE 'strata:%'
          THEN to_jsonb('nango:' || regexp_replace(lower(value), '^strata:', ''))
        ELSE to_jsonb(value)
      END
    )
    FROM jsonb_array_elements_text(agent."metadata"->'integrations') entry(value)
  )
)
WHERE jsonb_typeof(agent."metadata"->'integrations') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(agent."metadata"->'integrations') entry(value)
    WHERE lower(value) LIKE 'strata:%'
  );

DELETE FROM "public"."mcp_connections"
WHERE lower("serverUrl") LIKE '%strata.klavis.ai%';

DROP TABLE IF EXISTS "public"."mcp_agents";
