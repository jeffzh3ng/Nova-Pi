import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveStdioCommandSpecs, splitCommandArgs } from "./client.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "host"
  ? path.dirname(process.cwd())
  : process.cwd();
const serviceScript = path.resolve(repositoryRoot, "services", "alert-analysis-mcp", "server.py");

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    serviceId: "alert-analysis-mcp",
    transport: "stdio",
    commandPath: serviceScript,
    commandArgs: "",
    url: "",
    enabled: true,
    launchMode: "script",
    ...overrides,
  };
}

test("splitCommandArgs preserves quoted values without invoking a shell", () => {
  assert.deepEqual(
    splitCommandArgs('--profile "threat analysis" --label \'武汉 告警\''),
    ["--profile", "threat analysis", "--label", "武汉 告警"],
  );
});

test("Python script settings resolve to interpreter candidates with cwd", () => {
  const specs = resolveStdioCommandSpecs(config({ commandArgs: '--mode "stdio compat"' }));
  assert.ok(specs.length >= 2);
  for (const spec of specs) {
    assert.equal(spec.cwd, path.dirname(serviceScript));
    assert.ok(spec.args.includes(serviceScript));
    assert.deepEqual(spec.args.slice(-2), ["--mode", "stdio compat"]);
    assert.match(spec.env?.PYTHONPATH ?? "", /alert-analysis-mcp/);
  }
});

test("Python module settings split module name from extra arguments", () => {
  const serviceDir = path.dirname(serviceScript);
  const specs = resolveStdioCommandSpecs(config({
    commandPath: serviceDir,
    commandArgs: 'server --profile "threat analysis"',
    launchMode: "module",
  }));
  assert.ok(specs.length >= 2);
  for (const spec of specs) {
    const moduleFlag = spec.args.indexOf("-m");
    assert.ok(moduleFlag >= 0);
    assert.deepEqual(spec.args.slice(moduleFlag), ["-m", "server", "--profile", "threat analysis"]);
    assert.equal(spec.cwd, serviceDir);
  }
});
