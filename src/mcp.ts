/**
 * manifestlens MCP server. Tools: fetch_manifest_by_domain,
 * validate_manifest_syntax, submit_api_to_amp_registry,
 * check_amp_submission_status, check_agent_permissions.
 *
 * Why the low-level Server instead of McpServer: the
 * high-level helper converts zod schemas to JSON Schema and
 * injects keys that are not in this tool set's documented
 * spec ("$schema" and "additionalProperties"), which breaks
 * exact tool-list/schema parity with the spec. This file
 * serves tools/list with the spec's exact input schemas as
 * explicit literals, and the core validates every tools/call
 * argument set itself.
 *
 * Every tool returns a single text item carrying its JSON
 * result (or, for the registry tools, the upstream JSON
 * verbatim); validation and upstream failures come back as
 * isError results carrying the documented error strings.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  checkAgentPermissions,
  checkAmpSubmissionStatus,
  fetchManifestByDomain,
  submitApiToAmpRegistry,
  validateManifestSyntax,
  VERSION,
} from "./manifest.js";

const TOOLS = [
  {
    name: "fetch_manifest_by_domain",
    description:
      "Fetches and parses an Agent Manifest from an API origin's well-known locations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string" , description: "Domain this call applies to." },
      },
      required: ["domain"],
    },
  },
  {
    name: "validate_manifest_syntax",
    description:
      "Validates a manifest object or JSON string against the AMP schema rules for agentmanifest-0.2/0.3.",
    inputSchema: {
      type: "object" as const,
      properties: {
        manifest: { type: ["object", "string"] , description: "The manifest for this call." },
      },
      required: ["manifest"],
    },
  },
  {
    name: "submit_api_to_amp_registry",
    description:
      "Submits an API origin to the public AMP registry after its manifest is live.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string" , description: "Domain this call applies to." },
      },
      required: ["domain"],
    },
  },
  {
    name: "check_amp_submission_status",
    description:
      "Polls an AMP registry submission's validation and listing progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        submission_id: { type: "string" , description: "The submission identifier for this call." },
      },
      required: ["submission_id"],
    },
  },
  {
    name: "check_agent_permissions",
    description:
      "Checks an intended HTTP operation against a manifest's declared endpoints and constraints.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string" , description: "The action for this call." },
        intends_unauthenticated: { type: "boolean" , description: "The intends unauthenticated for this call." },
        manifest: { type: "object" , description: "The manifest for this call." },
        payment_onboarded: { type: "boolean" , description: "The payment onboarded for this call." },
      },
      required: ["action", "manifest"],
    },
  },
];

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "manifestlens", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let out: string;
    switch (name) {
      case "fetch_manifest_by_domain":
        out = await fetchManifestByDomain(a as never);
        break;
      case "validate_manifest_syntax":
        out = await validateManifestSyntax(a as never);
        break;
      case "submit_api_to_amp_registry":
        out = await submitApiToAmpRegistry(a as never);
        break;
      case "check_amp_submission_status":
        out = await checkAmpSubmissionStatus(a as never);
        break;
      case "check_agent_permissions":
        out = await checkAgentPermissions(a as never);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(out);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
