/** The same injected-transport seam the rest of this series uses. */

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export function httpTransport(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Transport {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = { method: request.method, headers: request.headers, signal: controller.signal };
        if (request.body !== undefined) init.body = request.body;
        const res = await fetchImpl(request.url, init);
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: res.status, headers, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
