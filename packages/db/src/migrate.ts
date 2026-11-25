import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseName, sharedTableNames, tableRewriter, type BaseEnv } from '@talkie/core';

/**
 * Applies `database/<folder>/NNN_name.sql` files in order to `database`, once each.
 * Applied files are recorded with a checksum; editing an applied file is refused (write a new migration instead).
 */
export async function migrate(env: BaseEnv, defaultName: string, folder: string, log: (line: string) => void = console.log) {
  const database = databaseName(env, defaultName);
  const rewrite = tableRewriter(sharedTableNames(env, defaultName));
  const admin = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
    charset: 'utf8mb4',
    ...(env.DB_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(database)) throw new Error(`Unsafe database name: ${database}`);
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (error) {
      // Shared hosting (cPanel) creates databases in its control panel; the account may not create them itself.
      const code = (error as { code?: string }).code;
      if (code !== 'ER_DBACCESS_DENIED_ERROR' && code !== 'ER_ACCESS_DENIED_ERROR') throw error;
    }
    await admin.query(`USE \`${database}\``);
    await admin.query(rewrite(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(190) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`));
    const [rows] = await admin.query(rewrite('SELECT version, checksum FROM schema_migrations'));
    const applied = new Map((rows as Array<{ version: string; checksum: string }>).map((r) => [r.version, r.checksum]));
    const files = (await readdir(folder)).filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(join(folder, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`${database}/${file} changed after it was applied`);
        continue;
      }
      log(`  ${database}: applying ${file}`);
      await admin.query(rewrite(sql));
      await admin.query(rewrite('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)'), [file, checksum]);
    }
  } finally {
    await admin.end();
  }
}
