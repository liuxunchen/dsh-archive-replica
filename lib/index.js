// src/index.ts
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join as join2, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

// src/replica.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { SessionId } from "@deepseek-ai/dsh-session";
import { WorkspaceUnknownSessionError, workspaceDomainState } from "@deepseek-ai/dsh-workspace";

// src/vault.ts
var VAULT_DOCUMENT_VERSION = 1;
var VAULT_FILE_PREFIX = "archive-";
var VAULT_FILE_SUFFIX = ".json";
var MACHINE_ID = /^[A-Za-z0-9._-]{1,64}$/u;
var SESSION_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function isMachineId(machineId) {
  return MACHINE_ID.test(machineId);
}
function vaultFileName(machineId) {
  return `${VAULT_FILE_PREFIX}${machineId}${VAULT_FILE_SUFFIX}`;
}
function parseVaultDocument(text) {
  const parsed = parseDocument(text, "archivedSessionIds");
  return parsed === void 0 ? void 0 : filterSessionIds(parsed.ids);
}
function parseVaultFingerprint(text) {
  const parsed = parseDocument(text, "archivedSessionIds");
  const fingerprint = parsed?.document.fingerprint;
  return typeof fingerprint === "string" && fingerprint.length > 0 ? fingerprint : void 0;
}
function parseUnarchiveDocument(text) {
  const parsed = parseDocument(text, "unarchivedSessionIds");
  return parsed === void 0 ? void 0 : filterSessionIds(parsed.ids);
}
function renderVaultDocument(machineId, archivedSessionIds, updatedAt, fingerprint) {
  const document = {
    version: VAULT_DOCUMENT_VERSION,
    machine: machineId,
    updatedAt,
    archivedSessionIds,
    ...fingerprint === void 0 ? {} : { fingerprint }
  };
  return `${JSON.stringify(document, null, 2)}
`;
}
function unionSessionIds(...lists) {
  const seen = /* @__PURE__ */ new Set();
  const union = [];
  for (const list of lists) {
    for (const id of list) {
      if (!SESSION_ID_TEXT.test(id) || seen.has(id)) continue;
      seen.add(id);
      union.push(id);
    }
  }
  return union;
}
function parseDocument(text, field) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const document = parsed;
  if (document.version !== VAULT_DOCUMENT_VERSION) return void 0;
  const ids = document[field];
  return Array.isArray(ids) ? { document, ids } : void 0;
}
function filterSessionIds(ids) {
  return ids.filter((id) => typeof id === "string" && SESSION_ID_TEXT.test(id));
}

// src/replica.ts
var DEFAULT_POLL_INTERVAL_MS = 2e3;
function resolveReplicaSpec(request) {
  return {
    directory: request.directory,
    machineId: request.machineId,
    watch: request.watch ?? true,
    pollIntervalMs: request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ...request.fingerprint === void 0 ? {} : { fingerprint: request.fingerprint }
  };
}
var ArchiveReplica = class {
  spec;
  registry;
  logger;
  now;
  timer;
  tail = Promise.resolve();
  disposed = false;
  scanning = false;
  published;
  publishedRevocations;
  reportedRevocations;
  reportedFailures = /* @__PURE__ */ new Map();
  /**
   * @param options - Resolved spec plus the registry surface, log sink, and clock.
   */
  constructor(options) {
    this.spec = options;
    this.registry = options.registry;
    this.logger = options.logger;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
  }
  /**
   * Import what the other machines published, publish this machine's own set,
   * then keep scanning the directory for later publications.
   * @returns resolution once the initial pass and the scan loop are running.
   */
  async start() {
    await this.enqueue(async () => {
      await this.reconcileNow();
      await this.publishNow();
    });
    if (this.disposed || !this.spec.watch) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, this.spec.pollIntervalMs);
  }
  /**
   * Stop scanning and stop applying further work. In-flight operations finish;
   * later ones observe disposal and do nothing.
   * @returns resolution once in-flight work settled.
   */
  async stop() {
    this.disposed = true;
    if (this.timer !== void 0) clearInterval(this.timer);
    this.timer = void 0;
    await this.tail;
  }
  /**
   * One directory scan, skipping a tick whose predecessor has not settled.
   * Disposal needs no check here: `stop` clears the interval, and both queued
   * operations observe disposal themselves.
   * @returns resolution once the scan pass settles.
   */
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.warn("scanning %s failed: %s", this.spec.directory, messageOf(error));
    } finally {
      this.scanning = false;
    }
  }
  /**
   * React to one durable domain write by republishing when the archive set moved.
   * @param change - Storage-domain change event payload.
   */
  observeDomainChange(change) {
    if (this.disposed) return;
    if (change.domain !== "workspace" || change.table !== "" || change.operation !== "put") return;
    const committed = workspaceDomainState.parse(change.value).archivedSessionIds.map(String);
    void this.publish(committed).catch((error) => {
      this.logger.warn("publishing after an archive change failed: %s", messageOf(error));
    });
  }
  /**
   * Archive every published id this machine has not archived yet.
   * @returns the pass outcome.
   */
  reconcile() {
    return this.enqueue(async () => this.reconcileNow());
  }
  /**
   * Write an archive set to this machine's own vault document.
   * @param committed - Archive set to publish; omission reads the registry's
   *   current set, which is authoritative outside a change event.
   * @returns resolution after the document is durable, or immediately when the
   *   published content is unchanged.
   */
  publish(committed) {
    return this.enqueue(async () => this.publishNow(committed));
  }
  /** One reconciliation pass, on the caller's chain slot. */
  async reconcileNow() {
    if (this.disposed) return { imported: 0, skipped: 0, failed: 0, revoked: 0 };
    const state = await this.readVaultState();
    const archived = new Set(this.registry.archivedSessionIds.map(String));
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let revoked = 0;
    for (const id of state.published) {
      if (state.revoked.has(id)) {
        revoked += 1;
        continue;
      }
      if (archived.has(id)) continue;
      try {
        await this.registry.archiveSession(SessionId(id));
        archived.add(id);
        imported += 1;
        this.reportedFailures.delete(id);
      } catch (error) {
        if (error instanceof WorkspaceUnknownSessionError) {
          skipped += 1;
          continue;
        }
        failed += 1;
        this.reportOnce(id, error);
      }
    }
    if (imported > 0) {
      this.logger.info("archived %d Session(s) published by another machine", imported);
    }
    this.reportStaleRevocations(state.revoked);
    await this.republishOnRevocationChange(state.revoked);
    return { imported, skipped, failed, revoked };
  }
  /** One publication, on the caller's chain slot. */
  async publishNow(committed) {
    if (this.disposed) return;
    const { revoked } = await this.readVaultState();
    const current = (committed ?? this.registry.archivedSessionIds.map(String)).filter((id) => !revoked.has(id));
    if (this.published !== void 0 && sameIds(this.published, current)) return;
    const path = join(this.spec.directory, vaultFileName(this.spec.machineId));
    const content = renderVaultDocument(
      this.spec.machineId,
      current,
      this.now().toISOString(),
      this.spec.fingerprint
    );
    await writeFileAtomic(path, content, { mode: 384 });
    this.published = current;
  }
  /**
   * Republish when the revocations changed even though the registry did not.
   *
   * A journal arrives from the file-sync tool, never from a registry write, so
   * `domain/changed` does not fire for it. Without this check a revocation would
   * reach this machine's document only the next time something else is archived.
   * @param revoked - Ids the vault revokes in this pass.
   */
  async republishOnRevocationChange(revoked) {
    const key = [...revoked].sort().join(",");
    if (this.publishedRevocations === key) return;
    this.publishedRevocations = key;
    await this.publishNow();
  }
  /**
   * Report a revocation this machine cannot apply by itself.
   *
   * The registry only archives, so a revoked id that is still in this machine's
   * archive set stays hidden until the offline helper rewrites the registry
   * with dsh stopped. Reporting once per distinct set keeps a two-second scan
   * loop from repeating the same line.
   * @param revoked - Ids the vault revokes.
   */
  reportStaleRevocations(revoked) {
    if (revoked.size === 0) {
      this.reportedRevocations = void 0;
      return;
    }
    const stale = this.registry.archivedSessionIds.map(String).filter((id) => revoked.has(id)).sort();
    if (stale.length === 0) {
      this.reportedRevocations = void 0;
      return;
    }
    const key = stale.join(",");
    if (this.reportedRevocations === key) return;
    this.reportedRevocations = key;
    this.logger.warn(
      "%d Session(s) are revoked in the vault but still archived here; with dsh stopped run unarchive-session.sh to apply: %s",
      stale.length,
      key
    );
  }
  /**
   * Read every document in the shared directory: archive documents contribute
   * published ids, unarchive journals contribute revocations.
   *
   * Selection is by content, not by file name: a sync client's conflict copy or
   * a renamed document still carries archives, while a half-written or foreign
   * JSON file parses as nothing and is ignored.
   * @returns the unioned ids and the revocation set.
   */
  async readVaultState() {
    const entries = await readdir(this.spec.directory, { withFileTypes: true });
    const lists = [];
    const revoked = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.spec.directory, entry.name);
      try {
        const text = await readFile(path, "utf8");
        const archived = parseVaultDocument(text);
        if (archived !== void 0) {
          lists.push([...archived]);
          continue;
        }
        const unarchived = parseUnarchiveDocument(text);
        if (unarchived === void 0) continue;
        for (const id of unarchived) revoked.add(id);
      } catch (error) {
        this.reportOnce(entry.name, error);
      }
    }
    return { published: unionSessionIds(...lists), revoked };
  }
  /** Warn about one failure per subject, so a retry loop stays readable. */
  reportOnce(subject, error) {
    const message = messageOf(error);
    if (this.reportedFailures.get(subject) === message) return;
    this.reportedFailures.set(subject, message);
    this.logger.warn("%s: %s", subject, message);
  }
  /** Run one operation after every operation enqueued before it. */
  enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => void 0, () => void 0);
    return result;
  }
};
function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/index.ts
var name = "archive-replica";
var inject = ["workspaceRegistry"];
var Config = z.object({
  directory: z.string().required(),
  machineId: z.string().required(),
  watch: z.boolean().default(true),
  pollIntervalMs: z.number().step(1).min(1).default(2e3)
});
function apply(ctx, config) {
  const directory = resolve(config.directory);
  if (!isMachineId(config.machineId)) {
    throw new Error(`archive-replica: machineId ${JSON.stringify(config.machineId)} must match [A-Za-z0-9._-]{1,64}`);
  }
  if (!isDirectory(directory)) {
    throw new Error(`archive-replica: shared directory ${JSON.stringify(directory)} does not exist`);
  }
  const logger = ctx.logger(name);
  const fingerprint = machineFingerprint();
  logger.info(
    "replicating the Session archive set through %s as %s (%s)",
    directory,
    config.machineId,
    fingerprint
  );
  reportMachineIdCollision(logger, directory, config.machineId, fingerprint);
  reportRetiredSidecar(logger);
  const replica = new ArchiveReplica({
    // Stated field by field rather than spread: the lint rule forbids spreading a
    // value whose type may carry a prototype, and the resolved spec is explicit anyway.
    ...resolveReplicaSpec({
      directory: config.directory,
      machineId: config.machineId,
      ...config.watch === void 0 ? {} : { watch: config.watch },
      ...config.pollIntervalMs === void 0 ? {} : { pollIntervalMs: config.pollIntervalMs },
      fingerprint
    }),
    registry: ctx.workspaceRegistry,
    logger
  });
  ctx.effect(() => {
    const started = replica.start();
    void started.catch((error) => {
      logger.error("starting replication in %s failed: %s", directory, messageOf2(error));
    });
    return async () => {
      await started.catch(() => void 0);
      await replica.stop();
    };
  }, "archive-replica vault");
  ctx.on("domain/changed", (change) => {
    replica.observeDomainChange(change);
  });
}
function machineFingerprint() {
  let host = "unknown";
  try {
    host = hostname().split(".")[0] || "unknown";
  } catch {
  }
  let kernelId = "";
  try {
    kernelId = readFileSync("/etc/machine-id", "utf8").trim().slice(0, 12);
  } catch {
  }
  return kernelId === "" ? host : `${host}:${kernelId}`;
}
function reportMachineIdCollision(logger, directory, machineId, fingerprint) {
  const path = join2(directory, vaultFileName(machineId));
  let existing;
  try {
    existing = parseVaultFingerprint(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
  if (existing === void 0 || existing === fingerprint) return void 0;
  logger.warn(
    "machineId %s is already published by another machine (document fingerprint %s, this machine %s). Both write %s, so each would overwrite the other: give this machine its own machineId in the profile row.",
    machineId,
    existing,
    fingerprint,
    path
  );
  return existing;
}
function reportRetiredSidecar(logger, dshHome = process.env.DSH_HOME ?? join2(homedir(), ".dsh")) {
  const path = retiredSidecarPath(dshHome);
  const count = listedIds(path);
  if (count === void 0 || count === 0) return void 0;
  logger.warn(
    "retired script-side sidecar %s still lists %d archived Session(s): its launcher writes those ids back into the registry on every start, so a revocation there would be replayed. Delete the file, or stop launching dsh through dsh-web-sync.mjs.",
    path,
    count
  );
  return { path, count };
}
function retiredSidecarPath(dshHome) {
  const sessions = join2(dshHome, "sessions");
  let real = sessions;
  try {
    real = realpathSync(sessions);
  } catch {
  }
  return join2(dirname(real), "dsh-sync", "archived-sessions.json");
}
function listedIds(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const ids = parsed.archivedSessionIds;
  return Array.isArray(ids) ? ids.length : void 0;
}
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  Config,
  apply,
  inject,
  machineFingerprint,
  name,
  reportMachineIdCollision,
  reportRetiredSidecar
};
