import type { WebSearchAdapter, WebSearchProviderConfig, WebSearchResult } from "../types.js";

function deepGet(value: unknown, pathValue: string | undefined): unknown {
  if (!pathValue) {
    return value;
  }

  return pathValue
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current && typeof current === "object" && segment in current) {
        return (current as Record<string, unknown>)[segment];
      }
      return undefined;
    }, value);
}

function envOrUndefined(name?: string): string | undefined {
  return name ? process.env[name] : undefined;
}

export class HttpJsonWebSearchAdapter implements WebSearchAdapter {
  public readonly type = "http-json" as const;

  public constructor(
    public readonly id: string,
    private readonly config: WebSearchProviderConfig
  ) {}

  public async search(query: string, limit = 5): Promise<WebSearchResult[]> {
    if (!this.config.endpoint) {
      throw new Error(`Web search provider ${this.id} is missing an endpoint.`);
    }

    const method = this.config.method ?? "GET";
    const queryParam = this.config.queryParam ?? "q";
    const limitParam = this.config.limitParam ?? "limit";
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.config.headers
    };

    const apiKey = envOrUndefined(this.config.apiKeyEnv);
    if (apiKey) {
      headers[this.config.apiKeyHeader ?? "Authorization"] = `${this.config.apiKeyPrefix ?? "Bearer "}${apiKey}`;
    }

    const endpoint = new URL(this.config.endpoint);
    let body: string | undefined;
    if (method === "GET") {
      endpoint.searchParams.set(queryParam, query);
      endpoint.searchParams.set(limitParam, String(limit));
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({
        [queryParam]: query,
        [limitParam]: limit
      });
    }

    const response = await fetch(endpoint, {
      method,
      headers,
      body
    });

    if (!response.ok) {
      throw new Error(`Web search provider ${this.id} failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    const rawResults = deepGet(payload, this.config.resultsPath ?? "results");
    if (!Array.isArray(rawResults)) {
      return [];
    }

    return rawResults
      .map((item) => {
        const title = deepGet(item, this.config.titleField ?? "title");
        const url = deepGet(item, this.config.urlField ?? "url");
        const snippet = deepGet(item, this.config.snippetField ?? "snippet");
        if (typeof title !== "string" || typeof url !== "string") {
          return null;
        }
        return {
          title,
          url,
          snippet: typeof snippet === "string" ? snippet : ""
        } satisfies WebSearchResult;
      })
      .filter((item): item is WebSearchResult => item !== null);
  }
}
