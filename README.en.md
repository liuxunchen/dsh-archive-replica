# dsh-archive-replica

Replicate the **Session archive set** of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) across machines.

[中文](README.md) · English

## The problem it solves

dsh keeps its archive state **out of the Session logs**:

| Data | Where | Synced by your file-sync tool? |
|---|---|---|
| Session content | `~/.dsh/sessions/` | ✅ (when symlinked into a synced folder) |
| Archive set `archivedSessionIds` | `$DSH_HOME/storages/workspace.json` | ❌ machine-local only |

So a Session archived on machine A keeps showing up on machine B, whose Session logs have already synced — the archive state has no synchronizable artifact at all.

This plugin closes that gap and only that gap: every machine publishes its archive set as one document in a shared folder, and every read unions the folder.

**Unarchiving is not this plugin's business**: dsh has its own (`workspaceRegistry.unarchiveSession`, plus the sidebar's "all conversations (show archived)" filter and its unarchive action), so taking a Session back is an action **on one machine** and does not travel — whichever machine should show it again unarchives it there.

## Install

**Prerequisite**: your machines share one folder through the same file-sync tool (Nutstore, Dropbox, Syncthing, …), and each machine's `~/.dsh/sessions` also points into a synced folder, so Session logs travel too.
The shared folder must live inside the sync tool's **registered sync scope** — tools like Nutstore do not sync directories merely created under their mount root.

This package is an **installable DSH bundle** (`package.json` declares `dsh.bundle.patch`): once installed into a profile the plugin row ships with the package, so no external installer is needed.

```bash
dsh plugin --profile web add dsh-archive-replica      # install into the web profile
```

The first use initializes the profile and appends this package to its bundle layers. **Installing is not enabling**: the bundle's row is `disabled: true` (see [Configuration](#configuration)) because it needs your shared folder and this machine's id. Restart dsh to take effect.

Machines still on the older **external replica** (`@local/dsh-archive-replica` + `install-archive-replica.sh`): drop that enabling row (id `archive-replica-external`) and the `~/.dsh/plugins/archive-replica` / `~/.dsh/profiles/node_modules/@local/dsh-archive-replica` links, and use the row from [Configuration](#configuration) instead; the data files `archive-<machineId>.json` stay as they are. To go back to the external replica (say, a machine without pnpm), `git clone` this repository and run `bash install.sh --enable --vault <shared folder> --machine <this machine's id>`, or `npm i -g dsh-archive-replica` and check it with `dsh-archive-replica-install --check` — the two routes are independent, so **never enable both**.

## Configuration

The bundle ships this row (`cordis.patch.yml`, `disabled: true`); enabling it means overriding that row **by id** in your own profile patch. Replicating the archive set has no sensible default without you — an enabled row with placeholder values would look configured while replicating nothing — so these values are yours to state:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: archive-replica
  disabled: false
  config:
    directory: '/absolute/path/to/shared/folder'   # required, must exist (inside the sync scope)
    machineId: desktop                             # required, must differ per machine; quote digits
    # watch: true                                  # keep scanning the folder (default true)
    # pollIntervalMs: 2000                         # scan interval in ms (default 2000)
```

- `directory`: the folder every machine shares and the sync tool replicates (required, must already exist)
- `machineId`: this machine's unique id, naming its document — **must differ per machine**. ⚠️ Two machines sharing a hostname is common, so never copy a placeholder like `desktop`; documents record the publisher's machine fingerprint and the plugin warns when one id shows up from another machine
- An id-targeted override replaces the whole `config`, it does not deep-merge: state `machineId` again whenever you change `directory`
- After a restart, the plugin logs one info line (folder, machineId, fingerprint) — that is how you confirm it is live

## Unarchiving (per machine)

Switch the sidebar filter to "all conversations (show archived)" or "archived only" and hit "unarchive" on that row;
the core call is `workspaceRegistry.unarchiveSession(id)`, which drops the id from the registry-global archive set and the Session returns to its recorded position.

- **It does not travel**: unarchiving touches this machine only. The other machines still list that archive and publish it, so a union import **archives your copy back** on the next scan (or the next time this machine archives anything else). To see the Session on another machine, unarchive it there too.
- This plugin **only ever adds**: it never calls `unarchiveSession` and never removes an id from its own document.
- Archiving while work is running (dsh's new `WorkspaceActiveSessionError`): the plugin **does not interrupt** the turn running here. It skips that id, warns once, and retries on every scan — the archive lands by itself once the work stops.
- A leftover `unarchived-<machineId>.json` journal from an older version is no longer read and can be deleted (see [CHANGELOG](CHANGELOG.md) 0.1.6).

## How it works

Each machine writes one single-writer document into the shared folder:

| File | Content |
|---|---|
| `archive-<machineId>.json` | this machine's archive set |

Every read unions the folder and hands each id to dsh's own `workspace/archiveSession`; the plugin never writes the registry itself.
Documents are identified by content, not by file name, so a sync client's conflict copy is unioned naturally while half-written or unrelated JSON is ignored.

The plugin reads the folder in a scan loop (2 s by default) rather than subscribing to filesystem notifications, which are unreliable on sync mounts.
Archiving a Session here fires the registry's `domain/changed` event, which publishes immediately (within about a second) instead of waiting for the next scan.

## After upgrading dsh (relink the dependency farm)

Like official bundles, this plugin's runtime dependencies resolve through the profile dependency farm,
`~/.dsh/profiles/node_modules`, whose symlinks point into the npm host installation root. **Reinstalling dsh
under a new prefix does not follow those links**: they still point at the old host, so the plugin loads
classes such as `WorkspaceUnknownSessionError` from the *old* host packages. Those are different module
instances from the running host, every `instanceof` fails, and `unknown`/`active` outcomes degrade to
`failed` — one warning per missing id every 2-second scan.

After an upgrade, verify and relink (rewrite the target prefix to the new host root, skip packages the new
host no longer ships), then restart dsh:

```bash
NEW_ROOT="$(cd "$(dirname "$(readlink -f "$(command -v dsh)")")/.." && pwd)"
find ~/.dsh/profiles/node_modules -type l | while read -r l; do
  t="$(readlink "$l")"
  case "$t" in
    /usr/local/lib/node_modules/@deepseek-ai/dsh*)    # replace with your old host prefix
      nt="$NEW_ROOT${t#/usr/local/lib/node_modules/@deepseek-ai/dsh}"
      [ -e "$nt" ] && ln -sfn "$nt" "$l"               # skip packages the new host dropped (e.g. typebox in 0.2.2)
      ;;
  esac
done
```

Version 0.1.7 is verified against dsh 0.2.2-rc.1. The 0.2.2 session-layout change (bare-UUID session
directories, `session.v4.jsonl.zstd`) does not affect this plugin: it never reads session files, it only
talks to `workspaceRegistry`.

## Known limitations

- **Unarchiving is a per-machine action** and does not sync (see above);
- **The shared folder is trusted input**: any JSON in it that parses as these documents is unioned, so it must be a folder you control;
- Only the **archive set** travels — workspace order, accounting, attachments, and pins (`pinnedSessionIds`) stay machine-local;
- A machine that does not mount this plugin publishes nothing, and its archives stay local;
- **Two machines configured with one `machineId` cannot work**: they write the same document and overwrite each other's archive set. The plugin and the installer both detect this through the document's machine fingerprint, but the id itself stays the operator's responsibility.

## Development and tests

The source is TypeScript, loaded directly by dsh's tsx launcher; the plugin depends only on Node built-ins and the `@deepseek-ai/*` packages the host provides — **no third-party runtime dependency**, which is what lets it live outside the dsh source tree.

```bash
npx vitest run                                  # 38 tests: vault / replica / failure paths / row / fingerprint
npx tsc --noEmit                                # type-check every source and test file
```

The one exception is `tests/loader-composition.spec.ts`, the real-composition guard (actual Loader + Include + workspace registry): it imports `workspace/src` and `storage-domain/tests` by relative path, so it **only runs inside a dsh source tree**:

```bash
cd /path/to/deepseek-harness
pnpm exec vitest run packages/workspace/archive-replica/     # includes the composition guard
```

Every other test needs only the `@deepseek-ai/*` packages the host dsh already ships: create `node_modules/@deepseek-ai/` at the repository root and symlink them in (`node_modules/` is already in `.gitignore`).

`lib/index.js` is the published build artifact (a single-file ESM bundle from esbuild; `@deepseek-ai/*` stays
external and is resolved by the host dsh at runtime). Rebuild it — and commit the result — after changing `src/`:

```bash
npx esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 \
  --external:@deepseek-ai/\* --outfile=lib/index.js
```

(`pnpm exec esbuild` inside a dsh source tree produces the same bundle.)

## Documentation

- [`docs/cross-machine-sync.zh.md`](docs/cross-machine-sync.zh.md) — how cross-machine sync works, plus
  install, configuration and troubleshooting (Chinese)
- [`CHANGELOG.md`](CHANGELOG.md) — version history and fixes
- [`PUBLISH.md`](PUBLISH.md) — maintainer release process (GitHub / npm)

## License

[MIT](LICENSE)
