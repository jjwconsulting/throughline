-- Seed tenant_sftp_feed for Fennec sales.
--
-- IntegriChain 867 files are inception-to-date snapshots — each new file
-- replaces the prior history. Setting feed_type='full_snapshot' makes
-- silver_sale_build read only rows from the latest source_file, avoiding
-- the duplicate-history problem of accumulating snapshots in bronze.
--
-- For incremental sources (TriSalus daily extracts, future), feed_type
-- defaults to 'incremental' and silver reads all bronze rows across all
-- batches.

INSERT INTO tenant_sftp_feed (
  tenant_id, feed_name, feed_type, silver_table, notes, updated_by
)
SELECT
  t.id,
  'sales_867',
  'full_snapshot'::sftp_feed_type,
  'sale'::silver_table,
  'IntegriChain 867 inception-to-date file. Each new file replaces the prior snapshot.',
  'seed-script'
FROM tenant t
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, feed_name) DO UPDATE
SET feed_type    = EXCLUDED.feed_type,
    silver_table = EXCLUDED.silver_table,
    notes        = EXCLUDED.notes,
    updated_by   = EXCLUDED.updated_by,
    updated_at   = now();
