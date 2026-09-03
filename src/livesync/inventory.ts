import {
  AuthenticationRequiredError,
  fetchDocumentIfExists,
  type CouchDbDocument,
} from './inspector.js';
import { isReservedChunkId } from './decode-adapter.js';

const ALL_DOCS_PAGE_SIZE = 100;

export interface InventoryCredentials {
  readonly username?: string;
  readonly password?: string;
}

export type InventoriedDocument =
  | { kind: 'chunk'; id: string }
  | { kind: 'tombstone'; id: string; rev: string }
  | { kind: 'document'; id: string; rev: string; document: CouchDbDocument };

interface AllDocsRow {
  readonly id?: string;
  readonly value?: {
    readonly rev?: string;
    readonly deleted?: boolean;
  };
}

function buildAuthHeader(credentials?: InventoryCredentials): string | undefined {
  if (credentials?.username || credentials?.password) {
    const raw = `${credentials.username ?? ''}:${credentials.password ?? ''}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }
  return undefined;
}

export async function inventoryRemoteDocuments(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  credentials?: InventoryCredentials
): Promise<InventoriedDocument[]> {
  const authHeader = buildAuthHeader(credentials);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const collected: InventoriedDocument[] = [];
  let startKey: string | undefined;

  for (;;) {
    const allDocsUrl = new URL(`/${encodeURIComponent(databaseName)}/_all_docs`, baseUrl);
    allDocsUrl.searchParams.set('limit', String(ALL_DOCS_PAGE_SIZE));
    if (startKey !== undefined) {
      allDocsUrl.searchParams.set('startkey', JSON.stringify(startKey));
      allDocsUrl.searchParams.set('skip', '1');
    }

    const response = await guardedFetch(allDocsUrl.toString(), {
      method: 'GET',
      headers,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationRequiredError(
        response.status,
        `Access denied listing documents in '${databaseName}'.`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Failed to list documents in '${databaseName}': HTTP ${response.status} ${response.statusText}`
      );
    }

    const body = (await response.json()) as { rows?: AllDocsRow[] };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      if (!row.id) {
        continue;
      }

      if (isReservedChunkId(row.id)) {
        collected.push({ kind: 'chunk', id: row.id });
        continue;
      }

      const rev = row.value?.rev ?? '';
      if (row.value?.deleted) {
        collected.push({ kind: 'tombstone', id: row.id, rev });
        continue;
      }

      const document = await fetchDocumentIfExists<CouchDbDocument>(
        guardedFetch,
        baseUrl,
        databaseName,
        row.id,
        authHeader
      );

      if (!document) {
        collected.push({ kind: 'tombstone', id: row.id, rev });
        continue;
      }

      collected.push({ kind: 'document', id: row.id, rev: document._rev, document });
    }

    if (rows.length < ALL_DOCS_PAGE_SIZE) {
      break;
    }

    const lastId = rows[rows.length - 1]?.id;
    if (!lastId || lastId === startKey) {
      break;
    }
    startKey = lastId;
  }

  return collected;
}
