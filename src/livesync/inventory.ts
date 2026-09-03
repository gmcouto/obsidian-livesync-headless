import {
  AuthenticationRequiredError,
  fetchDocumentIfExists,
  type CouchDbDocument,
} from './inspector.js';
import { isReservedChunkId } from './decode-adapter.js';

export function createChunkFetcher(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  authHeader?: string
): (id: string) => Promise<CouchDbDocument | null> {
  return (id) => fetchDocumentIfExists<CouchDbDocument>(guardedFetch, baseUrl, databaseName, id, authHeader);
}

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

function conflictRevsFrom(document: CouchDbDocument): string[] {
  const raw = document._conflicts;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((rev): rev is string => typeof rev === 'string' && rev.length > 0);
}

async function fetchNoteLeaves(
  guardedFetch: typeof globalThis.fetch,
  baseUrl: URL,
  databaseName: string,
  docId: string,
  authHeader: string | undefined
): Promise<CouchDbDocument[] | null> {
  const [conflictsKey, conflictsValue] = 'conflicts=true'.split('=') as [string, string];
  const document = await fetchDocumentIfExists<CouchDbDocument>(
    guardedFetch,
    baseUrl,
    databaseName,
    docId,
    authHeader,
    { [conflictsKey]: conflictsValue }
  );
  if (!document) {
    return null;
  }

  const leaves: CouchDbDocument[] = [document];
  for (const rev of conflictRevsFrom(document)) {
    const leaf = await fetchDocumentIfExists<CouchDbDocument>(
      guardedFetch,
      baseUrl,
      databaseName,
      docId,
      authHeader,
      { rev }
    );
    if (leaf) {
      leaves.push(leaf);
    }
  }
  return leaves;
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

      const leaves = await fetchNoteLeaves(
        guardedFetch,
        baseUrl,
        databaseName,
        row.id,
        authHeader
      );

      if (!leaves || leaves.length === 0) {
        collected.push({ kind: 'tombstone', id: row.id, rev });
        continue;
      }

      for (const leaf of leaves) {
        if (leaf._deleted === true) {
          collected.push({ kind: 'tombstone', id: row.id, rev: leaf._rev });
          continue;
        }
        collected.push({ kind: 'document', id: row.id, rev: leaf._rev, document: leaf });
      }
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
