import z from "zod";

export const ProxySchema = z.object({
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  url: z.string(),
  key: z.string(),
  method: z.union([z.literal("POST"), z.literal("GET")]),
});

export type ProxySchema = z.output<typeof ProxySchema>;

export const mkProxiedFetch =
  (apiKey: string) =>
  async (
    url: string,
    bodyInit?: {
      body?: string;
      headers?: Record<string, string>;
      method?: "POST" | "GET";
    }
  ) => {
    return await fetch("https://api-proxy.me-ea9.workers.dev/", {
      method: "POST",
      body: JSON.stringify({
        method: bodyInit?.method ?? "GET",
        key: apiKey,
        url: url,
        headers: {
          "Content-Type": "application/json",
        },
        body: bodyInit?.body,
      } satisfies ProxySchema),
    });
  };
