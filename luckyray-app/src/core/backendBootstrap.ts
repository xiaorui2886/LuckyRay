export type BackendBootstrapStatus = {
  ready: boolean;
  schemaVersion: number;
  error: string | null;
};

type BackendDatabaseDependencies<T> = {
  readStatus: () => Promise<BackendBootstrapStatus>;
  openDatabase: () => Promise<T>;
  migrateLegacyBrowserData: (database: T) => Promise<void>;
};

export async function openBackendOwnedDatabase<T>(
  tauriRuntime: boolean,
  dependencies: BackendDatabaseDependencies<T>,
): Promise<T | null> {
  if (!tauriRuntime) return null;
  const status = await dependencies.readStatus();
  if (!status.ready) {
    throw new Error(status.error || "LuckyRay 后端数据库尚未就绪");
  }
  const database = await dependencies.openDatabase();
  await dependencies.migrateLegacyBrowserData(database);
  return database;
}
