# Changelog

## 0.1.0 (2026-10-27)

- Initial release: five MCP tools and matching CLI subcommands
  for the Agent Manifest Protocol — `fetch_manifest_by_domain`,
  `validate_manifest_syntax`, `submit_api_to_amp_registry`,
  `check_amp_submission_status`, and `check_agent_permissions`.
- Manifests are fetched from the three well-known locations in
  order; validation checks the documented structural subset of
  the AMP schema for `agentmanifest-0.2` / `agentmanifest-0.3`
  and issues an `amp-schema-valid:<spec_version>:<name>`
  success token; registry submissions go to the public AMP
  registry (base URL via `AMP_REGISTRY_BASE_URL`, fetch timeout
  via `AMP_FETCH_TIMEOUT_MS`).
