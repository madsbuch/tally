/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import z from 'zod';

const ProxySchema = z.object({
	body: z.string().optional(),
	headers: z.record(z.string(), z.string()),
	url: z.string(),
	key: z.string(),

	// We always need to take post requests, to have a body
	// so we wrap in a post
	method: z.union([z.literal('POST'), z.literal('GET')]),
});

const key = '2355633';
const whitelistedPrefixes = ['https://api.openai.com'];

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': '*',
				},
			});
		}

		const bodyTxt = await request.text();

		const toProxyParse = ProxySchema.safeParse(JSON.parse(bodyTxt));

		if (!toProxyParse.success) {
			return new Response(JSON.stringify(toProxyParse.error, null, 2), {
				status: 400,
			});
		}

		const toProxy = toProxyParse.data;

		if (key !== toProxy.key) {
			return new Response('Invalid key', {
				status: 400,
			});
		}

		if (!whitelistedPrefixes.some((prefix) => toProxy.url.startsWith(prefix))) {
			return new Response('URL not whitelisted', {
				status: 400,
			});
		}

		const openAiKey = env.OPENAI_KEY;

		const proxiedResp = await fetch(toProxy.url, {
			headers: {
				// When openAI
				...(toProxy.url.startsWith('https://api.openai.com') ? { Authorization: `Bearer ${openAiKey}` } : {}),

				...toProxy.headers,
			},
			body: toProxy.body,

			// We use the request method as a lot of libraries etc. behave depending on the
			// the method. So we don't want to
			method: toProxy.method,
		});

		return new Response(proxiedResp.body, {
			status: proxiedResp.status,
			headers: {
				...proxiedResp.headers,

				// Cors
				'Access-Control-Allow-Origin': '*',
			},
		});
	},
} satisfies ExportedHandler<{
	OPENAI_KEY: any;
}>;
