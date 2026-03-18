/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject auth header
          // Use Authorization: Bearer for OpenRouter/custom endpoints, x-api-key for native Anthropic
          delete headers['x-api-key'];
          delete headers['authorization'];
          const baseUrl = secrets.ANTHROPIC_BASE_URL || '';
          if (baseUrl && !baseUrl.includes('api.anthropic.com')) {
            headers['authorization'] = 'Bearer ' + secrets.ANTHROPIC_API_KEY;
          } else {
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          }
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: (() => {
              const basePath = upstreamUrl.pathname.replace(/\/+$/, '');
              const reqPath = (req.url || '')
                .replace(/[?&]beta=true/g, '')
                .replace(/\?$/, '');
              return basePath + reqPath;
            })(),
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            // Filter hop-by-hop headers from upstream response before forwarding
            const resHeaders = { ...upRes.headers };
            delete resHeaders['connection'];
            delete resHeaders['keep-alive'];
            delete resHeaders['transfer-encoding'];
            delete resHeaders['upgrade'];
            delete resHeaders['proxy-authenticate'];
            delete resHeaders['proxy-authorization'];
            delete resHeaders['te'];
            delete resHeaders['trailers'];
            delete resHeaders['alt-svc'];
            res.writeHead(upRes.statusCode!, resHeaders);
            upRes.pipe(res, { end: true });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        // Rewrite model name and strip unsupported fields for non-Anthropic endpoints (e.g. OpenRouter)
        // Also strip ?beta=true from URL (SDK streaming mode not supported through proxy)
        let outBody = body;
        const baseUrl = secrets.ANTHROPIC_BASE_URL || '';
        if (
          baseUrl &&
          !baseUrl.includes('api.anthropic.com') &&
          req.method === 'POST'
        ) {
          try {
            const parsed = JSON.parse(body.toString());
            const openrouterModel =
              process.env.OPENROUTER_MODEL || 'stepfun/step-3.5-flash:free';
            if (parsed.model && parsed.model.startsWith('claude-')) {
              parsed.model = openrouterModel;
            }
            // Debug: log request structure
            logger.debug(
              {
                model: parsed.model,
                stream: parsed.stream,
                msgCount: parsed.messages?.length,
                firstMsgContentType: typeof parsed.messages?.[0]?.content,
              },
              'Proxy rewriting request',
            );
            // Strip Claude Code SDK-specific fields unsupported by non-Anthropic endpoints
            delete parsed.output_config;
            delete parsed.thinking;
            delete parsed.betas;

            // Convert Anthropic format to OpenAI format for NVIDIA/OpenAI-compatible endpoints
            const isNvidia = baseUrl.includes('integrate.api.nvidia.com') || baseUrl.includes('nvidia.com');
            if (isNvidia) {
              // Convert system messages: Anthropic uses system top-level, OpenAI uses role:system in messages
              if (parsed.system && Array.isArray(parsed.messages)) {
                const systemText = Array.isArray(parsed.system)
                  ? parsed.system.map((b: {text?: string}) => b.text || '').join('\n')
                  : String(parsed.system);
                parsed.messages = [{ role: 'system', content: systemText }, ...parsed.messages];
                delete parsed.system;
              }
              // Convert content arrays to strings for OpenAI
              if (Array.isArray(parsed.messages)) {
                parsed.messages = parsed.messages.map((msg: {role: string, content: unknown}) => {
                  if (Array.isArray(msg.content)) {
                    const text = (msg.content as Array<{type: string, text?: string}>)
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text || '')
                      .join('\n');
                    return { ...msg, content: text };
                  }
                  return msg;
                });
              }
              // max_tokens -> max_completion_tokens for newer NVIDIA models
              if (parsed.max_tokens && !parsed.max_completion_tokens) {
                parsed.max_completion_tokens = parsed.max_tokens;
                delete parsed.max_tokens;
              }
            }

            // Keep stream field as-is - let upstream handle streaming
            const rewritten = Buffer.from(JSON.stringify(parsed));
            headers['content-length'] = rewritten.length;
            headers['content-type'] = 'application/json';
            outBody = rewritten;
          } catch {
            /* not JSON, pass through */
          }
        }
        upstream.write(outBody);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
