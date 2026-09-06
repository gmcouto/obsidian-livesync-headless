export interface TransportGuardOptions {
  readonly allowedBaseUrl: URL;
  readonly databaseName: string;
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// Administrative, destructive, and server lifecycle subpaths forbidden during read-only admission
const FORBIDDEN_SUBPATHS = [
  '/_purge',
  '/_compact',
  '/_security',
  '/_revs_limit',
  '/_replicator',
  '/_design',
  '/_index',
  '/_node',
  '/_users',
  '/_config',
  '/_restart',
  '/_up',
];

export class MutationAttemptBlockedError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string) {
    super(`Blocked forbidden mutating HTTP method '${method}' to '${url}' during read-only admission.`);
    this.name = 'MutationAttemptBlockedError';
    this.method = method;
    this.url = url;
  }
}

export class EndpointDisallowedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Blocked access to out-of-scope or administrative endpoint: '${url}'.`);
    this.name = 'EndpointDisallowedError';
    this.url = url;
  }
}

export function createGuardedFetch(
  options: TransportGuardOptions,
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  const allowedDbPath = `/${options.databaseName}`;

  return async function guardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const targetUrl = new URL(rawUrl, options.allowedBaseUrl);
    const method = (
      init?.method ??
      (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    ).toUpperCase();

    // 1. Method check: strictly GET and HEAD only (SAFE-02)
    if (!ALLOWED_METHODS.has(method)) {
      throw new MutationAttemptBlockedError(method, targetUrl.href);
    }

    // 2. Authority check: scheme, host, and port must match exactly
    if (targetUrl.origin !== options.allowedBaseUrl.origin) {
      throw new EndpointDisallowedError(targetUrl.href);
    }

    // 3. Path check: allow root '/', /{db}, and /{db}/* only
    const path = targetUrl.pathname;
    const isRoot = path === '/' || path === '';
    const isDbTarget = path === allowedDbPath || path.startsWith(`${allowedDbPath}/`);

    if (!isRoot && !isDbTarget) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }

    // 4. Administrative denylist check (SAFE-01)
    const lowerPath = path.toLowerCase();
    const isForbidden = FORBIDDEN_SUBPATHS.some((subpath) => lowerPath.includes(subpath));
    if (isForbidden) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }

    // 5. Execute with redirect manual to inspect 3xx responses
    const response = await baseFetch(input, {
      ...init,
      redirect: 'manual',
    });

    // 6. Inspect 3xx redirects to prevent credential or query leakage across origins
    if ([301, 302, 307, 308].includes(response.status)) {
      const redirectLocation = response.headers.get('location');
      if (!redirectLocation) {
        throw new Error('Redirect response received without Location header.');
      }

      const redirectedUrl = new URL(redirectLocation, targetUrl);
      if (redirectedUrl.origin !== options.allowedBaseUrl.origin) {
        throw new EndpointDisallowedError(
          `Cross-origin redirect denied: from '${targetUrl.origin}' to '${redirectedUrl.origin}'.`
        );
      }

      // Re-invoke through guardedFetch to check method and path allowlist of redirected target
      return guardedFetch(redirectedUrl.toString(), init);
    }

    return response;
  };
}

const ARMED_ALLOWED_METHODS = new Set(['GET', 'HEAD', 'PUT', 'POST']);

export function createArmedGuardedFetch(
  options: TransportGuardOptions,
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  const allowedDbPath = `/${options.databaseName}`;

  return async function armedGuardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const targetUrl = new URL(rawUrl, options.allowedBaseUrl);
    const method = (
      init?.method ??
      (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    ).toUpperCase();

    // 1. Method check: strictly GET, HEAD, PUT, POST only (SAFE-03)
    if (!ARMED_ALLOWED_METHODS.has(method)) {
      throw new MutationAttemptBlockedError(method, targetUrl.href);
    }

    // 2. Authority check: scheme, host, and port must match exactly
    if (targetUrl.origin !== options.allowedBaseUrl.origin) {
      throw new EndpointDisallowedError(targetUrl.href);
    }

    // 3. Path check: allow root '/', /{db}, and /{db}/* only
    const path = targetUrl.pathname;
    const isRoot = path === '/' || path === '';
    const isDbTarget = path === allowedDbPath || path.startsWith(`${allowedDbPath}/`);

    if (!isRoot && !isDbTarget) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }

    // 4. Administrative denylist check (SAFE-01, SAFE-03)
    const lowerPath = path.toLowerCase();
    const isForbidden = FORBIDDEN_SUBPATHS.some((subpath) => lowerPath.includes(subpath));
    if (isForbidden) {
      throw new EndpointDisallowedError(targetUrl.pathname);
    }

    // 5. Execute with redirect manual to inspect 3xx responses
    const response = await baseFetch(input, {
      ...init,
      redirect: 'manual',
    });

    // 6. Inspect 3xx redirects to prevent credential or query leakage across origins
    if ([301, 302, 307, 308].includes(response.status)) {
      const redirectLocation = response.headers.get('location');
      if (!redirectLocation) {
        throw new Error('Redirect response received without Location header.');
      }

      const redirectedUrl = new URL(redirectLocation, targetUrl);
      if (redirectedUrl.origin !== options.allowedBaseUrl.origin) {
        throw new EndpointDisallowedError(
          `Cross-origin redirect denied: from '${targetUrl.origin}' to '${redirectedUrl.origin}'.`
        );
      }

      // Re-invoke through armedGuardedFetch to check method and path allowlist of redirected target
      return armedGuardedFetch(redirectedUrl.toString(), init);
    }

    return response;
  };
}

