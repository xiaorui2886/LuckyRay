import assert from "node:assert/strict";
import test from "node:test";

import { openBackendOwnedDatabase } from "../src/core/backendBootstrap.ts";

test("production waits for backend readiness before opening the database and importing legacy data", async () => {
  const events: string[] = [];
  const database = { identity: "opaque-database-handle" };

  const result = await openBackendOwnedDatabase(true, {
    readStatus: async () => {
      events.push("status");
      return { ready: true, schemaVersion: 1, error: null };
    },
    openDatabase: async () => {
      events.push("open");
      return database;
    },
    migrateLegacyBrowserData: async (value) => {
      events.push("legacy-data");
      assert.equal(value, database);
    },
  });

  assert.equal(result, database);
  assert.deepEqual(events, ["status", "open", "legacy-data"]);
});

test("backend failure is fail-closed and never opens a production database", async () => {
  let opened = false;
  await assert.rejects(
    openBackendOwnedDatabase(true, {
      readStatus: async () => ({
        ready: false,
        schemaVersion: 0,
        error: "migration failed",
      }),
      openDatabase: async () => {
        opened = true;
        return {};
      },
      migrateLegacyBrowserData: async () => {},
    }),
    /migration failed/,
  );
  assert.equal(opened, false);
});

test("browser preview remains independent from the Rust backend", async () => {
  let backendCalled = false;
  const result = await openBackendOwnedDatabase(false, {
    readStatus: async () => {
      backendCalled = true;
      return { ready: true, schemaVersion: 1, error: null };
    },
    openDatabase: async () => {
      backendCalled = true;
      return {};
    },
    migrateLegacyBrowserData: async () => {
      backendCalled = true;
    },
  });
  assert.equal(result, null);
  assert.equal(backendCalled, false);
});
