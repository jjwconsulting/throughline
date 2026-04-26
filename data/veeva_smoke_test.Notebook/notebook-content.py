# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "aaab7cf8-9b09-435e-8259-d666601d7472",
# META       "default_lakehouse_name": "throughline_lakehouse",
# META       "default_lakehouse_workspace_id": "a2a0bfa2-0d9d-4787-849a-b0a215495876",
# META       "known_lakehouses": [
# META         {
# META           "id": "aaab7cf8-9b09-435e-8259-d666601d7472"
# META         }
# META       ]
# META     }
# META   }
# META }

# CELL ********************

# Lists all columns on the Veeva account__v bronze whose name hints at
# being a cross-system identifier. Should surface the real Network ID
# and DEA field names if they exist under different conventions.
schema = spark.table("bronze_acme_pharma.veeva_obj_account__v").schema
keywords = ["network", "dea", "vid", "vc__", "external", "master", "global"]
hits = sorted(
    f.name
    for f in schema.fields
    if any(k in f.name.lower() for k in keywords)
)
for h in hits:
    print(h)


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
