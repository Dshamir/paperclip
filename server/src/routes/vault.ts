import { Router, type Request } from "express";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { forbidden, badRequest } from "../errors.js";

/**
 * Vault routes for /instance/settings/vault.
 *
 * The vault is paperclip-config/credentials/vault.yaml in the
 * nexless-marketing-engine repo (mounted at /repo in docker-compose).
 *
 * Read/write of the vault, plus rebuild/sync/wire actions, are delegated
 * to the Python scripts in /repo/paperclip-config/credentials/ so the
 * canonical logic stays in one place. js-yaml is intentionally not used
 * here — Python's pyyaml is the source of truth.
 */

const REPO_ROOT = "/repo";
const VAULT_PATH = `${REPO_ROOT}/paperclip-config/credentials/vault.yaml`;
const CREDS_DIR = `${REPO_ROOT}/paperclip-config/credentials`;

const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;

function assertCanManage(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function runPy(scriptName: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const cp = spawn("python3", [`${CREDS_DIR}/${scriptName}`, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (b) => { stdout += b.toString(); });
    cp.stderr.on("data", (b) => { stderr += b.toString(); });
    cp.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function readVaultAsJson(): Promise<unknown> {
  // Parse YAML via Python (no js-yaml dep in this codebase).
  const py = `
import sys, json, yaml
with open("${VAULT_PATH}") as f:
    print(json.dumps(yaml.safe_load(f) or {}))
`;
  return new Promise((resolve, reject) => {
    const cp = spawn("python3", ["-c", py]);
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (b) => { stdout += b.toString(); });
    cp.stderr.on("data", (b) => { stderr += b.toString(); });
    cp.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || "yaml parse failed"));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

export function vaultRoutes(_db: Db) {
  const router = Router();

  // GET /instance/vault — full vault contents (passwords + tokens redacted client-side)
  router.get("/instance/vault", async (req, res, next) => {
    try {
      assertCanManage(req);
      // existence check first
      await readFile(VAULT_PATH, "utf8");
      const data = await readVaultAsJson();
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // PATCH /instance/vault — body: { path: "global.meta_business", set: { app_id: "...", app_secret: "..." } }
  router.patch("/instance/vault", async (req, res, next) => {
    try {
      assertCanManage(req);
      const path = String(req.body?.path ?? "");
      const set = req.body?.set ?? {};
      if (!path || !path.startsWith("global.") && !path.startsWith("brands.")) {
        throw badRequest("path must be global.* or brands.*");
      }
      if (typeof set !== "object" || Array.isArray(set)) {
        throw badRequest("set must be an object");
      }
      const args = ["--path", path];
      for (const [k, v] of Object.entries(set)) {
        if (!SAFE_KEY.test(k)) throw badRequest(`unsafe key: ${k}`);
        args.push("--set", `${k}=${String(v ?? "")}`);
      }
      const r = await runPy("_vault_mutate.py", args);
      if (r.code !== 0) throw new Error(`_vault_mutate.py failed: ${r.stderr || r.stdout}`);
      const data = await readVaultAsJson();
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // POST /instance/vault/rebuild — re-run build-vault.py (preserves protected sections)
  router.post("/instance/vault/rebuild", async (req, res, next) => {
    try {
      assertCanManage(req);
      const r = await runPy("build-vault.py", ["--quiet"]);
      if (r.code !== 0) throw new Error(r.stderr || "rebuild failed");
      res.json({ ok: true, log: r.stdout });
    } catch (e) {
      next(e);
    }
  });

  // POST /instance/vault/sync — push to paperclip secrets + wire agent env-bindings
  router.post("/instance/vault/sync", async (req, res, next) => {
    try {
      assertCanManage(req);
      const sync = await runPy("sync-vault-to-paperclip.py", ["--commit"]);
      const wire = await runPy("wire-agent-secrets.py", ["--commit"]);
      res.json({
        ok: sync.code === 0 && wire.code === 0,
        sync: { code: sync.code, log: sync.stdout.slice(-2000) },
        wire: { code: wire.code, log: wire.stdout.slice(-2000) },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
