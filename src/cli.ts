#!/usr/bin/env node
/**
 * manifestlens CLI.
 *
 *   manifestlens fetch_manifest_by_domain '<json>'
 *   manifestlens validate_manifest_syntax '<json>'
 *   manifestlens submit_api_to_amp_registry '<json>'
 *   manifestlens check_amp_submission_status '<json>'
 *   manifestlens check_agent_permissions '<json>'
 *   manifestlens mcp
 *   manifestlens --version
 *
 * Each tool subcommand takes one JSON argument string with the
 * tool's arguments and prints the tool's result text. Exit
 * codes: 0 success, 1 runtime error, 2 usage error.
 */
import {
  checkAgentPermissions,
  checkAmpSubmissionStatus,
  fetchManifestByDomain,
  submitApiToAmpRegistry,
  validateManifestSyntax,
  VERSION,
} from "./manifest.js";

const TOOL_NAMES = [
  "fetch_manifest_by_domain",
  "validate_manifest_syntax",
  "submit_api_to_amp_registry",
  "check_amp_submission_status",
  "check_agent_permissions",
] as const;

function usage(): never {
  console.error(`Usage:
  manifestlens <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")}
  manifestlens mcp
  manifestlens --version`);
  process.exit(2);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "fetch_manifest_by_domain":
      return fetchManifestByDomain(args as never);
    case "validate_manifest_syntax":
      return validateManifestSyntax(args as never);
    case "submit_api_to_amp_registry":
      return submitApiToAmpRegistry(args as never);
    case "check_amp_submission_status":
      return checkAmpSubmissionStatus(args as never);
    case "check_agent_permissions":
      return checkAgentPermissions(args as never);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  try {
    const out = await runTool(cmd, args);
    console.log(out);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
