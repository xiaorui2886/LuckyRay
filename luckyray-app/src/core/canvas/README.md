# Canvas node capability contract

`nodeCapabilities.ts` is the shared interface for canvas node roles and connection rules. It is intentionally independent from React, the DOM, Tauri and the current canvas persistence adapter.

## Persisted fields

Every saved node data object should contain these JSON fields:

```json
{
  "kind": "image",
  "role": "resource",
  "capabilitiesVersion": 1
}
```

Older canvas files remain valid. `normalizeCanvasNodeCapabilityData` infers missing fields when a canvas is loaded or exported, while preserving a newer numeric capability version for forward-compatible adapters.

## Roles

| Role | Receives connections | Produces connections | Composer |
| --- | --- | --- | --- |
| `resource` | No | Yes | Contextual |
| `editable` | Yes | Yes | Contextual |
| `generator` | Yes | Yes | Contextual |
| `result` | No | Yes | Contextual |
| `container` | No | No | None |

Default inference:

- imported image, imported video and note reference -> `resource`
- text, AI prompt, empty image and empty video -> `editable`
- image/video generation task -> `generator`
- AI text/image/video result -> `result`
- persisted visual group -> `container`

## Groups and arrangement

`canvasArrangement.ts` is the JSON-only grouping and layout module. A group is a
normal persisted node with `type: "group"`, `data.kind: "group"` and
`data.role: "container"`. Member cards store the group id in React Flow's
`parentId` field and keep positions relative to the group. Group nodes must be
serialized before their children and adapters must preserve both `parentId` and
unknown layout fields.

`arrangeCanvasNodes` treats each top-level group as one layout unit, follows edge
direction from left to right and leaves child positions relative to their group.
The function has no React, DOM or Tauri dependency so desktop, CLI and MCP tools
can produce the same deterministic layout.

## Adapter requirements

- Desktop, CLI and MCP adapters should read `role` and `capabilitiesVersion` from node data.
- New connections should be checked through `canConnectCanvasNodes` or an equivalent implementation of this versioned contract.
- Adapters must preserve unknown node data fields when updating a node.
- UI state such as selection, hover, open menus and card CSS classes is not part of the contract.
- Edge meaning is versioned in `edgeSemantics.ts` and must never be inferred from screen position.

## Node commands

`nodeCommands.ts` exposes the stable command Interface used by the card context menu. Desktop, CLI and MCP adapters should dispatch the same ids instead of translating visible Chinese labels:

- `canvas.node.detail`
- `canvas.node.edit`
- `canvas.node.open-source`
- `canvas.node.replace-media`
- `canvas.node.clear-media`
- `canvas.node.derive`
- `canvas.node.save-result`
- `canvas.node.clear-generator`
- `canvas.node.duplicate`
- `canvas.node.delete`

`getCanvasNodeCommands` returns the commands that are valid for a node kind and capability state. Disabled commands remain discoverable when the Interface exists but its runtime Adapter is not connected yet, such as saving a generated result before the generation service is available.

## Edge semantics

Every saved edge should contain JSON data shaped like this:

```json
{
  "source": "image-node-1",
  "target": "video-generator-1",
  "data": {
    "role": "firstFrame",
    "semanticsVersion": 1,
    "order": 0
  }
}
```

Supported roles are `generic`, `reference`, `promptContext`, `firstFrame`, `lastFrame` and `videoReference`.

For a video generator, the first connected image becomes `firstFrame`, the second becomes `lastFrame`, a video becomes `videoReference`, and text or notes become `promptContext`. Image generators receive media as ordered `reference` inputs and text or notes as `promptContext`.

`normalizeCanvasEdgeSemantics` upgrades old edges deterministically from node content and connection order. Desktop, CLI and MCP adapters should use the persisted role when present, preserve unknown edge data fields, and use `order` rather than card coordinates when assembling a generation request.

## Generation tasks

`generationTasks.ts` defines the provider-independent generation task Interface. A submitted composer creates a new read-only `aiResult` node and stores an immutable request snapshot in `node.data.generationTask`:

```json
{
  "version": 1,
  "id": "task-123",
  "parentTaskId": "task-122",
  "sourceNodeId": "image-1",
  "resultNodeId": "result-1",
  "status": "queued",
  "request": {
    "kind": "video",
    "prompt": "slow camera push-in",
    "model": "Kling O3",
    "aspect": "16:9",
    "quality": "1080p",
    "duration": 5,
    "sound": false,
    "references": [
      { "id": "asset-1", "label": "opening frame", "kind": "image", "role": "firstFrame" }
    ]
  },
  "attempt": 1,
  "adapter": null,
  "error": null,
  "createdAt": "2026-07-14T00:00:00.000Z",
  "updatedAt": "2026-07-14T00:00:00.000Z"
}
```

`parentTaskId` is optional and backward-compatible. Retries, successful rerolls and
continued creation set it to the task that produced their source result, while
`sourceNodeId` records the immediate canvas node. This keeps visual edges and the
JSON task contract aligned for desktop, CLI and MCP adapters.

Statuses are `queued`, `running`, `succeeded`, `failed` and `cancelled`. `transitionCanvasGenerationTask` returns an explicit result and rejects invalid transitions. Retrying never mutates the old task or history entry: adapters create a new task with `attempt + 1`.

CanvasLab writes every successful generation back into the card that submitted it. Text replaces the editable text-card body; image and video outputs replace the preview surface of their generator card. `sourceNodeId` and `resultNodeId` therefore point to the same node for new tasks. Every submission still creates a new immutable task and history entry, so the previous output remains available in generation history while the on-canvas card refreshes in place. This removes the separate AI-result node without collapsing task lineage or changing the host adapter contract.

When no compatible Adapter is available, submission stops truthfully at `queued` with `adapter: null`. A future desktop, CLI or MCP Adapter may claim the task, transition it to `running`, then write a `succeeded` result or a typed `failed` error without changing the request Interface.

### Execution module and adapters

`generationRunner.ts` is the shared execution module. Its Interface accepts a task, an ordered list of Adapters, a clock, a transition callback and a cancellation check. It selects the first compatible Adapter and returns one explicit outcome: `unavailable`, `cancelled`, `skipped`, `succeeded` or `failed`. Expected provider failures never escape as untyped exceptions.

`textGenerationAdapter.ts` wraps LuckyRay's existing `aiChatComplete` bridge and supports `request.kind === "text"`. `imageGenerationAdapter.ts` defines the second Adapter Interface around a host-provided `aiImageGenerate` function. The host receives the same immutable request snapshot, including ordered references, aspect, quality and count. Multiple returned images are preserved in `output.mediaItems` and rendered as one gallery inside the generator card. A reference-only image request receives a neutral fallback prompt; a request without either prompt or references fails locally with `IMAGE_PROMPT_REQUIRED`.

The LuckyRay desktop host includes an Agnes preset using `https://apihub.agnes-ai.com/v1`, `agnes-image-2.1-flash` and `agnes-video-v2.0`. Its shared API Key, Base URL and default media models are edited only inside the canvas settings panel and persisted by the host settings bridge; the stored Key is never read back into the renderer, canvas JSON or browser storage. Agnes image requests use `/images/generations`; reference images are passed through `extra_body.image`, and Base64 responses are materialized under the application data directory before their paths are written to a result node.

`videoGenerationAdapter.ts` wraps the host `aiVideoGenerate` Interface. The desktop host creates an Agnes task with `POST /v1/videos`, polls the documented `video_id` result endpoint and accepts text-to-video, one-frame image-to-video and two-frame keyframe requests. Optional provider telemetry is persisted as the JSON-safe `providerTaskId`, `providerStage` and `progress` task fields, so the desktop host can show queued and generating phases while another host may emit or ignore the same fields. A completed HTTPS media location is retained as the task output; the host deliberately does not perform an unbounded or provider-directed backend download. When LuckyRay reopens a running Agnes video task that has a `providerTaskId`, it resumes polling that provider task instead of creating a duplicate video.

### Canvas-local generation history

`generationHistory.ts` defines a provider-independent history entry derived from each task. The history array is stored in the canvas JSON as `generation_history`; it survives source-card deletion and records the immutable request summary, provider task id, progress, final output location and typed error. Old canvases without the field are upgraded in memory from their legacy result nodes.

History version 4 persists the complete immutable generation request (including ordered references, first/last-frame roles, sound, duration, count and camera strength), attempt lineage, multi-image outputs and the stable error code/retryability flag. Provider diagnostics are redacted and bounded before persistence, so queue, rate-limit and response-shape failures can be distinguished without storing credentials or large Base64 payloads. The canvas task center can therefore filter by status or result kind, preview and materialize historical outputs, cancel an active task, retry meaningful failures and submit the same request again without reconstructing parameters from visible labels. Active tasks are protected from history deletion; failed/cancelled entries use an explicit two-step cleanup action.

`generationInputCompiler.ts` is the shared desktop/CLI/MCP input compiler. It folds connected text and note content into the prompt, preserves media references in the immutable request, and orders video images by semantic role (`firstFrame`, `lastFrame`, then ordinary references) instead of relying on the order in which edges happened to be created. The current Agnes host explicitly rejects video-as-reference inputs because its configured image and video endpoints only consume image references; callers receive a non-retryable typed error rather than silently losing that node.

“放回画布” materializes a history snapshot as new usable canvas content instead of overwriting the current source card: text becomes an editable text card, video becomes a video resource card, and every item in a multi-image output becomes its own image resource card. Restored cards keep `sourceGenerationTaskId` and `sourceGenerationHistoryId` provenance fields, but they do not reuse the provider task id or trigger generation.

LuckyRay schedules queued work by creation time with separate conservative limits: two text tasks, one image task and one video task may run concurrently. Queue position is transient UI state and is deliberately not persisted into the immutable request or task contract. Other hosts may use different worker capacity while preserving the same task transitions and cancellation semantics.

Completed image and video entries can be converted to a `CanvasGenerationLibraryCandidate`. The main desktop bridge routes local generated files through LuckyRay's existing managed material-library importer and routes HTTPS image results through the existing image-import command. Completed remote video results are first downloaded through LuckyRay's DNS-pinned, redirect-validated HTTP boundary into an app-owned file with a 512 MiB hard cap and atomic finalization; only that local file is exposed to the canvas and material-library importer.

Custom OpenAI-compatible image endpoints may receive validated reference metadata (`id`, `label`, `kind`, `role`, and `media_url`). Official OpenAI endpoints keep their standard request shape, while Agnes continues to use its native ordered reference-image contract.

The AI chat bridge accepts an optional per-request `model`. The canvas reads the active provider settings, offers only that provider's configured/preset models, and passes the immutable `request.model` through the text Adapter. The Rust command uses this model for the current request without mutating global settings. Desktop, CLI and MCP callers can therefore share the same request snapshot and model-selection semantics.

Expected provider failures are normalized into stable task errors such as `AI_NOT_CONFIGURED`, `AI_AUTH_FAILED`, `AI_MODEL_UNAVAILABLE`, `AI_RATE_LIMITED`, `AI_REQUEST_TIMEOUT`, `AI_CONNECTION_FAILED` and `AI_EMPTY_RESPONSE`. Each error declares whether retrying the unchanged request is meaningful.

Cancellation is cooperative: the existing chat bridge cannot abort an in-flight request, so cancellation immediately transitions the canvas task and suppresses any late result writeback. A persisted running Agnes video task resumes when it contains a provider task id; other persisted running tasks become retryable `GENERATION_INTERRUPTED` failures. Persisted queued tasks resume once their matching host adapter is available.
