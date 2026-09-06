import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildRecoverablePullPlan,
  serializePullActions,
  type PullObservation,
  type LocalFileInspection,
  type ProvenanceLookup,
} from "../../src/domain/pull-plan.js";

describe("Recoverable Pull Plan", () => {
  function hash(content: string): string {
    return createHash("sha256").update(Buffer.from(content)).digest("hex");
  }

  it("yields 'noop' action when remote revision, remote hash, local provenance, and local file match", () => {
    const text = "Exact matching document";
    const bytes = Buffer.from(text);
    const contentHash = hash(text);

    const observations: PullObservation[] = [
      {
        kind: "note",
        path: "matched.md",
        sourceRevision: "1-abc",
        type: "plain",
        deleted: false,
        bytes,
      },
    ];

    const provenance = new Map<string, ProvenanceLookup>([
      [
        "matched.md",
        {
          remoteRevision: "1-abc",
          contentSha256: contentHash,
        },
      ],
    ]);

    const localFiles = new Map<string, LocalFileInspection>([
      [
        "matched.md",
        {
          exists: true,
          contentSha256: contentHash,
        },
      ],
    ]);

    const plan = buildRecoverablePullPlan(observations, provenance, localFiles);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      kind: "noop",
      path: "matched.md",
      sourceRevision: "1-abc",
      contentSha256: contentHash,
    });
  });

  it("yields 'create' action when revision or hash differs from provenance or local file", () => {
    const text = "New remote content";
    const bytes = Buffer.from(text);
    const contentHash = hash(text);

    const observations: PullObservation[] = [
      {
        kind: "note",
        path: "updated.md",
        sourceRevision: "2-def",
        type: "plain",
        deleted: false,
        bytes,
      },
    ];

    // Case A: Provenance has old revision
    const provOld = new Map<string, ProvenanceLookup>([
      [
        "updated.md",
        {
          remoteRevision: "1-abc",
          contentSha256: hash("Old content"),
        },
      ],
    ]);

    const localOld = new Map<string, LocalFileInspection>([
      [
        "updated.md",
        {
          exists: true,
          contentSha256: hash("Old content"),
        },
      ],
    ]);

    const planA = buildRecoverablePullPlan(observations, provOld, localOld);
    expect(planA).toHaveLength(1);
    expect(planA[0].kind).toBe("create");
    expect((planA[0] as any).sourceRevision).toBe("2-def");

    // Case B: Local file is missing on disk despite provenance
    const localMissing = new Map<string, LocalFileInspection>([
      [
        "updated.md",
        {
          exists: false,
        },
      ],
    ]);
    const planB = buildRecoverablePullPlan(observations, provOld, localMissing);
    expect(planB).toHaveLength(1);
    expect(planB[0].kind).toBe("create");
  });

  it("yields 'quarantine-delete' when remote doc is deleted and local file exists in vault", () => {
    const observations: PullObservation[] = [
      {
        kind: "note",
        path: "deleted-remote.md",
        sourceRevision: "3-del",
        type: "plain",
        deleted: true,
        bytes: new Uint8Array(0),
      },
    ];

    const provenance = new Map<string, ProvenanceLookup>([
      [
        "deleted-remote.md",
        {
          remoteRevision: "2-prev",
          contentSha256: hash("Existing file"),
        },
      ],
    ]);

    const localFiles = new Map<string, LocalFileInspection>([
      [
        "deleted-remote.md",
        {
          exists: true,
          contentSha256: hash("Existing file"),
        },
      ],
    ]);

    const plan = buildRecoverablePullPlan(observations, provenance, localFiles);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      kind: "quarantine-delete",
      path: "deleted-remote.md",
      sourceRevision: "3-del",
    });
  });

  it("yields 'skip-logical-delete' when remote doc is deleted and no local file exists", () => {
    const observations: PullObservation[] = [
      {
        kind: "note",
        path: "already-absent.md",
        sourceRevision: "2-del",
        type: "plain",
        deleted: true,
        bytes: new Uint8Array(0),
      },
    ];

    const provenance = new Map<string, ProvenanceLookup>();
    const localFiles = new Map<string, LocalFileInspection>([
      ["already-absent.md", { exists: false }],
    ]);

    const plan = buildRecoverablePullPlan(observations, provenance, localFiles);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      kind: "skip-logical-delete",
      path: "already-absent.md",
      sourceRevision: "2-del",
    });
  });

  it("yields 'block' with CONFLICT_LEAVES when multiple live leaves exist for a path", () => {
    const observations: PullObservation[] = [
      {
        kind: "note",
        path: "conflicted.md",
        sourceRevision: "2-branchA",
        type: "plain",
        deleted: false,
        bytes: Buffer.from("Branch A"),
      },
      {
        kind: "note",
        path: "conflicted.md",
        sourceRevision: "2-branchB",
        type: "plain",
        deleted: false,
        bytes: Buffer.from("Branch B"),
      },
    ];

    const plan = buildRecoverablePullPlan(observations, new Map(), new Map());
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe("block");
    expect((plan[0] as any).code).toBe("CONFLICT_LEAVES");
  });

  it("serializes pull actions correctly without leaking buffer payloads", () => {
    const text = "Hello plan";
    const bytes = Buffer.from(text);
    const contentHash = hash(text);

    const serialized = serializePullActions([
      { kind: "create", path: "a.md", sourceRevision: "1-a", bytes },
      { kind: "noop", path: "b.md", sourceRevision: "1-b", contentSha256: contentHash },
      { kind: "quarantine-delete", path: "c.md", sourceRevision: "1-c" },
      { kind: "skip-logical-delete", path: "d.md", sourceRevision: "1-d" },
      { kind: "skip-special", id: "leaf1", type: "leaf" },
      { kind: "skip-ignored", path: ".obsidian/workspace" },
      { kind: "block", id: "f", path: "e.md", code: "TEST_BLOCK", message: "blocked" },
    ]);

    expect(serialized).toEqual([
      {
        kind: "create",
        path: "a.md",
        sourceRevision: "1-a",
        byteLength: bytes.byteLength,
        contentSha256: contentHash,
      },
      {
        kind: "noop",
        path: "b.md",
        sourceRevision: "1-b",
        contentSha256: contentHash,
      },
      {
        kind: "quarantine-delete",
        path: "c.md",
        sourceRevision: "1-c",
      },
      {
        kind: "skip-logical-delete",
        path: "d.md",
        sourceRevision: "1-d",
      },
      {
        kind: "skip-special",
        id: "leaf1",
        type: "leaf",
      },
      {
        kind: "skip-ignored",
        path: ".obsidian/workspace",
      },
      {
        kind: "block",
        path: "e.md",
        id: "f",
        code: "TEST_BLOCK",
        message: "blocked",
        suggestion: undefined,
      },
    ]);
  });
});
