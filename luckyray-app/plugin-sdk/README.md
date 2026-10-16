# LuckyRay Plugin SDK V1

SDK toolkit version **1.0.1**, Script Plugin API **1** (not a new runtime).
For a source-free local-tarball install and scaffold/build/package workflow, see
[DELIVERY.md](./DELIVERY.md). Authority/compatibility boundaries are in
[COMPATIBILITY.md](./COMPATIBILITY.md). This package supplies ambient types and
authoring tools; `LuckyRay` is created only by the desktop worker. Do not import
LuckyRay from npm or confuse npm installation with desktop plugin installation.

This directory is an independently usable, MIT-licensed SDK/toolkit. You need Node.js to develop/pack and a LuckyRay host with plugin API1 to install/run. Having the SDK is not the same as having such a host: `minHostVersion` is a declared requirement, not evidence that any particular public release already ships plugin API1. A Chinese getting-started guide is available in [README.zh-CN.md](./README.zh-CN.md). You do not need private host source, credentials, backend globals or official-package exceptions. No npm registry publication is implied by this checked-in package.

```sh
node cli.mjs create ../my-plugin
node cli.mjs check ../my-plugin
node cli.mjs pack ../my-plugin
node cli.mjs dev ../my-plugin
```

`create` writes `plugin.json`, `main.js`, an ambient `sdk.d.ts` copy and a strict `jsconfig.json` into a **new** directory. Use `create ../reader --template material-reader` (or another listed example) for a template. Edit the ID/name/permissions/contributions and the handler. `check` parses JavaScript without executing it and checks authoring budgets; native install remains the schema and compatibility authority. `pack` produces `<id>.lrpack.json`. `dev` watches the two source files and repacks; install/update that file in Community → Extensions → Functional plugins. Changed content for an installed ID requires an increased `x.y.z` version. Identical packages are idempotent. Never point the CLI at untrusted source and execute its contents; the supplied CLI only reads/packages it.

## Runtime and programming model

```js
/// <reference path="./sdk.d.ts" />
LuckyRay.register(async event => {
  const data = await LuckyRay.call("data.get");
  return {
    title: "My panel",
    text: `Event: ${event.input.action}`,
    fields: [{ id: "name", label: "Name", value: "" }],
    actions: [{ id: "greet", label: "Greet" }]
  };
});
```

One handler is registered per package, handling every contribution. `event.input` contains the contribution ID, action (`run`, `theme`, or a returned action ID) and user field values. `event.capabilities` is the host-granted method permission list. `event.objects` contains only this invocation's selected material IDs, optional knowledge vault/documents and canvas IDs. `event.theme` contains finite theme palette values. Theme events are read-only invocations. Always check optional capability **and** available object scope before cross-module use.

Each command/action/theme/settings event starts a fresh isolated JavaScript engine process. Global variables do not persist between invocations. No DOM, HTML, network, Node, filesystem, timers, native module loader, model keys or host bridge is available. Use `data.get/set` for owned state and the documented calls below for approved domain work. `Function`/eval do not add any host capability. JS results are untrusted display data, not authorization or evidence of committed host operations. Host receipts distinguish completed operations.

A command appears in the command palette and plugin entry menu; menu/panel/settings entries open their form directly (fetched on open). Returned UI is a bounded text/field/action schema rendered by the host. Maximum8 fields and8 actions; title160 chars, text16000 chars, input values1000 chars. HTML/URLs/event attributes are not executed. Close stops the running process. Logs are available in the invocation's Run logs section through `log` and host errors. Contributions are removed when the plugin is disabled/uninstalled.

Engine heap32MiB and stack512KiB, interpreter interruption after3s wall time, parent kill/reap deadline10s, at most4 simultaneous invocations and4 in-flight host calls (retired calls retain their quota until they finish),64 calls per invocation,128KiB worker output line,4MiB cumulative output,2MB host response. These are bounded short operations, not a background service. An unresolved Promise does not keep a plugin alive. The worker deadline does not interrupt operating-system file I/O. Retirement rejects operations not yet accepted by the final native live check; an already accepted write may finish after retirement or after waiting for a domain lock. Cancellation/timeout can therefore leave a committed or unknown write outcome: inspect the target and never automatically retry writes. The implementation is a language-engine capability boundary plus a killable process; it is not a claim of an OS security sandbox against native engine vulnerabilities.

## Package format and compatibility

`plugin.json` example:

```json
{
  "id": "example.my-plugin", "name": "My plugin", "version": "1.0.0",
  "minHostVersion": "1.9.2", "requiredModules": ["materials"], "optionalModules": ["knowledge"],
  "requiredPermissions": ["materials.read"], "optionalPermissions": ["knowledge.create"],
  "dataVersion": 1,
  "contributions": [{ "id": "run", "label": "Run plugin", "kind": "command" }]
}
```

Packed envelope: manifest schemaVersion1/apiVersion1/type=`script`/entry=`main.js`, the identity/module/version fields, and resource `{code, requiredPermissions, optionalPermissions, dataVersion, contributions}`. No archive or package file paths. Existing theme/template schema0/api0 remains supported. No Obsidian-format compatibility is promised. Versions are strict nonnegative `x.y.z` segments (each ≤9 digits, no leading zeros). API1 is additive only; removals need a new API major. `minHostVersion` and required-module checks fail closed; optional-module absence is explicit, not an implicit grant.

The native validator rejects unknown fields/types/permissions, invalid module syntax, invalid contribution names and size budgets. A syntactically valid future module name may pass static validation: unsupported required modules fail host compatibility checks, while absent optional modules grant nothing. Package≤128KiB including the final serialized newline, JS source≤120000 bytes, contributions1–16 (kinds command/menu/panel/settings/page; `page` additionally requires EXT-PAGE), total declared permissions≤16, at most32 installed packages. An ID cannot change type in-place. Same-ID updates require a higher version. Added required **or optional** permissions clear consent and disable until the user reviews them. Existing data survives an update. Grants are saved only through host UI; a package cannot grant itself permission or provide another package's identity.

## Permission and API table

The permission names are intentionally distinct from methods. Domain writes need both saved permission and the host's per-invocation write confirmation. Each invocation's domain objects are chosen in trusted host UI. `data.get/set`, `ui.theme` and `log` are inherent methods: `data.set` persists only this package's owned state and does not require a domain grant, selected domain object or domain-write confirmation. Native validation, revision and lifecycle limits still apply. Never pass `pluginId`, `scope`, arbitrary paths, or extra identity keys in method params; extra parameters are rejected.

| Method | Permission | Input / result |
| --- | --- | --- |
| materials.list | materials.read | `{}` → only selected material metadata |
| materials.read | materials.read | `{id}` → metadata including revision/storageMode; no physical path |
| materials.library.list | materials.read | `{libraryId,requestId}` → bounded selected metadata in the host-frozen explicit library; additive, not whole-library enumeration |
| materials.library.read | materials.read | `{libraryId,requestId,id}` → one selected asset in that frozen library; no fallback if unavailable |
| materials.image.open | materials.image | `{id,revision}` → scoped temporary handle/dimensions, only image assets |
| materials.image.read | materials.image | `{handle}` → at most128×128 RGBA8 pixel numbers |
| materials.image.release | materials.image | `{handle}` → release; max4 handles, automatically cleared at end |
| materials.tags | materials.tags | `{id,revision,tags:string[]}` → updated metadata, adds ≤12 tag names of≤80bytes each through existing catalog transaction |
| knowledge.read | knowledge.read | `{path}` within selected vault/documents → saved note + revision (≤128KiB) |
| knowledge.selection | knowledge.read | `{}` → authorized active selection/cursor/ref/revision; unavailable without a clean live editor |
| knowledge.create | knowledge.create | `{title,content}` → note only when host create checkbox is selected independently of document selection, host-chosen parent; content≤32KiB |
| knowledge.insert | knowledge.insert | `{path,revision,offset,text}` → mutation result; UTF-16 offset, text≤16KiB |
| canvas.read | canvas.read | `{id}` → saved whitelisted graph snapshot, digest; ≤500 nodes/2000 edges |
| canvas.export | canvas.export | `{id,digest}` → host-generated SVG written to destination selected before invocation; one export per invocation |
| data.get | inherent, own package only | `{}` → `{schemaVersion,revision,settings,cache}` |
| data.set | inherent, own package only | same object with revision+1 → atomically persisted own data |
| ui.theme | inherent | `{}` → finite current palette captured for invocation |
| log | inherent | `{message}` ≤1000bytes → invocation log |

Read the types in `index.d.ts` for exact shapes. Material images cover managed/source/linked catalog modes through existing catalog-owned file handles. Raw paths are never returned; input≤8MiB, decode bounds4096×4096/64MiB allocation. Source data isn't copied into a second material database. Handle tokens cannot cross invocations/plugins.

Knowledge accesses remain bound to the original vault/source epoch, explicit relative document path and disk revision. Insert/selection require the original Notes editor session to stay mounted and clean; source switch, in-flight save, dirty editor or stale revision rejects. Source/draft checks are also made at native dispatch. Newly created notes and inserts are normal user documents. Existing native save/undo/conflict rules apply; this SDK does not implement a separate undo queue. A mutation result can report index warnings after the body was committed. Post-write UI refresh can fail after a successful write; inspect the target instead of retrying automatically.

Canvas reads the saved snapshot, not live unsaved selections. It exposes only IDs/type/title/position and endpoint-valid edges, excluding media/attachment URLs, raw paths and generation history. Export is a self-contained SVG of this graph with directed links, escaped text and no external resources. It is a graph export, not a full-fidelity image of every media node. A browser can open it. Export destination is chosen by the user in host UI, never by plugin code.

## Data and lifecycle

Own settings/cache share a total64KiB JSON budget. Data revision is independent from the registry's revision and must increment exactly1; conflicting writes are errors, not last-write-wins. `dataVersion` is your maximum schema version. A migration reads old data, transforms it in plugin logic, then stores the new schemaVersion/revision atomically. Versions cannot decrease or exceed the manifest; failed migration leaves old data. No destructive automatic reset is performed. Consider recording migration progress inside your owned data only if one bounded transform isn't enough.

Disable retires execution but keeps owned data. Update keeps owned data; permission expansion requires renewed consent. Uninstall explicitly clears **that plugin's** settings/cache/resources and grants; generated notes, tags and exported files remain user-owned. There is no network download, global credential access or cross-plugin data API. A package's ID is the ownership namespace; changing IDs does not transfer data.

Errors include plugin-permission-denied, plugin-object-denied, plugin-write-confirmation-required, plugin-parameters, plugin-method-unavailable, plugin-handle-denied, plugin-revision-conflict, plugin-retired, plugin-host-veto, plugin-worker-ended, plugin-input/output/result/image/document/canvas-limit, extension-consent-required, extension-data-conflict-or-limit, and existing domain errors. Catch optional-read failures when appropriate. Do not hide a write failure or assume every timeout means no write happened.

## Ordinary examples

- `examples/palette`: offline alpha-weighted average color from selected image pixels, explicit action to add color tags, owned prefix settings. Optional knowledge.create can create a palette note; absence never blocks basic material-only work.
- `examples/outline`: read selected note or a valid selection, deterministic outline, create linked note or explicitly append via existing Knowledge writer.
- `examples/canvas-export`: inspect a selected saved graph and export SVG without media attachments.
- `examples/material-manifest`: group the materials authorized for one run by kind or storage mode, list name/format/tag counts, keep grouping/title preferences in owned settings, and optionally create a manifest note. It was first written outside this repository against only the public files listed above, then copied here as an ordinary example.
- `examples/page-desk`: two EXT-PAGE entries, owned state, immediate saved-value echo. Requires a host with EXT-PAGE; API1 alone does not guarantee this extension.
- `examples/material-reader`: material-only reading works without Knowledge; an explicit optional action connects a selected vault. Unknown write outcomes never auto-retry.

They call only the public SDK and have no privileged IDs or host branches. Run `node cli.mjs pack examples/palette` (and the other directories), install the generated `.lrpack.json`, review permissions, enable, choose objects, run the preview, then enable domain writes and confirm the desired action. No example automatically populates your libraries. All examples are rule-based; none of them is labelled as AI.

## How the host presents a plugin

The Community → Extensions → Functional plugins card shows the package name, version and one of four states: enabled, disabled, consent needed, or incompatible. Required and optional permissions are listed with plain-language meanings; technical permission IDs sit under “Details”. Saving grants and enabling are separate steps, and adding permissions in an update clears consent again. Each run opens a host dialog where the user searches and picks the exact materials, notes (the newest 200 are listed; search reaches the rest) and canvases for that run, decides whether writes are allowed, and confirms writes once more before dispatch — except settings entries, which skip the ceremony: the host runs them once on open and renders the returned form directly. After a run the host lists **its own confirmed operations** — created/inserted notes with a locate action, saved tags, exported SVG size and path, saved owned data — from native responses, not from the plugin's text. Changing the selection marks the previous result as stale and disables its actions until the plugin runs again; a theme change re-renders without discarding what the user typed into fields.

## Testing on an isolated host

You do not need the daily LuckyRay profile to try a package. A debug build of the host compiled with the `extension-runtime-fixture` feature exposes a **community fixture**: the real Community page and plugin dialog, running on a fresh, random, fixture-only profile with its own database, three seeded images, a seeded vault and a seed note. It never opens the development or production profile, never starts LocalTransport/DSH/gateway, and refuses to start when `LUCKYRAY_APP_PROFILE` is `development`/`production`, when its data root already exists, or when the binary was built without the feature. Full operating notes, negative proofs and the automation driver are in `docs/integration/EXT-V1-COMMUNITY-FIXTURE.md`; the short version from the `luckyray-app` directory is:

```powershell
node tests/extension-v1-community/build.mjs                      # bundles the production Community surface for the fixture
$env:TAURI_CONFIG='{"identifier":"com.luckyray.extensionfixture","bundle":{"resources":[],"externalBin":[]}}'
cargo build --manifest-path src-tauri/Cargo.toml --bin luckyray-app --features extension-runtime-fixture --target-dir target/extension-app
$env:LUCKYRAY_APP_PROFILE=''                                     # must not be development/production
& target/extension-app/debug/luckyray-app.exe --extension-community-fixture target/extension-community-fixture
```

The window titled “LuckyRay 插件隔离测试实例” prints its data root on stdout (`fixture-manifest.json` inside it lists the seeded material IDs, vault and note). Install your `.lrpack.json` under Community → 扩展/插件 → 功能插件, save the grants, enable, open an entry, pick the seeded objects and run. Created notes land in `<root>/vault/`; the fixture's read-back panel shows what the host's “定位” action resolved. Close the window to end the instance; delete the root afterwards. `node tests/extension-v1-community/drive.mjs --plugin <your.lrpack.json>` runs the whole flow unattended and writes screenshots plus a `summary.json`.

## Scope facts that are easy to misread

- **`event.objects.knowledge` being non-null does not mean the user allowed note creation.** It only says a vault (and possibly documents) were selected for this run. Creation is a separate per-run opt-in in the host dialog; without it `knowledge.create` is refused with `plugin-create-not-selected` even when the `knowledge.create` permission is granted. Offer creation as an explicit action, catch the refusal, and tell the user to tick “允许在当前知识库创建笔记”; never treat a read grant as a write grant.
- **A granted permission is not this run's scope.** Grants are saved once per package; domain objects and domain-write confirmation are chosen per run. A domain-write method outside the run's objects fails with `plugin-object-denied`; a domain write without the run's write confirmation fails with `plugin-write-confirmation-required`. Inherent `data.set` is limited to this package's own state and does not use this domain-grant/object-confirmation ceremony.
- **Note titles are file names**: the vault refuses `/`, `\`, `:` and a few special cases (`knowledge-invalid-title`), and an existing name is refused with `knowledge-name-conflict` before anything is written. The material-manifest example stamps titles with a local `YYYY-MM-DD HH-MM` suffix so repeat runs create their own notes.
- **Settings contributions must echo what was saved.** After handling a `save` action, return the fields populated with the values you just persisted (not the values read before saving); the host renders exactly the fields you return and does not re-read your data for you. The examples do this.
- **The host keeps its own record of your writes.** Every committed write (`data.set`, `materials.tags`, `knowledge.create`, `knowledge.insert`, `canvas.export`) is shown to the user from the host's native response even if your code later throws, returns an invalid UI, or the run is stopped. A write whose result never came back is shown as “宿主未回报结果” and the user is asked to inspect the target. Do not retry writes inside your plugin and do not describe a write as done in your own text — point the user to the host's record.

## What is not available

No global filesystem/network, arbitrary processes, native/Node modules, model credentials, mobile runtime, account/marketplace/payment service, full editor DOM, Canvas node writes, background daemons or unlimited library access. Sidebar pages (EXT-PAGE, this host line only): a `page` contribution opens as a real main-area page. Declare `{ "id": "board", "label": "看板", "kind": "page" }`; the handler returns the same bounded `{title,text,fields,actions}` schema on every visit (the host runs it once when the page opens and re-runs it on your own actions), the page appears in the shell's history/back-forward under `#plugins/<package>/<page>`, and the host keeps the user's in-progress fields for the session. Pages appear in the "filters" sidebar group only after the user turns on "在侧栏显示" per page on the community card (host-owned preference, default off; hiding a page never disables the plugin). Hosts without EXT-PAGE reject packages containing `page` contributions at install (`extension-invalid-contribution`) — older hosts did not expose any sidebar/page entry point, and that statement remains true for them. Arbitrary HTML/DOM, background services and per-plugin arbitrary navigation stay unsupported. The module APIs listed above are the complete implemented V1 surface. Source-free consumer checks are described in DELIVERY.md; those checks do not replace native Broker, GUI or real-domain acceptance.
