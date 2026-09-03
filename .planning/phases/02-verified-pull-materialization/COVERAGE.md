# API Coverage — CouchDB HTTP + Commonlib codec

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Phase 2 is pull-only. Remote writes and daemon feeds stay out of this phase.

## CouchDB HTTP (existing database)

| capability | decision | reason |
|---|---|---|
| GET /{db} | INTEGRATE | Reused Phase 1 probe and zero-mutation snapshots |
| HEAD /{db} and document HEAD | INTEGRATE | Already on the transport allowlist |
| GET /{db}/_all_docs (paginated) | INTEGRATE | Finite inventory |
| GET /{db}/{id} | INTEGRATE | Note and chunk bodies |
| GET /{db}/{id}?conflicts=true | INTEGRATE | COMP-06 all-leaf detection |
| GET /{db}/{id}?rev= | INTEGRATE | Fetch each conflict leaf |
| GET /{db}/{id}?open_revs=all | INTEGRATE | Alternate leaf-body fetch |
| GET version / milestone / sync params / syncinfo | INTEGRATE | Reused Phase 1 admission |
| PUT / POST / DELETE / PATCH any path | OPT-OUT | Phase 2 has no remote write capability; transport guard remains GET/HEAD |
| _changes feed | OPT-OUT | Phase 5 daemon; Phase 2 is a finite pull |
| _bulk_docs | OPT-OUT | Phase 4 armed writes |
| _compact / _purge / _index / _design / _security / admin endpoints | OPT-OUT | SAFE-01 denylist; not needed to find conflicts |

## Commonlib 0.1.21 published surfaces

| capability | decision | reason |
|---|---|---|
| path2id_base / id2path_base / shouldBeIgnored | INTEGRATE | Path identity and reserved names |
| EntryTypes / NoteTypes / E2EEAlgorithms | INTEGRATE | Document classification |
| validateStoragePath (`/node`) | INTEGRATE | Vault-relative safety |
| createNodeStorage().rename | INTEGRATE | Allowed rename primitive; Node rename is equivalent |
| Incoming decrypt with admission salt (factory or octagonal-wheels equivalent) | INTEGRATE | COMP-02; no SyncParamsHandler |
| DirectFileManipulator init / get / put / delete / enumerate | OPT-OUT | enumerate empty; get winner-only; init can PUT salts |
| NodeStorageAdapter.write | OPT-OUT | In-place truncate; PULL-03 forbids it |
| Local PouchDB / LevelDB replica | OPT-OUT | SEA and STACK forbid LevelDB |
