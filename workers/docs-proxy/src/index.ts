export interface Env {
  MINTLIFY_DOCS_HOST?: string;
  CUSTOM_DOCS_HOST?: string;
}

const DEFAULT_MINTLIFY_DOCS_HOST = 'gannonh-kata-33.mintlify.site';
const DEFAULT_CUSTOM_DOCS_HOST = 'agents.kata.sh';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (!requestUrl.pathname.startsWith('/docs')) {
      return fetch(request);
    }

    const docsHost = env.MINTLIFY_DOCS_HOST || DEFAULT_MINTLIFY_DOCS_HOST;
    const customHost = env.CUSTOM_DOCS_HOST || DEFAULT_CUSTOM_DOCS_HOST;
    const proxyUrl = new URL(request.url);
    proxyUrl.hostname = docsHost;

    const proxyRequest = new Request(proxyUrl, request);
    proxyRequest.headers.set('Host', docsHost);
    proxyRequest.headers.set('X-Forwarded-Host', customHost);
    proxyRequest.headers.set('X-Forwarded-Proto', 'https');

    return fetch(proxyRequest);
  },
};
