import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('actual export protection function compiles source root only into debug, retaining runtime roots and budgets', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const start = source.indexOf('fn material_export_protected_dirs(');
  const end = source.indexOf('\n#[tauri::command]', start);
  assert.ok(start > 0 && end > start);
  const actualFunction = source.slice(start, end);
  const root = mkdtempSync(join(tmpdir(), 'luckyray-export-build-boundary-'));
  try {
    const developerRoot = join(root, 'developer-source-only');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(developerRoot);
    mkdirSync(runtimeRoot);
    const harness = `
mod tauri {
    use std::path::PathBuf;
    pub struct AppHandle(pub PathBuf);
    impl AppHandle { pub fn path(&self) -> Resolver { Resolver(self.0.clone()) } }
    pub struct Resolver(PathBuf);
    impl Resolver {
        pub fn app_data_dir(&self) -> Result<PathBuf, ()> { Ok(self.0.join("app-data")) }
        pub fn app_config_dir(&self) -> Result<PathBuf, ()> { Ok(self.0.join("config")) }
        pub fn app_cache_dir(&self) -> Result<PathBuf, ()> { Ok(self.0.join("cache")) }
        pub fn resource_dir(&self) -> Result<PathBuf, ()> { Ok(self.0.join("resource")) }
    }
}
${actualFunction}
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let root = std::path::PathBuf::from(&args[1]);
    let source = std::path::PathBuf::from(&args[2]);
    let app = tauri::AppHandle(root.clone());
    let watch = root.join("watch").to_string_lossy().into_owned();
    let protected = material_export_protected_dirs(&app, &[watch.clone()]).unwrap();
    for name in ["app-data", "config", "cache", "resource", "watch"] {
        assert!(protected.contains(&root.join(name)), "runtime root missing: {name}");
    }
    assert!(protected.contains(&std::env::current_exe().unwrap().parent().unwrap().to_path_buf()));
    assert_eq!(protected.contains(&source), cfg!(debug_assertions));
    assert!(material_export_protected_dirs(&app, &["relative".into()]).is_err());
    assert!(material_export_protected_dirs(&app, &vec![watch; 65]).is_err());
    assert!(material_export_protected_dirs(&app, &[format!("{}{}", root.display(), "x".repeat(32_769))]).is_err());
}
`;
    const rs = join(root, 'boundary.rs');
    writeFileSync(rs, harness);
    for (const [mode, debug] of [['debug', 'yes'], ['release', 'no']]) {
      const binary = join(root, `${mode}${process.platform === 'win32' ? '.exe' : ''}`);
      execFileSync('rustc', ['--edition=2021', '-C', 'opt-level=2', '-C', `debug-assertions=${debug}`, rs, '-o', binary],
        { env: { ...process.env, CARGO_MANIFEST_DIR: developerRoot }, stdio: 'pipe' });
      execFileSync(binary, [runtimeRoot, developerRoot], { stdio: 'pipe' });
      const bytes = readFileSync(binary);
      if (mode === 'release') {
        for (const encoding of ['utf8', 'utf16le']) {
          assert.equal(bytes.includes(Buffer.from(developerRoot, encoding)), false, `source root leaked as ${encoding}`);
        }
      } else {
        assert.equal(bytes.includes(Buffer.from(developerRoot)), true, 'debug source protection disappeared');
      }
    }
    for (const command of ['material_csv_export_start', 'material_csv_export_retry', 'material_export_start']) {
      const commandStart = source.indexOf(`fn ${command}(`);
      assert.ok(commandStart > 0);
      assert.ok(source.slice(commandStart, source.indexOf('\n#[tauri::command]', commandStart))
        .includes('material_export_protected_dirs(&app, &watch_roots)?'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
