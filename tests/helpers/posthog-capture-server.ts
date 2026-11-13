/** A local stand-in for the PostHog capture endpoint: posthog-node POSTs its
 * (possibly gzipped) /batch payloads here; the test suite inspects them. */
import http from "node:http";
import { gunzipSync } from "node:zlib";

export interface CapturedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

export interface CaptureServer {
  url: string;
  close(): Promise<void>;
  captured(): CapturedEvent[];
}

export function startCaptureServer(): Promise<CaptureServer> {
  const received: CapturedEvent[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") {
        try {
          body = gunzipSync(body);
        } catch {
          // fall through with the raw body
        }
      }
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { batch?: CapturedEvent[] };
        for (const event of parsed.batch ?? []) received.push(event);
      } catch {
        // ignore malformed probes
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        },
        captured: () => received,
      });
    });
  });
}
