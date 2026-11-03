/**
 * manifestlens types.
 *
 * Five tools for the Agent Manifest Protocol: fetch a
 * manifest from an origin's well-known locations, validate
 * a manifest, submit an origin to the public registry,
 * poll a submission's status, and check an intended
 * operation against a manifest's declared endpoints.
 */

export interface FetchManifestArgs {
  domain: string;
}

export interface ValidateManifestArgs {
  /** A manifest object, or a JSON string that must parse. */
  manifest: unknown;
}

export interface SubmitApiArgs {
  domain: string;
}

export interface CheckSubmissionStatusArgs {
  submission_id: string;
}

export interface CheckAgentPermissionsArgs {
  /** Intended HTTP operation, e.g. "POST /baking/validate-mix". */
  action: string;
  /** A manifest object, as returned by fetch_manifest_by_domain. */
  manifest: Record<string, unknown>;
  intends_unauthenticated?: boolean;
  payment_onboarded?: boolean;
}

/** One validation failure: an AJV-style path plus what is wrong. */
export interface ManifestValidationError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { valid: true; success_token: string }
  | { valid: false; errors: ManifestValidationError[] };

export interface PermissionFinding {
  code: string;
  message: string;
}

export type PermissionVerdict =
  | "compliant"
  | "violation"
  | "warning"
  | "unknown";

export interface PermissionResult {
  verdict: PermissionVerdict;
  findings: PermissionFinding[];
  /** Present only when a declared route matched the action. */
  matched_endpoint?: unknown;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Runtime dependencies for the core, all injectable in tests. */
export interface ManifestDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Environment (AMP_REGISTRY_BASE_URL / AMP_FETCH_TIMEOUT_MS). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Registry base URL override. Defaults to env AMP_REGISTRY_BASE_URL or the pinned default. */
  baseUrl?: string;
  /** Manifest fetch timeout in ms. Defaults to env AMP_FETCH_TIMEOUT_MS or 15000. */
  timeoutMs?: number;
}
