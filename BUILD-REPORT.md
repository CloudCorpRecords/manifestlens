# manifestlens — Build Report (Batch 23)

Rebuild of the `@agentmanifest/mcp-server` MCP server
(npm v0.1.5; registry record
`com.agent-manifest/amp-mcp`) from the firsthand spec in
`specs-batch23/manifestlens.md`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/manifestlens` @ 0.1.0, bin
  `manifestlens` → `dist/cli.js`
- MCP Registry name:
  `io.github.CloudCorpRecords/manifestlens` (matches
  `package.json` `mcpName`, `server.json` `name`, and
  the Dockerfile `io.modelcontextprotocol.server.name`
  label)
- server.json description (98 chars, verified):
  "Agent Manifest Protocol: fetch, validate and
  permission-check API manifests; registry submissions."
- server.json: npm package entry carries `"version":
  "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/manifestlens:0.1.0`) carries
  **no** `version` field (verified).

## Files (19-file factory set, per TEMPLATE.md §2)

package.json, server.json, Dockerfile, tsconfig.json
(byte-identical to builds/geodata/tsconfig.json, verified
with `cmp`), .gitignore, package-lock.json, README.md
(fresh prose), LICENSE (MIT, © 2026 Rene Turcios),
CHANGELOG.md (single 0.1.0 entry dated 2026-10-27),
src/index.ts, src/cli.ts, src/mcp.ts, src/types.ts,
src/manifest.ts (core), test/manifest.test.ts, and the
four workflows under .github/workflows/
(publish-container adapted: IMAGE
ghcr.io/cloudcorprecords/manifestlens, smoke assertion
on server name `manifestlens`). Plus this
BUILD-REPORT.md and the parity-out/ artifacts. The parity
fixture lives at the program-level
`harness/fixtures/agentmanifest-mcp-server-tools-original.json`
with the spec's exact `_source` string.

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`,
  handlers for `ListToolsRequestSchema` /
  `CallToolRequestSchema` from `sdk/types.js`), explicit
  JSON-schema literals for all 5 tools
  (fetch_manifest_by_domain, validate_manifest_syntax,
  submit_api_to_amp_registry,
  check_amp_submission_status,
  check_agent_permissions); no McpServer/zod
  registration. Tool descriptions and schemas are the
  fixture's, exactly: the validate tool's `manifest`
  property is `{"type": ["object","string"]}`, the
  permissions tool's `manifest` is a plain object, the
  two permission booleans carry no `default` keys, and
  no schema carries `additionalProperties`.
- `src/manifest.ts`: `VERSION = "0.1.0"`. All network
  access goes through an injectable fetch (deps
  `fetchFn`, `env`, `baseUrl`, `timeoutMs`).
  - `fetch_manifest_by_domain`: `normalizeHost` strips
    scheme/path/query and lowercases; the three
    well-known URLs are tried in the documented order
    under `https://<host>`; a throwing fetch or a
    non-2xx/non-JSON body counts as a miss; the first
    usable body wins and the result carries `manifest`,
    `manifest_url`, `origin`, and `tried_urls`. All
    three missing fails with `no AMP manifest found for
    <host> (tried 3 URLs)`. Fetches honour
    `AMP_FETCH_TIMEOUT_MS` (default 15000) via an abort
    timeout.
  - `validate_manifest_syntax`: the labelled structural
    subset (see Gaps). Success returns
    `amp-schema-valid:<spec_version>:<name>`; failure
    returns `valid: false` with `{path, message}` errors;
    an unparseable JSON string is a validation failure,
    not an isError. A manifest that is neither object
    nor string fails with `manifest must be an object
    or a JSON string`.
  - Registry tools: submit posts to
    `POST <base>/listings/submit`, status polls
    `GET <base>/listings/submit/{submission_id}/status`
    (id URL-encoded); base defaults to
    `https://api.agent-manifest.com`, overridable via
    `AMP_REGISTRY_BASE_URL`. Replies pass through
    verbatim; non-2xx → `amp registry error: HTTP
    <status>`; throwing fetch → `amp registry
    unreachable`.
  - `check_agent_permissions`: pure computation. The
    action is parsed as `<METHOD> <path>`; routes match
    on equal paths or `{...}` template segments, with
    method equality when the endpoint declares one;
    endpoints are read from an array or a path-keyed
    object. Findings follow the documented codes —
    `endpoint_not_declared`, `auth_required`,
    `payment_onboarding`,
    `agent_notes_usage_restriction` — with verdicts
    `violation` > `warning` > `compliant`, and
    `matched_endpoint` present only on a match.
  - Validation (before any request) uses the pinned
    strings: `domain must be a non-empty string`,
    `manifest must be an object or a JSON string`,
    `submission_id must be a non-empty string`,
    `action must be a non-empty string`,
    `manifest must be an object`.
- CLI: one subcommand per tool taking a JSON argument
  string, `mcp`, `--version` (prints `0.1.0`); unknown
  subcommand → usage on stderr, exit 2; isError results
  exit 1 (both spot-checked against the built CLI).

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0.
- `npm test`: **59 tests, 59 pass, 0 fail** — fake
  fetch and injected env only, no live network. Covers
  host normalization; the ordered well-known tries
  (first hit, first miss/second hit, throw-as-miss, all
  miss with the pinned message and exact tried order);
  validation success for 0.2/0.3 in object and
  JSON-string form, the unparseable string, the
  non-object JSON string, and every structural failure,
  plus the success_token format; submit and status
  wires (URL, method, body, content type, encoding),
  verbatim passthrough including a non-canonical JSON
  string, registry base overrides, and HTTP-error /
  unreachable mappings; permission verdicts (compliant,
  endpoint_not_declared including method mismatch,
  auth_required at endpoint and manifest level,
  auth `"none"`, payment warning and its onboarded
  pass, violation precedence over warning, agent_notes
  warnings in string and array form, unknown for
  unparseable action and for no readable endpoints,
  `{id}` template matching and segment-count
  rejection, path-keyed endpoints); validation errors
  with no request made; and CLI cases (--version,
  unknown/no subcommand exit 2, bad JSON exit 2, extra
  args exit 2, offline validate success, runtime
  failure exit 1).
- `node dist/cli.js --version`: prints `0.1.0`.
  Unknown subcommand exits 2 with usage; a validation
  failure exits 1.
- Parity: `harness/parity.py` against
  `harness/fixtures/agentmanifest-mcp-server-tools-original.json`
  → **PASS, parity 100.0, identical_tools 5 / total 5**
  (see `parity-out/parity.json`).
- Lockfile (Route 3, clean from birth): generated in a
  temp dir containing only `package.json` with
  `npm install --package-lock-only --ignore-scripts
  --offline`; verified it parses, `name` ==
  `@reneturcios/manifestlens`, **128 package entries**;
  copied in as `package-lock.json`, then
  `npm install --offline --ignore-scripts` in the build
  dir succeeded for node_modules.
- Version consistency: `package.json` 0.1.0 =
  `server.json` top-level 0.1.0 = npm entry 0.1.0 = OCI
  tag `:0.1.0` = core `VERSION` 0.1.0 = CHANGELOG
  heading `## 0.1.0 (2026-10-27)`.

## Gaps

- As the spec labels them: `validate_manifest_syntax`
  implements a documented structural subset of the
  official AMP schema (the full schema is not in the
  readable record); `submit_api_to_amp_registry`'s
  `{domain}` input and its `{"origin": ...}` request
  body are reconstructions (the input is not shown in
  the original's README); `check_agent_permissions`'
  rule mechanics are a reconstruction of the documented
  verdicts and finding codes, and its
  `unparseable_action` / `no_endpoints_declared`
  findings are local extensions.
- Live upstream behaviour is unproven: no live call was
  made (tests are fake-fetch only), and
  `AMP_FETCH_TIMEOUT_MS` timing is not exercised by the
  test suite.
