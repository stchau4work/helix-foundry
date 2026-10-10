import { it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../apps/api/src/config.js";
import { Provider } from "../apps/api/src/providers.js";
import { ProviderSchema } from "../packages/shared/src/index.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
for (const provider of ["local", "claude", "openai"] as const)
  it(`uses the native ${provider} protocol without fallbacks`, async () => {
    const requests: any[] = [];
    // The local provider talks to Ollama over node:http, not fetch.
    const ollama = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({
        url: req.url,
        body: JSON.parse(body),
        headers: req.headers,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { content: '{"ready":true}' },
          prompt_eval_count: 2,
          eval_count: 3,
          done_reason: "stop",
        }),
      );
    });
    ollama.listen(0, "127.0.0.1");
    await once(ollama, "listening");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init.body),
          headers: init.headers,
        });
        return Response.json(
          provider === "local"
            ? {
                message: { content: '{"ready":true}' },
                prompt_eval_count: 2,
                eval_count: 3,
              }
            : provider === "claude"
              ? {
                  content: [
                    {
                      type: "tool_use",
                      name: "submit",
                      input: { ready: true },
                    },
                  ],
                  usage: { input_tokens: 2, output_tokens: 3 },
                }
              : {
                  output: [
                    {
                      content: [
                        { type: "output_text", text: '{"ready":true}' },
                      ],
                    },
                  ],
                  usage: { total_tokens: 5 },
                },
        );
      }),
    );
    const p = new Provider(
      ProviderSchema.parse({
        provider,
        model: "test",
        apiKey: "test-only",
        baseUrl: "http://127.0.0.1:" + (ollama.address() as any).port,
      }),
    );
    const r = await p.generate(
      "system",
      { safe: "profile" },
      {
        type: "object",
        properties: { ready: { type: "boolean" } },
        required: ["ready"],
        additionalProperties: false,
      },
    );
    expect(r).toEqual({ value: { ready: true }, tokens: 5 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain(
      provider === "local"
        ? "/api/chat"
        : provider === "claude"
          ? "/v1/messages"
          : "/v1/responses",
    );
    if (provider === "openai") {
      expect(requests[0].body.store).toBe(false);
      expect(requests[0].body.text.format.strict).toBe(true);
    }
    if (provider === "local")
      expect(requests[0].body.options).toEqual({
        temperature: 0,
        num_ctx: 8192,
        num_predict: expect.any(Number),
      });
    ollama.close();
  });
it("sizes the local context window to the prompt and refuses what cannot fit", async () => {
  const seen: number[] = [];
  const ollama = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const options = JSON.parse(body).options;
    seen.push(options.num_ctx);
    res.end(
      JSON.stringify({
        message: { content: '{"ready":true}' },
        prompt_eval_count: 1,
        eval_count: 1,
        done_reason: options.num_ctx === 16384 ? "length" : "stop",
      }),
    );
  });
  ollama.listen(0, "127.0.0.1");
  await once(ollama, "listening");
  const p = new Provider(
    ProviderSchema.parse({
      provider: "local",
      model: "test",
      baseUrl: "http://127.0.0.1:" + (ollama.address() as any).port,
    }),
  );
  try {
    await expect(
      p.generate("", { data: "x".repeat(20_000) }, {}),
    ).rejects.toThrow("ran out of room");
    expect(seen).toEqual([16384]);
    await expect(
      p.generate("", { data: "x".repeat(200_000) }, {}),
    ).rejects.toThrow("Too much data for the local model");
    expect(seen).toHaveLength(1);
  } finally {
    ollama.close();
  }
});
it("reports provider outage without contacting another provider", async () => {
  const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    new Provider(
      ProviderSchema.parse({
        provider: "openai",
        model: "test",
        apiKey: "test",
      }),
    ).generate("", {}, {}),
  ).rejects.toThrow("HTTP 503");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
// A stand-in for the `claude` CLI: records how it was started, then behaves as told.
async function fakeClaude(behavior: string) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude.cjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
fs.writeFileSync(path.join(__dirname, "pid"), String(process.pid));
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify({
    argv: process.argv.slice(2), input, cwd: process.cwd(), env: process.env, pid: process.pid,
  }));
  ${behavior}
});
`,
  );
  await chmod(bin, 0o755);
  const previous = config.claudeBin;
  config.claudeBin = bin;
  return {
    call: async () =>
      JSON.parse(await readFile(join(dir, "call.json"), "utf8")),
    // Resolves once the fake CLI has started, with its process id.
    started: async () => {
      for (;;) {
        const pid = await readFile(join(dir, "pid"), "utf8").catch(() => "");
        if (pid) return Number(pid);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async dispose() {
      config.claudeBin = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const subscription = () =>
  new Provider(
    ProviderSchema.parse({ provider: "claude-code", model: "opus" }),
  );
const readySchema = {
  type: "object",
  properties: { ready: { type: "boolean" } },
  required: ["ready"],
  additionalProperties: false,
};
it("runs the signed-in Claude Code CLI headless, without tools, project files or secrets", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "would-override-the-subscription");
  vi.stubEnv("ENCRYPTION_KEY", "e".repeat(64));
  const cli = await fakeClaude(
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
      structured_output: { ready: true, extra: null },
      usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } }));`,
  );
  try {
    const r = await subscription().generate(
      "system prompt",
      { safe: "profile" },
      readySchema,
    );
    expect(r).toEqual({ value: { ready: true }, tokens: 20 });
    const call = await cli.call();
    expect(call.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--no-session-persistence",
        "--strict-mcp-config",
      ]),
    );
    const arg = (flag: string) => call.argv[call.argv.indexOf(flag) + 1];
    expect(arg("--output-format")).toBe("json");
    expect(JSON.parse(arg("--json-schema"))).toEqual(readySchema);
    expect(arg("--system-prompt")).toBe("system prompt");
    expect(arg("--model")).toBe("opus");
    expect(arg("--tools")).toBe("");
    expect(arg("--setting-sources")).toBe("");
    expect(call.input).toBe(JSON.stringify({ safe: "profile" }));
    expect(call.cwd).not.toBe(process.cwd());
    await expect(stat(call.cwd)).rejects.toThrow();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.ENCRYPTION_KEY).toBeUndefined();
    expect(call.env.HOME).toBe(process.env.HOME);
  } finally {
    await cli.dispose();
  }
});
it("reports Claude Code errors, such as signing in, without trying another provider", async () => {
  const cli = await fakeClaude(
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true,
      result: "Not logged in · Please run /login" }));`,
  );
  try {
    await expect(subscription().generate("", {}, readySchema)).rejects.toThrow(
      "Claude Code returned an error: Not logged in",
    );
  } finally {
    await cli.dispose();
  }
});
it("explains when the Claude Code CLI is not installed", async () => {
  const previous = config.claudeBin;
  config.claudeBin = join(tmpdir(), "no-such-claude-binary");
  try {
    await expect(subscription().generate("", {}, readySchema)).rejects.toThrow(
      "Claude Code isn't available on this computer",
    );
  } finally {
    config.claudeBin = previous;
  }
});
it("stops the Claude Code process when the request is canceled", async () => {
  const cli = await fakeClaude(`setTimeout(() => {}, 30_000);`);
  try {
    const cancel = new AbortController();
    const pending = subscription().generate("", {}, readySchema, cancel.signal);
    const pid = await cli.started();
    cancel.abort(new Error("Run canceled"));
    await expect(pending).rejects.toThrow("Run canceled");
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await cli.dispose();
  }
});
it("drops the JSON Schema dialect, which the Claude Code CLI rejects", async () => {
  const cli = await fakeClaude(
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
      structured_output: { ready: true }, usage: {} }));`,
  );
  try {
    await subscription().generate(
      "",
      {},
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...readySchema,
      },
    );
    const { argv } = await cli.call();
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1])).toEqual(
      readySchema,
    );
  } finally {
    await cli.dispose();
  }
});
it("shows what the Claude Code CLI printed when it fails", async () => {
  const cli = await fakeClaude(
    `process.stderr.write("Error: --json-schema is not a valid JSON Schema\\n"); process.exit(1);`,
  );
  try {
    await expect(subscription().generate("", {}, readySchema)).rejects.toThrow(
      "Claude Code exited with code 1: Error: --json-schema is not a valid JSON Schema",
    );
  } finally {
    await cli.dispose();
  }
});
