# manifestlens

APIs that want to be usable by agents publish an Agent
Manifest: a small JSON document that says what the API is,
which endpoints an agent may call, and what constraints
apply. manifestlens is a client for that Agent Manifest
Protocol. It finds a manifest at an origin's well-known
locations, checks a manifest's shape, files an origin with
the public AMP registry and follows the submission, and —
the part worth doing before every call — answers whether
an intended operation is actually permitted by the
manifest you are holding.

No API key is involved anywhere. The manifest probes and
the registry are both public; the two local tools never
leave the machine.

## Configuration

- `AMP_REGISTRY_BASE_URL` (optional) — base URL for the
  registry tools. Defaults to
  `https://api.agent-manifest.com`.
- `AMP_FETCH_TIMEOUT_MS` (optional) — timeout applied to
  manifest fetches. Defaults to `15000`.

## Tools

- `fetch_manifest_by_domain` — given a `domain` (a bare
  host, or a URL whose scheme and path are stripped), it
  requests `/.well-known/agent-manifest.json`,
  `/.well-known/amp.json`, and `/agent-manifest.json`
  under `https://<host>`, in that order, and returns the
  first manifest that answers, together with the winning
  `manifest_url`, the `origin`, and the `tried_urls` list.
  When nothing answers, it fails with
  `no AMP manifest found for <host> (tried 3 URLs)`.
- `validate_manifest_syntax` — checks a manifest given as
  an object or as a JSON string. It applies the structural
  subset of the AMP schema described below and either
  returns `valid: true` with a success token of the form
  `amp-schema-valid:<spec_version>:<name>`, or
  `valid: false` with a list of path/message errors. A
  string that does not parse as JSON is a validation
  failure, not a tool error.
- `submit_api_to_amp_registry` — posts a `domain`'s
  origin to the registry's submission endpoint
  (`POST /listings/submit`) and returns the registry's
  JSON reply unchanged.
- `check_amp_submission_status` — polls
  `GET /listings/submit/<submission_id>/status` and
  returns the registry's JSON reply unchanged.
- `check_agent_permissions` — takes an `action` such as
  `POST /baking/validate-mix`, a `manifest`, and the
  optional booleans `intends_unauthenticated` and
  `payment_onboarded` (both default false). It replies
  with a `verdict` — `compliant`, `violation`, `warning`,
  or `unknown` — plus structured `findings`, and the
  `matched_endpoint` when a declared route matched.
  Finding codes include `endpoint_not_declared` (no
  declared route matches the action),
  `auth_required` (the route needs authentication but
  the action intends to run unauthenticated),
  `payment_onboarding` (the route or manifest declares
  payment terms and onboarding is not complete), and
  `agent_notes_usage_restriction` (the manifest's
  `agent_notes` contain restriction language such as
  "do not" or "only for"). Declared routes may use
  `{id}`-style template segments, which match any single
  path segment.

Registry failures share two shapes: a non-2xx reply fails
with `amp registry error: HTTP <status>`, and an
unreachable registry with `amp registry unreachable`.
Argument validation fails before any request with
`domain must be a non-empty string`,
`manifest must be an object or a JSON string`,
`submission_id must be a non-empty string`,
`action must be a non-empty string`, or
`manifest must be an object`, as applicable.

### What is a subset, and what is a reconstruction

Three parts of this build are deliberately labelled,
here and in the code:

- **Validation subset.** The full official AMP JSON
  Schema is not in the readable record, so validation
  implements its documented structural subset: the value
  must be a JSON object, `spec_version` must be
  `agentmanifest-0.2` or `agentmanifest-0.3`, `name` must
  be a non-empty string, and a present `endpoints` must
  be an array of objects each carrying a string `path`,
  `url`, or `route`.
- **Submit input and body.** The original tool's submit
  input is not shown in its README; manifestlens takes
  `{domain}` and posts `{"origin": "https://<host>"}`,
  a reconstruction.
- **Permission-rule mechanics.** The verdicts and
  finding codes above are documented; the exact matching
  and precedence mechanics that produce them are a
  reconstruction. Two finding codes are local extensions:
  `unparseable_action` (the action does not start with
  an HTTP method) and `no_endpoints_declared` (the
  manifest carries no readable endpoints at all) — both
  come with verdict `unknown`.

## CLI

Each tool is a subcommand taking one JSON argument
string:

```bash
npx @reneturcios/manifestlens fetch_manifest_by_domain '{"domain":"api.example.com"}'
npx @reneturcios/manifestlens validate_manifest_syntax '{"manifest":{"spec_version":"agentmanifest-0.3","name":"My API"}}'
npx @reneturcios/manifestlens submit_api_to_amp_registry '{"domain":"api.example.com"}'
npx @reneturcios/manifestlens check_amp_submission_status '{"submission_id":"sub_123"}'
npx @reneturcios/manifestlens check_agent_permissions '{"action":"POST /baking/validate-mix","manifest":{"endpoints":[{"method":"POST","path":"/baking/validate-mix"}]}}'
npx @reneturcios/manifestlens --version
```

Output is the tool's result text. Exit codes: `0` on
success, `1` on a runtime error (including a validation
or upstream failure), `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/manifestlens mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "manifestlens": {
      "command": "npx",
      "args": ["-y", "@reneturcios/manifestlens", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/manifestlens
docker run --rm ghcr.io/cloudcorprecords/manifestlens fetch_manifest_by_domain '{"domain":"api.example.com"}'
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake fetch only, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
