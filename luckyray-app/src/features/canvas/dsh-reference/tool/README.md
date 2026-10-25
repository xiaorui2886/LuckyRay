# Official DSH Tool presentation source

Source: @deepseek-ai/dsh-client-ui-tool 0.2.1-rc.2, packages/client/ui-tool, MIT.
`upstream.ts` preserves the entire published client bundle body: ToolRow, every specialized card branch, helpers, CSS injections, tool tree and registrations. Only ModuleLoader packaging/imports/exports are adapted to ES modules. Do not invoke `apply`; the application adapter owns all actual actions.

Import `{ ToolRow } from './tool'`. It accepts original props: t, variant, toolName, icon, title, summary, summarySuffix, bodyRaw, output, askQuestion, errorSummary, terminal, diff, read, image, renderSlot, loadImage, search, web, details, state, filePath, filePathLine, onOpenFile, href, inspect, useDisclosure. Optional card props can remain undefined. `useDisclosure()` returns `{ expanded, toggle }` and must retain state per row. States: preparing, running, ok, error, stopped. Existing rows should not be remounted on stream updates.

`locale/conversation.zh.json` and `conversation.en.json` contain the full 373-key official conversation dictionaries, extracted from @deepseek-ai/dsh-client-ui-conversation 0.2.1-rc.2 lib/client.js const zh / en. The two PLAN_NEXT_ACTION constants are resolved to their original string values. The package-level `locale/zh.json` and `en.json` contain metadata only; they are not the runtime ToolRow dictionary. t(key, variables) must interpolate {name} placeholders from the runtime dictionaries. No custom translations added.

UI rendering branches preserved: AskQuestionCard, TerminalBlock, DiffBlock, ReadBlock, image slot with dimensions, SearchBlock and recovery, WebBlock, structured ToolDetails, code/raw input, complete output, inspect control, errors/stopped cues, exit code, diff totals, links and nested calls. This is source availability, not a claim that Canvas supplies all these data schemas.

Validation: esbuild browser ESM bundle syntax and exports passed with React and primitives external. Runtime integration, current LSH visual matching and backend card schemas require separate validation.
