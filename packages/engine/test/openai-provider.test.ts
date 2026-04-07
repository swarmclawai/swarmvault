import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiCompatibleProviderAdapter } from "../src/providers/openai-compatible.js";

const resultSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.string(),
      code: z.string(),
      message: z.string(),
      suggestedQuery: z.string().optional()
    })
  )
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAiCompatibleProviderAdapter.generateStructured", () => {
  it("uses JSON mode for OpenAI responses API structured requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ findings: [{ severity: "info", code: "ok", message: "works" }] })
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProviderAdapter("live", "openai", "gpt-4o-mini", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      apiStyle: "responses",
      capabilities: ["responses", "chat", "structured"]
    });

    const result = await provider.generateStructured(
      {
        system: "Return findings.",
        prompt: "Audit this vault."
      },
      resultSchema
    );

    expect(result.findings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeTruthy();
    const [url, init] = call as unknown as [string, RequestInit | undefined];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.body).toBeTruthy();
    const payload = JSON.parse(String(init?.body));
    expect(payload.text).toEqual({
      format: expect.objectContaining({
        type: "json_schema",
        name: "swarmvault_response",
        strict: true
      })
    });
    expect(payload.text.format.schema.$schema).toBeUndefined();
    expect(payload.text.format.schema.properties.findings.items.required).toEqual(["severity", "code", "message", "suggestedQuery"]);
    expect(payload.text.format.schema.properties.findings.items.properties.suggestedQuery.type).toEqual(["string", "null"]);
  });

  it("uses JSON mode for OpenAI chat structured requests", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ findings: [{ severity: "info", code: "ok", message: "works" }] })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProviderAdapter("live", "openai", "gpt-4o-mini", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      apiStyle: "chat",
      capabilities: ["responses", "chat", "structured"]
    });

    const result = await provider.generateStructured(
      {
        system: "Return findings.",
        prompt: "Audit this vault."
      },
      resultSchema
    );

    expect(result.findings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeTruthy();
    const [url, init] = call as unknown as [string, RequestInit | undefined];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.body).toBeTruthy();
    const payload = JSON.parse(String(init?.body));
    expect(payload.response_format).toEqual({
      type: "json_schema",
      json_schema: expect.objectContaining({
        type: "json_schema",
        name: "swarmvault_response",
        strict: true
      })
    });
    expect(payload.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(payload.response_format.json_schema.schema.properties.findings.items.required).toEqual([
      "severity",
      "code",
      "message",
      "suggestedQuery"
    ]);
    expect(payload.response_format.json_schema.schema.properties.findings.items.properties.suggestedQuery.type).toEqual(["string", "null"]);
  });

  it("strips null placeholders for optional OpenAI fields before Zod parsing", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      findings: [{ severity: "info", code: "ok", message: "works", suggestedQuery: null }]
                    })
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProviderAdapter("live", "openai", "gpt-4o-mini", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      apiStyle: "responses",
      capabilities: ["responses", "chat", "structured"]
    });

    const result = await provider.generateStructured(
      {
        system: "Return findings.",
        prompt: "Audit this vault."
      },
      resultSchema
    );

    expect(result.findings).toEqual([{ severity: "info", code: "ok", message: "works" }]);
  });
});
