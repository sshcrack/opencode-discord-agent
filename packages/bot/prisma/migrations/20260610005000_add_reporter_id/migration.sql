Loaded Prisma config from prisma.config.ts.

Error: P3006

Migration `20260610005000_add_reporter_id` failed to apply cleanly to the shadow database. 
Error:
SQLite database error
near "Loaded": syntax error in Loaded Prisma config from prisma.config.ts.

 at offset 0
   0: sql_schema_connector::flavour::sqlite::sql_schema_from_migration_history
           with _namespaces=None _filter=SchemaFilter { external_tables: [], external_enums: [] } external_shadow_db=No
             at schema-engine/connectors/sql-schema-connector/src/flavour/sqlite.rs:352

