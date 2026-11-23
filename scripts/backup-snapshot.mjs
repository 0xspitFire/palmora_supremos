export async function copyBackupSnapshot(database, destination) {
  database.exec('BEGIN');
  try {
    // BEGIN is deferred. Read a page before the first backup step so SQLite
    // keeps the same WAL snapshot across every batch of the online backup.
    database.prepare('SELECT count(*) FROM sqlite_schema').get();
    await database.backup(destination);
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
  }
}
