export const VERSIONING_DOCID = 'obsydian_livesync_version';
export const MILESTONE_DOCID = '_local/obsydian_livesync_milestone';
export const DOCID_SYNC_PARAMETERS = '_local/obsidian_livesync_sync_parameters';
export const SYNCINFO_ID = 'syncinfo';

export interface CouchDbDocument {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

export interface RemoteProbeResult {
  readonly databaseInfo: {
    readonly docCount: number;
    readonly updateSeq: string;
    readonly couchdbVersion?: string;
  };
  readonly versionDoc: {
    readonly _id: string;
    readonly _rev: string;
    readonly version: number;
  } | null;
  readonly milestoneDoc: {
    readonly _id: string;
    readonly _rev: string;
    readonly locked?: boolean;
    readonly tweak_values?: Record<string, Record<string, unknown>>;
  } | null;
  readonly syncParamsDoc: {
    readonly _id: string;
    readonly _rev: string;
    readonly pbkdf2salt?: string;
    readonly hashAlgorithm?: string;
    readonly customChunkSize?: number;
  } | null;
  readonly syncinfoDoc: {
    readonly _id: string;
    readonly _rev: string;
    readonly data?: string;
    readonly type?: string;
  } | null;
  readonly sampleDocs: readonly {
    readonly id: string;
    readonly rev: string;
  }[];
}

export class DatabaseNotFoundError extends Error {
  readonly databaseName: string;

  constructor(databaseName: string) {
    super(`CouchDB database '${databaseName}' was not found (HTTP 404).`);
    this.name = 'DatabaseNotFoundError';
    this.databaseName = databaseName;
  }
}

export class AuthenticationRequiredError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message = 'Authentication required or invalid credentials.') {
    super(`CouchDB authentication failed (HTTP ${statusCode}): ${message}`);
    this.name = 'AuthenticationRequiredError';
    this.statusCode = statusCode;
  }
}

export async function fetchDocumentIfExists<T extends CouchDbDocument>(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  docId: string,
  authHeader?: string,
  query?: Record<string, string>
): Promise<T | null> {
  const pathSegments = docId.split('/').map(encodeURIComponent).join('/');
  const docUrl = new URL(`/${encodeURIComponent(databaseName)}/${pathSegments}`, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      docUrl.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const response = await guardedFetch(docUrl.toString(), {
    method: 'GET',
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationRequiredError(
      response.status,
      `Access denied fetching document '${docId}'.`
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch document '${docId}': HTTP ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as T;
}

export async function probeRemoteDatabase(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  credentials?: { username?: string; password?: string }
): Promise<RemoteProbeResult> {
  let authHeader: string | undefined;
  if (credentials?.username || credentials?.password) {
    const raw = `${credentials.username ?? ''}:${credentials.password ?? ''}`;
    authHeader = `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  const baseHeaders: Record<string, string> = {
    Accept: 'application/json',
  };
  if (authHeader) {
    baseHeaders.Authorization = authHeader;
  }

  // 1. Check root server info for CouchDB version (optional best-effort)
  let couchdbVersion: string | undefined;
  try {
    const rootRes = await guardedFetch(baseUrl.origin + '/', {
      method: 'GET',
      headers: baseHeaders,
    });
    if (rootRes.ok) {
      const rootJson = (await rootRes.json()) as { version?: string };
      couchdbVersion = rootJson.version;
    }
  } catch {
    // Ignore root server check failure, database endpoint is authoritative
  }

  // 2. Query database info: GET /{db}
  const dbUrl = new URL(`/${encodeURIComponent(databaseName)}`, baseUrl);
  const dbRes = await guardedFetch(dbUrl.toString(), {
    method: 'GET',
    headers: baseHeaders,
  });

  if (dbRes.status === 401 || dbRes.status === 403) {
    throw new AuthenticationRequiredError(dbRes.status, `Access denied for database '${databaseName}'.`);
  }

  if (dbRes.status === 404) {
    throw new DatabaseNotFoundError(databaseName);
  }

  if (!dbRes.ok) {
    throw new Error(
      `Failed to query database info for '${databaseName}': HTTP ${dbRes.status} ${dbRes.statusText}`
    );
  }

  const dbInfo = (await dbRes.json()) as {
    doc_count?: number;
    update_seq?: string | number;
  };

  const docCount = Number(dbInfo.doc_count ?? 0);
  const updateSeq = String(dbInfo.update_seq ?? '0');

  // 3. Query standard LiveSync documents (pure read-only queries)
  const versionDoc = await fetchDocumentIfExists<{
    _id: string;
    _rev: string;
    version: number;
  }>(guardedFetch, baseUrl, databaseName, VERSIONING_DOCID, authHeader);

  const milestoneDoc = await fetchDocumentIfExists<{
    _id: string;
    _rev: string;
    locked?: boolean;
    tweak_values?: Record<string, Record<string, unknown>>;
  }>(guardedFetch, baseUrl, databaseName, MILESTONE_DOCID, authHeader);

  const syncParamsDoc = await fetchDocumentIfExists<{
    _id: string;
    _rev: string;
    pbkdf2salt?: string;
    hashAlgorithm?: string;
    customChunkSize?: number;
  }>(guardedFetch, baseUrl, databaseName, DOCID_SYNC_PARAMETERS, authHeader);

  const syncinfoDoc = await fetchDocumentIfExists<{
    _id: string;
    _rev: string;
    data?: string;
    type?: string;
  }>(guardedFetch, baseUrl, databaseName, SYNCINFO_ID, authHeader);

  // 4. Query sample representative documents
  const allDocsUrl = new URL(
    `/${encodeURIComponent(databaseName)}/_all_docs?limit=10`,
    baseUrl
  );
  const allDocsRes = await guardedFetch(allDocsUrl.toString(), {
    method: 'GET',
    headers: baseHeaders,
  });

  const sampleDocs: { id: string; rev: string }[] = [];
  if (allDocsRes.ok) {
    const allDocsJson = (await allDocsRes.json()) as {
      rows?: { id: string; value: { rev: string } }[];
    };
    if (Array.isArray(allDocsJson.rows)) {
      for (const row of allDocsJson.rows) {
        if (row.id && row.value?.rev) {
          sampleDocs.push({ id: row.id, rev: row.value.rev });
        }
      }
    }
  }

  return {
    databaseInfo: {
      docCount,
      updateSeq,
      couchdbVersion,
    },
    versionDoc,
    milestoneDoc,
    syncParamsDoc,
    syncinfoDoc,
    sampleDocs,
  };
}
