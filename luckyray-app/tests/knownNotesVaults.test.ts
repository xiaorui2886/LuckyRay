import test from 'node:test';
import assert from 'node:assert/strict';
import { readKnownNotesVaults, rememberKnownNotesVault, mergeKnownNotesVaults } from '../src/features/notes/knownVaults.ts';
import type { BridgeVaultMetadata } from '../src/core/bridge/bridgeTypes.ts';

const vault = (id: number): BridgeVaultMetadata => ({ id: `v-${id}`, name: `Library ${id}`, rootPath: `/saved/${id}`, mode: 'vault-bound', createdAt: '2026-01-01', lastOpenedAt: '2026-10-23', schemaVersion: 1 });

test('saved list preserves all 10,000 explicit registrations, not only recent entries', () => {
  const input = Array.from({ length: 10000 }, (_, index) => vault(index));
  const values = readKnownNotesVaults({ getItem: () => JSON.stringify(input) });
  assert.equal(values.length, 10000);
  assert.deepEqual(new Set(values.map(item => item.id)), new Set(input.map(item => item.id)));
});

test('remember retains unavailable saved locations and never synthesizes directories', () => {
  let stored = JSON.stringify([vault(1), vault(2)]);
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
  const values = rememberKnownNotesVault(vault(3), storage);
  assert.deepEqual(new Set(values.map(item => item.rootPath)), new Set(['/saved/1', '/saved/2', '/saved/3']));
  assert.equal(readKnownNotesVaults(storage).length, 3);
});

test('migration source rejects malformed records, keeps newest registration and does not erase failed storage', () => {
  assert.deepEqual(readKnownNotesVaults({ getItem: () => '{bad json' }), []);
  const values = mergeKnownNotesVaults([vault(1)], [{ ...vault(1), name: 'Renamed', lastOpenedAt: '2026-10-24' }]);
  assert.equal(values.length, 1);
  assert.equal(values[0].name, 'Renamed');
  assert.equal(rememberKnownNotesVault(vault(2), { getItem: () => JSON.stringify([vault(1)]), setItem: () => { throw Error('storage blocked'); } }).length, 2);
});
