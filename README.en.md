# dsh-archive-replica

Replicate — and revoke — the **Session archive set** of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) across machines.

[中文](README.md) · English

## The problem it solves

dsh keeps its archive state **out of the Session logs**:

| Data | Where | Synced by your file-sync tool? |
|---|---|---|
| Session content | `~/.dsh/sessions/` | ✅ (when symlinked into a synced folder) |
| Archive set `archivedSessionIds` | `$DSH_HOME/storages/workspace.json` | ❌ machine-local only |

So a Session archived on machine A keeps showing up on machine B, whose Session logs have already synced — the archive state has no synchronizable artifact at all.

Archiving is also **one-way** in dsh: the core exposes `archiveSession` and nothing that takes an id back out, so a mistaken archive has no undo.

This plugin closes both gaps:

- **Replication** — every machine publishes its archive set as one document in a shared folder, and every read unions the folder;
- **Revocation** — the folder also carries an unarchive journal, and a revoked Session is never imported or published by any machine (a global undo).

## Install

**Prerequisite**: your machines share one folder through the same file-sync tool (Nutstore, Dropbox, Syncthing, …), and each machine's `~/.dsh/sessions` also points into a synced folder, so Session logs travel too.
The shared folder must live inside the sync tool's **registered sync scope** — tools like Nutstore do not sync directories merely created under their mount root.

```bash
git clone https://github.com/<owner>/dsh-archive-replica.git ~/dsh-archive-replica

bash ~/dsh-archive-replica/install.sh --enable \
  --vault "$HOME/path/to/shared/sync/folder" \
  --machine "$(hostname -s)"

# then restart dsh
```

- `--vault`: the folder every machine shares and the sync tool replicates (required, must exist)
- `--machine`: this machine's unique id, naming its document — **must differ per machine**; defaults to `hostname -s`.
  ⚠️ **Two machines sharing a hostname is common** — that case must name one explicitly (`--machine laptop`).
  Documents record the publisher's machine fingerprint; `install.sh` refuses to install when the existing document under that id came from another machine, and the plugin warns at startup
- Installs to `~/.dsh/plugins/archive-replica` plus a resolution symlink at `~/.dsh/profiles/node_modules/@local/dsh-archive-replica` and an enabling row in the profile patch
- Check: `bash install.sh --check`; update: `git pull && bash install.sh`, then restart dsh

Or install it from npm (equivalent; the bin lands as `dsh-archive-replica-install`):

```bash
npm install -g dsh-archive-replica
dsh-archive-replica-install --enable --vault "$HOME/path/to/shared/sync/folder"

# no global install (try it out, or no sudo) — use npx:
npx -p dsh-archive-replica dsh-archive-replica-install --check
```

Repeat the same three steps on every other machine (with a different `--machine`).

## Configuration

The enabling row lives in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: archive-replica-external
      name: '@local/dsh-archive-replica'
      config:
        directory: /absolute/path/to/shared/folder
        machineId: desktop         # must differ per machine
        # watch: true              # keep scanning the folder (default true)
        # pollIntervalMs: 2000     # scan interval in ms (default 2000)
```

## Revoking an archive

Archiving is one-way, so a revocation travels as data:

```bash
# 1) stop dsh first (Ctrl+C in the terminal running it)
# 2) revoke (writes the journal, rewrites the local registry, strips every synced document, verifies)
bash ~/dsh-archive-replica/unarchive-session.sh <session-id>
# 3) restart dsh — the Session is back in the list
```

- A revocation is **global**: once one machine revokes, no machine archives that Session again. The plugin stops importing the id and drops it from its own publication, so another machine's union cannot replay the archive.
- **On the other machine**: copy `unarchive-session.sh` over and run it with **no arguments** to apply the journals (it only rewrites that machine's registry and verifies).
- Why revoking needs dsh stopped: the registry keeps the authoritative set in memory and writes it back, so an edit made while dsh runs is overwritten; and because the core has no unarchive path, the helper has to rewrite the registry offline.

## How it works

Each machine writes two single-writer documents into the shared folder:

| File | Content |
|---|---|
| `archive-<machineId>.json` | this machine's archive set |
| `unarchived-<machineId>.json` | ids this machine revoked (the unarchive journal) |

Every read unions the folder, and **a journal outranks every publication**: a revoked id is never imported and never republished.
Documents are identified by content, not by file name, so a sync client's conflict copy is unioned naturally while half-written or unrelated JSON is ignored.

The plugin reads the folder in a scan loop (2 s by default) rather than subscribing to filesystem notifications, which are unreliable on sync mounts.
Every archive write goes through dsh's own `workspace/archiveSession`; the plugin never writes the registry itself.

When a revoked id is still present in this machine's archive set, the plugin reports it once (with the ids) and points at `unarchive-session.sh`.

## Known limitations

- **Applying a revocation still needs one offline step per machine** (see above), because the registry exposes no unarchive path;
- **The shared folder is trusted input**: any JSON in it that parses as these documents is unioned, so it must be a folder you control;
- Only the **archive set** travels — workspace order, accounting, and attachments stay machine-local;
- A machine that does not mount this plugin publishes nothing, and its archives stay local;
- **Two machines configured with one `machineId` cannot work**: they write the same document and overwrite each other's archive set. The plugin and the installer both detect this through the document's machine fingerprint, but the id itself stays the operator's responsibility.

## Development and tests

The source is TypeScript, loaded directly by dsh's tsx launcher; the plugin depends only on Node built-ins and the `@deepseek-ai/*` packages the host provides — **no third-party runtime dependency**, which is what lets it live outside the dsh source tree.

Tests must run inside a dsh source tree (they import dsh packages, which a standalone clone cannot resolve):

```bash
cd /path/to/deepseek-harness
pnpm exec vitest run packages/workspace/archive-replica     # 41 tests
```

`lib/index.js` is the published build artifact (a single-file ESM bundle from esbuild; `@deepseek-ai/*` stays
external and is resolved by the host dsh at runtime). Rebuild it — and commit the result — after changing `src/`:

```bash
cd /path/to/deepseek-harness        # build inside a dsh source tree so @deepseek-ai/* resolves
pnpm exec esbuild <repo>/src/index.ts --bundle --format=esm --platform=node \
  --target=node22 --external:@deepseek-ai/\* --outfile=<repo>/lib/index.js
```

## Documentation

- [`docs/cross-machine-sync.zh.md`](docs/cross-machine-sync.zh.md) — how cross-machine sync works, plus
  install, configuration, revocation and troubleshooting (Chinese)
- [`CHANGELOG.md`](CHANGELOG.md) — version history and fixes
- [`PUBLISH.md`](PUBLISH.md) — maintainer release process (GitHub / npm)

## License

[MIT](LICENSE)
