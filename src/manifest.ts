/**
 * manifestlens core: five tools for the Agent Manifest
 * Protocol (AMP).
 *
 * Shared rules, as documented in the spec:
 * - `fetch_manifest_by_domain` normalizes the host (strip
 *   scheme and path, lowercase), then tries, in order,
 *   `/.well-known/agent-manifest.json`,
 *   `/.well-known/amp.json`, and `/agent-manifest.json`
 *   under `https://<host>`; the first 2xx JSON body wins.
 *   A throwing fetch on a candidate counts as a miss. When
 *   all three miss, the tool fails with
 *   `no AMP manifest found for <host> (tried 3 URLs)`.
 * - `validate_manifest_syntax` checks a labelled structural
 *   subset of the official AMP schema (the full schema is
 *   not in the readable record): the value must be a JSON
 *   object, `spec_version` must be `agentmanifest-0.2` or
 *   `agentmanifest-0.3`, `name` must be a non-empty string,
 *   and a present `endpoints` must be an array of objects
 *   each carrying a string `path`, `url`, or `route`.
 *   Success carries a success token of the form
 *   `amp-schema-valid:<spec_version>:<name>`.
 * - `submit_api_to_amp_registry` posts `{"origin":
 *   "https://<host>"}` (a labelled reconstruction of the
 *   request body) to `POST <registry>/listings/submit`;
 *   `check_amp_submission_status` polls
 *   `GET <registry>/listings/submit/{submission_id}/status`.
 *   The registry base defaults to
 *   `https://api.agent-manifest.com` and is overridable via
 *   env `AMP_REGISTRY_BASE_URL`. Registry replies pass
 *   through verbatim; a non-2xx reply fails with
 *   `amp registry error: HTTP <status>` and a throwing
 *   fetch with `amp registry unreachable`.
 * - `check_agent_permissions` compares an intended HTTP
 *   operation with a manifest's declared endpoints and
 *   constraints, and answers a verdict of `compliant`,
 *   `violation`, `warning`, or `unknown` with structured
 *   findings. The verdict outputs and finding codes are
 *   documented; the rule mechanics are a labelled
 *   reconstruction.
 * - Manifest fetches honour `AMP_FETCH_TIMEOUT_MS`
 *   (default 15000) through an abort timeout. All network
 *   access goes through the injectable fetch in deps, so
 *   tests run against a fake fetch only.
 */
import type {
  CheckAgentPermissionsArgs,
  CheckSubmissionStatusArgs,
  FetchFn,
  FetchManifestArgs,
  FetchResponseLike,
  ManifestDeps,
  PermissionFinding,
  PermissionResult,
  SubmitApiArgs,
  ValidateManifestArgs,
  ValidationResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_REGISTRY_BASE_URL = "https://api.agent-manifest.com";
export const DEFAULT_FETCH_TIMEOUT_MS = 15000;

const WELL_KNOWN_PATHS = [
  "/.well-known/agent-manifest.json",
  "/.well-known/amp.json",
  "/agent-manifest.json",
] as const;

function envOf(deps: ManifestDeps): Record<string, string | undefined> {
  return deps.env ?? process.env;
}

function registryBaseUrl(deps: ManifestDeps): string {
  if (deps.baseUrl && deps.baseUrl.trim() !== "") {
    return deps.baseUrl.trim().replace(/\/+$/, "");
  }
  const raw = envOf(deps).AMP_REGISTRY_BASE_URL;
  const base = raw && raw.trim() !== "" ? raw.trim() : DEFAULT_REGISTRY_BASE_URL;
  return base.replace(/\/+$/, "");
}

function fetchTimeoutMs(deps: ManifestDeps): number {
  if (typeof deps.timeoutMs === "number" && deps.timeoutMs > 0) {
    return deps.timeoutMs;
  }
  const raw = envOf(deps).AMP_FETCH_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS;
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init);
}

function fetchFn(deps: ManifestDeps): FetchFn {
  return deps.fetchFn ?? defaultFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/* ------------------------------------------------------------------ */
/* Host normalization                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalize a domain argument to a bare host: strip the
 * scheme and any path, query, or fragment, and lowercase.
 * Throws the pinned validation error for non-string, empty,
 * or host-less input.
 */
export function normalizeHost(domain: unknown): string {
  if (typeof domain !== "string" || domain.trim() === "") {
    throw new Error("domain must be a non-empty string");
  }
  let host = domain.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  if (host === "") {
    throw new Error("domain must be a non-empty string");
  }
  return host;
}

/* ------------------------------------------------------------------ */
/* fetch_manifest_by_domain                                            */
/* ------------------------------------------------------------------ */

/** Fetch and parse a manifest from an API origin's well-known locations. */
export async function fetchManifestByDomain(
  args: FetchManifestArgs,
  deps: ManifestDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const host = normalizeHost(a.domain);
  const origin = `https://${host}`;
  const triedUrls: string[] = [];
  const signal = AbortSignal.timeout(fetchTimeoutMs(deps));
  for (const path of WELL_KNOWN_PATHS) {
    const url = `${origin}${path}`;
    triedUrls.push(url);
    let res: FetchResponseLike;
    try {
      res = await fetchFn(deps)(url, { method: "GET", signal });
    } catch {
      continue; // a network error on one candidate is a miss; try the next
    }
    if (!is2xx(res.status)) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await res.text());
    } catch {
      continue; // a 2xx body that is not JSON is not a usable manifest
    }
    return JSON.stringify({
      manifest,
      manifest_url: url,
      origin,
      tried_urls: triedUrls,
    });
  }
  throw new Error(
    `no AMP manifest found for ${host} (tried ${triedUrls.length} URLs)`,
  );
}

/* ------------------------------------------------------------------ */
/* validate_manifest_syntax                                            */
/* ------------------------------------------------------------------ */

/**
 * Validate a manifest value against the labelled structural
 * subset of the AMP schema. Returns a result object; an
 * unparseable JSON string is a validation failure, not an
 * error.
 */
export function validateManifestValue(manifest: unknown): ValidationResult {
  let value = manifest;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        valid: false,
        errors: [{ path: "", message: "manifest string is not valid JSON" }],
      };
    }
  }
  if (!isRecord(value)) {
    return {
      valid: false,
      errors: [{ path: "", message: "manifest must be a JSON object" }],
    };
  }
  const errors: { path: string; message: string }[] = [];
  const specVersion = value.spec_version;
  if (specVersion === undefined) {
    errors.push({ path: "spec_version", message: "spec_version is required" });
  } else if (specVersion !== "agentmanifest-0.2" && specVersion !== "agentmanifest-0.3") {
    errors.push({
      path: "spec_version",
      message: "spec_version must be agentmanifest-0.2 or agentmanifest-0.3",
    });
  }
  const name = value.name;
  if (name === undefined) {
    errors.push({ path: "name", message: "name is required" });
  } else if (typeof name !== "string" || name === "") {
    errors.push({ path: "name", message: "name must be a non-empty string" });
  }
  if (value.endpoints !== undefined) {
    const endpoints = value.endpoints;
    if (!Array.isArray(endpoints)) {
      errors.push({ path: "endpoints", message: "endpoints must be an array" });
    } else {
      endpoints.forEach((endpoint, i) => {
        if (!isRecord(endpoint)) {
          errors.push({
            path: `endpoints[${i}]`,
            message: "endpoint must be an object",
          });
          return;
        }
        const hasPath = ["path", "url", "route"].some(
          (key) => typeof endpoint[key] === "string",
        );
        if (!hasPath) {
          errors.push({
            path: `endpoints[${i}]`,
            message: "endpoint must carry a string path, url, or route",
          });
        }
      });
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    success_token: `amp-schema-valid:${String(specVersion)}:${String(name)}`,
  };
}

/** Validate a manifest object or JSON string against the AMP schema subset. */
export async function validateManifestSyntax(
  args: ValidateManifestArgs,
  _deps: ManifestDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const manifest = a.manifest;
  const acceptable =
    typeof manifest === "string" ||
    (typeof manifest === "object" && manifest !== null);
  if (!acceptable) {
    throw new Error("manifest must be an object or a JSON string");
  }
  return JSON.stringify(validateManifestValue(manifest));
}

/* ------------------------------------------------------------------ */
/* Registry client                                                     */
/* ------------------------------------------------------------------ */

async function callRegistry(
  deps: ManifestDeps,
  method: string,
  path: string,
  body?: string,
): Promise<string> {
  const init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  } = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = body;
  }
  let res: FetchResponseLike;
  try {
    res = await fetchFn(deps)(`${registryBaseUrl(deps)}${path}`, init);
  } catch {
    throw new Error("amp registry unreachable");
  }
  if (!is2xx(res.status)) {
    throw new Error(`amp registry error: HTTP ${res.status}`);
  }
  return res.text();
}

/** Submit an API origin to the public AMP registry. */
export async function submitApiToAmpRegistry(
  args: SubmitApiArgs,
  deps: ManifestDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const host = normalizeHost(a.domain);
  const body = JSON.stringify({ origin: `https://${host}` });
  return callRegistry(deps, "POST", "/listings/submit", body);
}

/** Poll a registry submission's validation and listing progress. */
export async function checkAmpSubmissionStatus(
  args: CheckSubmissionStatusArgs,
  deps: ManifestDeps = {},
): Promise<string> {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  const id = a.submission_id;
  if (typeof id !== "string" || id === "") {
    throw new Error("submission_id must be a non-empty string");
  }
  return callRegistry(
    deps,
    "GET",
    `/listings/submit/${encodeURIComponent(id)}/status`,
  );
}

/* ------------------------------------------------------------------ */
/* check_agent_permissions                                             */
/* ------------------------------------------------------------------ */

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

interface DeclaredEndpoint {
  /** The endpoint object as it should be reported in matched_endpoint. */
  raw: Record<string, unknown>;
  method?: string;
  path?: string;
}

function endpointPathOf(record: Record<string, unknown>): string | undefined {
  for (const key of ["path", "url", "route"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function endpointMethodOf(record: Record<string, unknown>): string | undefined {
  const value = record.method;
  return typeof value === "string" && value !== ""
    ? value.toUpperCase()
    : undefined;
}

/** Read a manifest's declared endpoints tolerantly, per the spec. */
function declaredEndpoints(
  manifest: Record<string, unknown>,
): DeclaredEndpoint[] {
  const out: DeclaredEndpoint[] = [];
  const endpoints = manifest.endpoints;
  if (Array.isArray(endpoints)) {
    for (const item of endpoints) {
      if (!isRecord(item)) continue;
      out.push({
        raw: item,
        method: endpointMethodOf(item),
        path: endpointPathOf(item),
      });
    }
  } else if (isRecord(endpoints)) {
    for (const [key, value] of Object.entries(endpoints)) {
      const record = isRecord(value) ? value : {};
      out.push({
        raw: { ...record, path: key },
        method: endpointMethodOf(record),
        path: key,
      });
    }
  }
  return out.filter((endpoint) => endpoint.path !== undefined);
}

/** Reduce a declared or requested path to a comparable path string. */
function comparablePath(raw: string): string {
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* keep the raw string */
    }
  }
  path = path.split(/[?#]/)[0];
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

/** Equal segments, or the declared segment is a `{...}` template. */
function pathMatches(declared: string, actual: string): boolean {
  const declaredSegs = comparablePath(declared).split("/");
  const actualSegs = comparablePath(actual).split("/");
  if (declaredSegs.length !== actualSegs.length) return false;
  return declaredSegs.every((seg, i) => {
    if (seg === actualSegs[i]) return true;
    return seg.startsWith("{") && seg.endsWith("}");
  });
}

function declaresAuthRequired(
  endpoint: Record<string, unknown>,
  manifest: Record<string, unknown>,
): boolean {
  for (const source of [endpoint, manifest]) {
    if (source.auth_required === true || source.requires_auth === true) {
      return true;
    }
    for (const key of ["auth", "authentication"]) {
      const value = source[key];
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === "string") {
        if (value !== "" && value.toLowerCase() !== "none") return true;
      } else if (typeof value === "object") {
        if ((value as Record<string, unknown>).required === false) continue;
        return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

function isNonFreePrice(value: unknown): boolean {
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text !== "" && text !== "free" && text !== "0";
  }
  return false;
}

function declaresPayment(
  endpoint: Record<string, unknown>,
  manifest: Record<string, unknown>,
): boolean {
  for (const source of [endpoint, manifest]) {
    if (source.payment !== undefined && source.payment !== null && source.payment !== false) {
      return true;
    }
    if (source.pricing !== undefined && source.pricing !== null && source.pricing !== false) {
      return true;
    }
    if (isNonFreePrice(source.price)) return true;
  }
  return false;
}

const RESTRICTION_PHRASES = ["not for", "do not", "prohibited", "only for"];

function hasUsageRestriction(manifest: Record<string, unknown>): boolean {
  const notes = manifest.agent_notes;
  const texts: string[] = [];
  if (typeof notes === "string") texts.push(notes);
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (typeof note === "string") texts.push(note);
    }
  }
  const haystack = texts.join("\n").toLowerCase();
  return RESTRICTION_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * Check an intended HTTP operation against a manifest's
 * declared endpoints and constraints. Pure computation over
 * the given manifest; no request is made.
 */
export function evaluateAgentPermissions(
  args: CheckAgentPermissionsArgs,
): PermissionResult {
  const a = (args ?? {}) as unknown as Record<string, unknown>;
  if (typeof a.action !== "string" || a.action.trim() === "") {
    throw new Error("action must be a non-empty string");
  }
  if (!isRecord(a.manifest)) {
    throw new Error("manifest must be an object");
  }
  const manifest = a.manifest;
  const parsed = /^([A-Za-z]+)\s+(\S+)$/.exec(a.action.trim());
  if (!parsed || !HTTP_METHODS.has(parsed[1].toUpperCase())) {
    return {
      verdict: "unknown",
      findings: [
        {
          code: "unparseable_action",
          message: `could not parse action: ${a.action}`,
        },
      ],
    };
  }
  const method = parsed[1].toUpperCase();
  const actionPath = parsed[2];

  const endpoints = declaredEndpoints(manifest);
  if (endpoints.length === 0) {
    return {
      verdict: "unknown",
      findings: [
        {
          code: "no_endpoints_declared",
          message: "manifest declares no readable endpoints",
        },
      ],
    };
  }

  const matched = endpoints.find(
    (endpoint) =>
      pathMatches(endpoint.path as string, actionPath) &&
      (endpoint.method === undefined || endpoint.method === method),
  );
  if (!matched) {
    return {
      verdict: "violation",
      findings: [
        {
          code: "endpoint_not_declared",
          message: `no declared endpoint matches ${method} ${comparablePath(actionPath)}`,
        },
      ],
    };
  }

  const findings: PermissionFinding[] = [];
  let violation = false;
  if (
    a.intends_unauthenticated === true &&
    declaresAuthRequired(matched.raw, manifest)
  ) {
    findings.push({
      code: "auth_required",
      message:
        "the matched endpoint requires authentication but the action intends to run unauthenticated",
    });
    violation = true;
  }
  if (a.payment_onboarded !== true && declaresPayment(matched.raw, manifest)) {
    findings.push({
      code: "payment_onboarding",
      message:
        "the matched endpoint declares payment terms but payment onboarding is not complete",
    });
  }
  if (hasUsageRestriction(manifest)) {
    findings.push({
      code: "agent_notes_usage_restriction",
      message: "the manifest's agent_notes contain usage-restriction language",
    });
  }
  const verdict = violation
    ? "violation"
    : findings.length > 0
      ? "warning"
      : "compliant";
  return { verdict, findings, matched_endpoint: matched.raw };
}

/** Check an intended HTTP operation against a manifest's declared endpoints and constraints. */
export async function checkAgentPermissions(
  args: CheckAgentPermissionsArgs,
  _deps: ManifestDeps = {},
): Promise<string> {
  return JSON.stringify(evaluateAgentPermissions(args));
}
