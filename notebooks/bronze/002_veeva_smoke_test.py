# %% [markdown]
# # Veeva Direct Data smoke test
#
# Sanity-checks that we can authenticate to the configured Vault, list
# Direct Data extracts, and identify the latest FULL. Does NOT download
# anything or write to bronze — that's the next notebook.
#
# Run this BEFORE building the real ingest, so credential/connectivity
# issues surface in isolation rather than during a multi-tenant ingest run.
#
# Before running:
#   1. Run packages/db/scripts/seed-tenant-veeva-fennecpharma.sql in Supabase
#   2. Run config_sync notebook to push the tenant_veeva row to Fabric
#   3. Set the parameters cell (especially VEEVA_PASSWORD)
#   4. Inline-paste the contents of notebooks/lib/veeva_directdata.py at the
#      top (Fabric notebooks don't auto-import sibling Python files; this is
#      a known dev-loop friction point we'll solve later via a wheel)

# %% [parameters]
# Set at runtime; do not commit real values.
TENANT_SLUG = "acme-pharma"
VEEVA_PASSWORD = ""  # paste at runtime; never commit

# %%
# (At runtime in Fabric: paste contents of notebooks/lib/veeva_directdata.py here)
# from notebooks.lib.veeva_directdata import VeevaDirectData  # if importable

# %%
# Pull tenant_veeva config for the target tenant from the synced Fabric mirror.
config_row = spark.sql(f"""
  SELECT tv.vault_domain, tv.username, tv.password_secret_uri, tv.enabled
  FROM config.tenant_veeva tv
  JOIN config.tenant t ON t.id = tv.tenant_id
  WHERE t.slug = '{TENANT_SLUG}'
""").collect()

if not config_row:
    raise RuntimeError(
        f"No tenant_veeva config for slug='{TENANT_SLUG}'. "
        "Did you run the seed SQL + config_sync notebook?"
    )
cfg = config_row[0].asDict()
print(f"Vault: {cfg['vault_domain']}")
print(f"User:  {cfg['username']}")
print(f"Secret URI: {cfg['password_secret_uri']}  (resolving from runtime param)")

if not VEEVA_PASSWORD:
    raise ValueError("VEEVA_PASSWORD parameter is empty — set it before running.")

# %%
# Authenticate
client = VeevaDirectData(
    vault_dns=cfg["vault_domain"],
    username=cfg["username"],
    password=VEEVA_PASSWORD,
)
client.authenticate()
print("Authenticated.")

# %%
# List FULL extracts available — pick the most recent
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)
window_start = "2000-01-01T00:00Z"  # all available history
window_stop = (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%MZ")

full_extracts = client.list_extracts(
    extract_type="full_directdata",
    start_time=window_start,
    stop_time=window_stop,
)
print(f"FULL extracts found: {len(full_extracts)}")
for e in full_extracts[-5:]:  # show the 5 most recent
    print(f"  {e.name}  stop={e.stop_time}  records={e.record_count:,}  parts={e.fileparts}  size={e.size:,}")

if not full_extracts:
    raise RuntimeError("No FULL extracts available — Direct Data may not be generating yet.")

latest_full = full_extracts[-1]
print(f"\nLatest FULL: {latest_full.name} (stop={latest_full.stop_time})")

# %%
# List incrementals available since the latest FULL — proves both extract
# types work and shows what we'd ingest in incremental mode.
inc_extracts = client.list_extracts(
    extract_type="incremental_directdata",
    start_time=latest_full.stop_time,
    stop_time=window_stop,
)
print(f"\nIncremental batches since latest FULL: {len(inc_extracts)}")
non_empty = [e for e in inc_extracts if e.record_count > 0]
print(f"  with records: {len(non_empty)}")
for e in non_empty[-10:]:
    print(f"  {e.name}  stop={e.stop_time}  records={e.record_count:,}")

# %%
print("\n✓ Smoke test passed. Vault auth works, Direct Data extracts visible.")
print("Next: build the real ingest notebook (Phase 2).")
