import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAgentPermissions,
  checkAmpSubmissionStatus,
  evaluateAgentPermissions,
  fetchManifestByDomain,
  normalizeHost,
  submitApiToAmpRegistry,
  validateManifestSyntax,
} from "../src/manifest.js";
import type { FetchFn, ManifestDeps } from "../src/types.js";

/**
 * Every test runs against an injected fake fetch and an
 * injected env: no live network, no live call is made.
 * The CLI tests spawn the real CLI through tsx; they only
 * exercise the offline tools and validation failures.
 */

type Captured = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function makeFetch(
  handler: (url: string) => { status?: number; body: unknown },
  captured: Captured[] = [],
): FetchFn {
  return async (url, init) => {
    captured.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const r = handler(url);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

const okFetch = (body: unknown = { ok: true }, captured: Captured[] = []) =>
  makeFetch(() => ({ body }), captured);

const throwingFetch: FetchFn = async () => {
  throw new Error("connection refused");
};

function deps(fetchFn: FetchFn, extra: Partial<ManifestDeps> = {}): ManifestDeps {
  return { fetchFn, env: {}, ...extra };
}

async function expectError(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal(err instanceof Error ? err.message : String(err), message);
    return true;
  });
}

const parse = (text: string) => JSON.parse(text) as Record<string, never>;

describe("normalizeHost", () => {
  it("strips scheme, path and query, and lowercases", () => {
    assert.equal(
      normalizeHost("HTTPS://API.Example.com/v1/things?x=1"),
      "api.example.com",
    );
  });

  it("accepts a bare host unchanged apart from case", () => {
    assert.equal(normalizeHost("Example.ORG"), "example.org");
  });

  it("rejects empty, non-string and host-less input", () => {
    for (const bad of ["", "   ", "https://", 42, undefined, null]) {
      assert.throws(
        () => normalizeHost(bad),
        /domain must be a non-empty string/,
      );
    }
  });
});

describe("fetch_manifest_by_domain", () => {
  const manifest = { spec_version: "agentmanifest-0.3", name: "My API" };

  it("returns the manifest from the first well-known URL when it answers", async () => {
    const captured: Captured[] = [];
    const out = parse(
      await fetchManifestByDomain(
        { domain: "api.example.com" },
        deps(okFetch(manifest, captured)),
      ),
    );
    assert.deepEqual(out.manifest, manifest);
    assert.equal(
      out.manifest_url,
      "https://api.example.com/.well-known/agent-manifest.json",
    );
    assert.equal(out.origin, "https://api.example.com");
    assert.deepEqual(out.tried_urls, [
      "https://api.example.com/.well-known/agent-manifest.json",
    ]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "GET");
  });

  it("tries the second well-known URL after a first miss", async () => {
    const captured: Captured[] = [];
    const fetchFn = makeFetch(
      (url) =>
        url.endsWith("/.well-known/amp.json")
          ? { body: manifest }
          : { status: 404, body: "nope" },
      captured,
    );
    const out = parse(
      await fetchManifestByDomain({ domain: "api.example.com" }, deps(fetchFn)),
    );
    assert.equal(
      out.manifest_url,
      "https://api.example.com/.well-known/amp.json",
    );
    assert.deepEqual(out.tried_urls, [
      "https://api.example.com/.well-known/agent-manifest.json",
      "https://api.example.com/.well-known/amp.json",
    ]);
  });

  it("treats a throwing fetch on a candidate as a miss and moves on", async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(manifest),
      };
    };
    const out = parse(
      await fetchManifestByDomain({ domain: "api.example.com" }, deps(fetchFn)),
    );
    assert.equal(
      out.manifest_url,
      "https://api.example.com/.well-known/amp.json",
    );
    assert.equal(calls, 2);
  });

  it("fails with the pinned message after all three URLs miss, in order", async () => {
    const captured: Captured[] = [];
    const fetchFn = makeFetch(() => ({ status: 404, body: "nope" }), captured);
    await expectError(
      fetchManifestByDomain({ domain: "api.example.com" }, deps(fetchFn)),
      "no AMP manifest found for api.example.com (tried 3 URLs)",
    );
    assert.deepEqual(
      captured.map((c) => c.url),
      [
        "https://api.example.com/.well-known/agent-manifest.json",
        "https://api.example.com/.well-known/amp.json",
        "https://api.example.com/agent-manifest.json",
      ],
    );
  });

  it("normalizes a full URL down to its host before probing", async () => {
    const captured: Captured[] = [];
    await fetchManifestByDomain(
      { domain: "https://API.Example.com/some/path" },
      deps(okFetch(manifest, captured)),
    );
    assert.equal(
      captured[0].url,
      "https://api.example.com/.well-known/agent-manifest.json",
    );
  });

  it("rejects an empty domain before any request", async () => {
    const captured: Captured[] = [];
    await expectError(
      fetchManifestByDomain({ domain: "" }, deps(okFetch({}, captured))),
      "domain must be a non-empty string",
    );
    assert.deepEqual(captured, []);
  });
});

describe("validate_manifest_syntax", () => {
  it("accepts a valid 0.3 manifest and issues the success token", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: { spec_version: "agentmanifest-0.3", name: "My API" },
      }),
    );
    assert.equal(out.valid, true);
    assert.equal(out.success_token, "amp-schema-valid:agentmanifest-0.3:My API");
  });

  it("accepts a valid 0.2 manifest", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: { spec_version: "agentmanifest-0.2", name: "Old API" },
      }),
    );
    assert.equal(out.valid, true);
    assert.equal(out.success_token, "amp-schema-valid:agentmanifest-0.2:Old API");
  });

  it("accepts the JSON-string form of a manifest", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: '{"spec_version":"agentmanifest-0.3","name":"Str API"}',
      }),
    );
    assert.equal(out.valid, true);
    assert.equal(out.success_token, "amp-schema-valid:agentmanifest-0.3:Str API");
  });

  it("reports an unparseable string as a validation failure, not an error", async () => {
    const out = parse(
      await validateManifestSyntax({ manifest: "{not json" }),
    );
    assert.equal(out.valid, false);
    assert.equal((out.errors as unknown[]).length, 1);
    assert.equal(
      (out.errors as { message: string }[])[0].message,
      "manifest string is not valid JSON",
    );
  });

  it("reports a JSON string that does not hold an object as invalid", async () => {
    const out = parse(await validateManifestSyntax({ manifest: "42" }));
    assert.equal(out.valid, false);
    assert.equal(
      (out.errors as { message: string }[])[0].message,
      "manifest must be a JSON object",
    );
  });

  it("flags a missing spec_version", async () => {
    const out = parse(
      await validateManifestSyntax({ manifest: { name: "My API" } }),
    );
    assert.equal(out.valid, false);
    const errors = out.errors as { path: string; message: string }[];
    assert.equal(errors[0].path, "spec_version");
  });

  it("flags an unsupported spec_version", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: { spec_version: "agentmanifest-9.9", name: "My API" },
      }),
    );
    assert.equal(out.valid, false);
    const errors = out.errors as { path: string; message: string }[];
    assert.deepEqual(errors[0], {
      path: "spec_version",
      message: "spec_version must be agentmanifest-0.2 or agentmanifest-0.3",
    });
  });

  it("flags a missing name and an empty name", async () => {
    const missing = parse(
      await validateManifestSyntax({
        manifest: { spec_version: "agentmanifest-0.3" },
      }),
    );
    assert.equal((missing.errors as { path: string }[])[0].path, "name");
    const empty = parse(
      await validateManifestSyntax({
        manifest: { spec_version: "agentmanifest-0.3", name: "" },
      }),
    );
    assert.equal(
      (empty.errors as { message: string }[])[0].message,
      "name must be a non-empty string",
    );
  });

  it("flags endpoints that are not an array", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: {
          spec_version: "agentmanifest-0.3",
          name: "My API",
          endpoints: { "/x": {} },
        },
      }),
    );
    assert.equal(out.valid, false);
    assert.equal((out.errors as { path: string }[])[0].path, "endpoints");
  });

  it("flags an endpoint without a string path, url, or route", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: {
          spec_version: "agentmanifest-0.3",
          name: "My API",
          endpoints: [{ method: "GET" }],
        },
      }),
    );
    assert.equal(out.valid, false);
    assert.equal(
      (out.errors as { path: string }[])[0].path,
      "endpoints[0]",
    );
  });

  it("accepts endpoints carrying a route string", async () => {
    const out = parse(
      await validateManifestSyntax({
        manifest: {
          spec_version: "agentmanifest-0.3",
          name: "My API",
          endpoints: [{ route: "GET /things" }, { url: "https://x.test/y" }],
        },
      }),
    );
    assert.equal(out.valid, true);
  });

  it("rejects a manifest that is neither object nor string, with no request implied", async () => {
    await expectError(
      validateManifestSyntax({ manifest: 42 }),
      "manifest must be an object or a JSON string",
    );
    await expectError(
      validateManifestSyntax({} as never),
      "manifest must be an object or a JSON string",
    );
    await expectError(
      validateManifestSyntax({ manifest: null }),
      "manifest must be an object or a JSON string",
    );
  });
});

describe("submit_api_to_amp_registry", () => {
  it("posts the derived origin to /listings/submit and returns the reply verbatim", async () => {
    const captured: Captured[] = [];
    const raw = '{ "submission_id" : "sub_1",  "status": "queued" }';
    const out = await submitApiToAmpRegistry(
      { domain: "api.example.com" },
      deps(okFetch(raw, captured)),
    );
    assert.equal(out, raw);
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].url,
      "https://api.agent-manifest.com/listings/submit",
    );
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].body, '{"origin":"https://api.example.com"}');
    assert.equal(
      captured[0].headers?.["Content-Type"],
      "application/json",
    );
  });

  it("normalizes the domain before deriving the origin", async () => {
    const captured: Captured[] = [];
    await submitApiToAmpRegistry(
      { domain: "HTTPS://API.Example.com/some/path" },
      deps(okFetch({}, captured)),
    );
    assert.equal(captured[0].body, '{"origin":"https://api.example.com"}');
  });

  it("honours AMP_REGISTRY_BASE_URL and an injected baseUrl", async () => {
    const captured: Captured[] = [];
    await submitApiToAmpRegistry(
      { domain: "api.example.com" },
      {
        fetchFn: okFetch({}, captured),
        env: { AMP_REGISTRY_BASE_URL: "https://registry.example.test/" },
      },
    );
    assert.equal(
      captured[0].url,
      "https://registry.example.test/listings/submit",
    );
    const captured2: Captured[] = [];
    await submitApiToAmpRegistry(
      { domain: "api.example.com" },
      deps(okFetch({}, captured2), { baseUrl: "https://reg2.example.test" }),
    );
    assert.equal(
      captured2[0].url,
      "https://reg2.example.test/listings/submit",
    );
  });

  it("maps a non-2xx reply to amp registry error: HTTP <status>", async () => {
    const fetchFn = makeFetch(() => ({ status: 502, body: "bad gateway" }));
    await expectError(
      submitApiToAmpRegistry({ domain: "api.example.com" }, deps(fetchFn)),
      "amp registry error: HTTP 502",
    );
  });

  it("maps a throwing fetch to amp registry unreachable", async () => {
    await expectError(
      submitApiToAmpRegistry({ domain: "api.example.com" }, deps(throwingFetch)),
      "amp registry unreachable",
    );
  });

  it("rejects an empty domain before any request", async () => {
    const captured: Captured[] = [];
    await expectError(
      submitApiToAmpRegistry({ domain: "" }, deps(okFetch({}, captured))),
      "domain must be a non-empty string",
    );
    assert.deepEqual(captured, []);
  });
});

describe("check_amp_submission_status", () => {
  it("gets /listings/submit/{id}/status and returns the reply verbatim", async () => {
    const captured: Captured[] = [];
    const raw = '{ "status" : "listed" }';
    const out = await checkAmpSubmissionStatus(
      { submission_id: "sub_123" },
      deps(okFetch(raw, captured)),
    );
    assert.equal(out, raw);
    assert.equal(
      captured[0].url,
      "https://api.agent-manifest.com/listings/submit/sub_123/status",
    );
    assert.equal(captured[0].method, "GET");
  });

  it("URL-encodes the submission id", async () => {
    const captured: Captured[] = [];
    await checkAmpSubmissionStatus(
      { submission_id: "a/b" },
      deps(okFetch({}, captured)),
    );
    assert.equal(
      captured[0].url,
      "https://api.agent-manifest.com/listings/submit/a%2Fb/status",
    );
  });

  it("maps a non-2xx reply to amp registry error: HTTP <status>", async () => {
    const fetchFn = makeFetch(() => ({ status: 404, body: "gone" }));
    await expectError(
      checkAmpSubmissionStatus({ submission_id: "sub_x" }, deps(fetchFn)),
      "amp registry error: HTTP 404",
    );
  });

  it("rejects an empty submission_id before any request", async () => {
    const captured: Captured[] = [];
    await expectError(
      checkAmpSubmissionStatus(
        { submission_id: "" },
        deps(okFetch({}, captured)),
      ),
      "submission_id must be a non-empty string",
    );
    assert.deepEqual(captured, []);
  });
});

describe("check_agent_permissions", () => {
  const bakingManifest = {
    spec_version: "agentmanifest-0.3",
    name: "Baking API",
    endpoints: [{ method: "POST", path: "/baking/validate-mix" }],
  };

  it("returns compliant with the matched endpoint when nothing constrains the action", () => {
    const out = evaluateAgentPermissions({
      action: "POST /baking/validate-mix",
      manifest: bakingManifest,
    });
    assert.equal(out.verdict, "compliant");
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.matched_endpoint, {
      method: "POST",
      path: "/baking/validate-mix",
    });
  });

  it("returns violation with endpoint_not_declared when no route matches", () => {
    const out = evaluateAgentPermissions({
      action: "GET /secret/admin",
      manifest: bakingManifest,
    });
    assert.equal(out.verdict, "violation");
    assert.equal(out.findings[0].code, "endpoint_not_declared");
    assert.equal("matched_endpoint" in out, false);
  });

  it("does not match a declared route under a different method", () => {
    const out = evaluateAgentPermissions({
      action: "GET /baking/validate-mix",
      manifest: bakingManifest,
    });
    assert.equal(out.verdict, "violation");
    assert.equal(out.findings[0].code, "endpoint_not_declared");
  });

  it("returns violation with auth_required when the route needs auth and the action is unauthenticated", () => {
    const out = evaluateAgentPermissions({
      action: "POST /mix",
      manifest: {
        endpoints: [{ method: "POST", path: "/mix", auth: "bearer" }],
      },
      intends_unauthenticated: true,
    });
    assert.equal(out.verdict, "violation");
    assert.equal(out.findings[0].code, "auth_required");
    assert.ok(out.matched_endpoint);
  });

  it("honours manifest-level authentication declarations", () => {
    const out = evaluateAgentPermissions({
      action: "GET /mix",
      manifest: {
        authentication: { type: "oauth2" },
        endpoints: [{ method: "GET", path: "/mix" }],
      },
      intends_unauthenticated: true,
    });
    assert.equal(out.verdict, "violation");
    assert.equal(out.findings[0].code, "auth_required");
  });

  it("is compliant on an auth route when the action does not intend to run unauthenticated", () => {
    const out = evaluateAgentPermissions({
      action: "POST /mix",
      manifest: {
        endpoints: [{ method: "POST", path: "/mix", auth: "bearer" }],
      },
    });
    assert.equal(out.verdict, "compliant");
  });

  it('treats an auth declaration of "none" as no requirement', () => {
    const out = evaluateAgentPermissions({
      action: "GET /open",
      manifest: {
        endpoints: [{ method: "GET", path: "/open", auth: "none" }],
      },
      intends_unauthenticated: true,
    });
    assert.equal(out.verdict, "compliant");
  });

  it("returns warning with payment_onboarding when the route declares payment terms", () => {
    const out = evaluateAgentPermissions({
      action: "POST /buy",
      manifest: {
        endpoints: [{ method: "POST", path: "/buy", price: "$5" }],
      },
    });
    assert.equal(out.verdict, "warning");
    assert.deepEqual(
      out.findings.map((f) => f.code),
      ["payment_onboarding"],
    );
  });

  it("is compliant on a priced route once payment is onboarded", () => {
    const out = evaluateAgentPermissions({
      action: "POST /buy",
      manifest: {
        pricing: { model: "per-call" },
        endpoints: [{ method: "POST", path: "/buy" }],
      },
      payment_onboarded: true,
    });
    assert.equal(out.verdict, "compliant");
  });

  it("keeps the verdict at violation when auth and payment findings combine", () => {
    const out = evaluateAgentPermissions({
      action: "POST /buy",
      manifest: {
        endpoints: [
          { method: "POST", path: "/buy", auth: "bearer", payment: "stripe" },
        ],
      },
      intends_unauthenticated: true,
    });
    assert.equal(out.verdict, "violation");
    assert.deepEqual(
      out.findings.map((f) => f.code),
      ["auth_required", "payment_onboarding"],
    );
  });

  it("returns warning with agent_notes_usage_restriction for restriction language in a string note", () => {
    const out = evaluateAgentPermissions({
      action: "POST /baking/validate-mix",
      manifest: {
        ...bakingManifest,
        agent_notes: "Do not use this API for scraping.",
      },
    });
    assert.equal(out.verdict, "warning");
    assert.deepEqual(
      out.findings.map((f) => f.code),
      ["agent_notes_usage_restriction"],
    );
  });

  it("reads agent_notes given as an array", () => {
    const out = evaluateAgentPermissions({
      action: "POST /baking/validate-mix",
      manifest: {
        ...bakingManifest,
        agent_notes: ["Be gentle with rate limits", "Only for registered partners"],
      },
    });
    assert.equal(out.verdict, "warning");
    assert.equal(out.findings[0].code, "agent_notes_usage_restriction");
  });

  it("ignores benign agent_notes", () => {
    const out = evaluateAgentPermissions({
      action: "POST /baking/validate-mix",
      manifest: { ...bakingManifest, agent_notes: "Welcome, agents." },
    });
    assert.equal(out.verdict, "compliant");
  });

  it("returns unknown with unparseable_action when the action has no HTTP method", () => {
    const out = evaluateAgentPermissions({
      action: "validate the mix please",
      manifest: bakingManifest,
    });
    assert.equal(out.verdict, "unknown");
    assert.equal(out.findings[0].code, "unparseable_action");
  });

  it("returns unknown with unparseable_action for an unknown method token", () => {
    const out = evaluateAgentPermissions({
      action: "FETCH /baking/validate-mix",
      manifest: bakingManifest,
    });
    assert.equal(out.verdict, "unknown");
    assert.equal(out.findings[0].code, "unparseable_action");
  });

  it("returns unknown with no_endpoints_declared (not endpoint_not_declared) when the manifest declares nothing readable", () => {
    const out = evaluateAgentPermissions({
      action: "GET /anything",
      manifest: { name: "Empty API" },
    });
    assert.equal(out.verdict, "unknown");
    assert.equal(out.findings[0].code, "no_endpoints_declared");
  });

  it("matches a declared {id} template segment against a concrete segment", () => {
    const out = evaluateAgentPermissions({
      action: "GET /items/42",
      manifest: { endpoints: [{ method: "GET", path: "/items/{id}" }] },
    });
    assert.equal(out.verdict, "compliant");
    assert.deepEqual(out.matched_endpoint, {
      method: "GET",
      path: "/items/{id}",
    });
  });

  it("does not let a template match a different segment count", () => {
    const out = evaluateAgentPermissions({
      action: "GET /items/42",
      manifest: {
        endpoints: [{ method: "GET", path: "/items/{id}/history" }],
      },
    });
    assert.equal(out.verdict, "violation");
    assert.equal(out.findings[0].code, "endpoint_not_declared");
  });

  it("reads endpoints given as an object keyed by path", () => {
    const out = evaluateAgentPermissions({
      action: "GET /things",
      manifest: { endpoints: { "/things": { method: "GET" } } },
    });
    assert.equal(out.verdict, "compliant");
  });

  it("validates action and manifest before evaluating", () => {
    assert.throws(
      () => evaluateAgentPermissions({ action: "", manifest: {} }),
      /action must be a non-empty string/,
    );
    assert.throws(
      () =>
        evaluateAgentPermissions({
          action: "GET /x",
          manifest: "not-an-object" as never,
        }),
      /manifest must be an object/,
    );
    assert.throws(
      () =>
        evaluateAgentPermissions({
          action: "GET /x",
          manifest: [] as never,
        }),
      /manifest must be an object/,
    );
  });

  it("the async tool wrapper returns the same result as JSON text", async () => {
    const out = parse(
      await checkAgentPermissions({
        action: "POST /baking/validate-mix",
        manifest: bakingManifest,
      }),
    );
    assert.equal(out.verdict, "compliant");
    assert.deepEqual(out.findings, []);
  });
});

describe("CLI", () => {
  function runCli(args: string[]) {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    return spawnSync(
      join(root, "node_modules", ".bin", "tsx"),
      ["src/cli.ts", ...args],
      { cwd: root, encoding: "utf8" },
    );
  }

  it("prints the version and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("exits 2 with usage for an unknown subcommand", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage/);
  });

  it("exits 2 with usage when no subcommand is given", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage/);
  });

  it("exits 2 for a non-JSON argument string", () => {
    const res = runCli(["validate_manifest_syntax", "not json"]);
    assert.equal(res.status, 2);
  });

  it("exits 2 when more than one argument string is given", () => {
    const res = runCli(["validate_manifest_syntax", "{}", "{}"]);
    assert.equal(res.status, 2);
  });

  it("runs validate_manifest_syntax offline and prints its JSON", () => {
    const res = runCli([
      "validate_manifest_syntax",
      '{"manifest":{"spec_version":"agentmanifest-0.3","name":"My API"}}',
    ]);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout) as { valid: boolean; success_token: string };
    assert.equal(out.valid, true);
    assert.equal(out.success_token, "amp-schema-valid:agentmanifest-0.3:My API");
  });

  it("exits 1 on a runtime validation failure", () => {
    const res = runCli(["fetch_manifest_by_domain", '{"domain":""}']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /domain must be a non-empty string/);
  });
});
