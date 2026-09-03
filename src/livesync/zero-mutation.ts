import {
  fetchDocumentIfExists,
  VERSIONING_DOCID,
  MILESTONE_DOCID,
  DOCID_SYNC_PARAMETERS,
  SYNCINFO_ID,
  type CouchDbDocument,
} from './inspector.js';

export interface DatabaseSnapshot {
  readonly updateSeq: string;
  readonly docCount: number;
  readonly revisions: Record<string, string | null>;
}

export class MutationDetectedError extends Error {
  readonly pre: DatabaseSnapshot;
  readonly post: DatabaseSnapshot;

  constructor(message: string, pre: DatabaseSnapshot, post: DatabaseSnapshot) {
    super(`Zero-mutation assertion failed: ${message}`);
    this.name = 'MutationDetectedError';
    this.pre = pre;
    this.post = post;
  }
}

export class ZeroMutationVerifier {
  static async captureSnapshot(
    guardedFetch: typeof globalThis.fetch,
    baseUrl: URL,
    databaseName: string,
    credentials?: { username?: string; password?: string }
  ): Promise<DatabaseSnapshot> {
    let authHeader: string | undefined;
    if (credentials?.username || credentials?.password) {
      const raw = `${credentials.username ?? ''}:${credentials.password ?? ''}`;
      authHeader = `Basic ${Buffer.from(raw).toString('base64')}`;
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    // 1. Fetch database info
    const dbUrl = new URL(`/${encodeURIComponent(databaseName)}`, baseUrl);
    const dbRes = await guardedFetch(dbUrl.toString(), {
      method: 'GET',
      headers,
    });

    if (!dbRes.ok) {
      throw new Error(
        `Failed to query database for zero-mutation snapshot: HTTP ${dbRes.status} ${dbRes.statusText}`
      );
    }

    const dbInfo = (await dbRes.json()) as {
      doc_count?: number;
      update_seq?: string | number;
    };
    const docCount = Number(dbInfo.doc_count ?? 0);
    const updateSeq = String(dbInfo.update_seq ?? '0');

    // 2. Fetch revisions for LiveSync marker documents
    const docIds = [VERSIONING_DOCID, MILESTONE_DOCID, DOCID_SYNC_PARAMETERS, SYNCINFO_ID];
    const revisions: Record<string, string | null> = {};

    for (const docId of docIds) {
      const doc = await fetchDocumentIfExists<CouchDbDocument>(
        guardedFetch,
        baseUrl,
        databaseName,
        docId,
        authHeader
      );
      revisions[docId] = doc ? doc._rev : null;
    }

    return {
      updateSeq,
      docCount,
      revisions,
    };
  }

  static assertNoMutation(pre: DatabaseSnapshot, post: DatabaseSnapshot): void {
    if (pre.updateSeq !== post.updateSeq) {
      throw new MutationDetectedError(
        `update_seq changed from '${pre.updateSeq}' to '${post.updateSeq}'`,
        pre,
        post
      );
    }

    if (pre.docCount !== post.docCount) {
      throw new MutationDetectedError(
        `doc_count changed from ${pre.docCount} to ${post.docCount}`,
        pre,
        post
      );
    }

    for (const [docId, preRev] of Object.entries(pre.revisions)) {
      const postRev = post.revisions[docId];
      if (preRev !== postRev) {
        throw new MutationDetectedError(
          `Revision for document '${docId}' changed from '${preRev}' to '${postRev}'`,
          pre,
          post
        );
      }
    }
  }
}
