import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, UploadCloud, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { vaultApi, type Vault, type VaultRecord } from "../api/vault";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";

const VAULT_QK = ["instance", "vault"] as const;

// keys whose values should be masked by default (password / token-y names)
const SENSITIVE_RX = /(password|secret|token|api_key|key_json)$/i;

function isSensitiveKey(k: string): boolean {
  return SENSITIVE_RX.test(k);
}

function isLeafRecord(v: unknown): v is VaultRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === "string" || x === null || x === undefined,
  );
}

function GlobalSection({
  section,
  data,
  onSave,
}: {
  section: string;
  data: VaultRecord | Record<string, VaultRecord>;
  onSave: (path: string, set: Record<string, string>) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);

  if (isLeafRecord(data)) {
    return <FlatRecord title={section} path={`global.${section}`} record={data} onSave={onSave} startOpen={open} toggle={() => setOpen(!open)} />;
  }
  // Nested dict — e.g. domain_registrar.godaddy-account: { url, login, password }
  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="text-sm font-semibold">{section}</span>
        <span className="text-xs text-muted-foreground">({Object.keys(data).length})</span>
      </button>
      {open ? (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {Object.entries(data).map(([sub, rec]) => (
            <FlatRecord
              key={sub}
              title={sub}
              path={`global.${section}.${sub}`}
              record={(rec as VaultRecord) ?? {}}
              onSave={onSave}
              indented
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function FlatRecord({
  title,
  path,
  record,
  onSave,
  indented = false,
  startOpen = true,
  toggle,
}: {
  title: string;
  path: string;
  record: VaultRecord;
  onSave: (path: string, set: Record<string, string>) => Promise<void>;
  indented?: boolean;
  startOpen?: boolean;
  toggle?: () => void;
}) {
  const [local, setLocal] = useState<VaultRecord>(record);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setLocal(record); }, [record]);

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(record), ...Object.keys(local)]);
    for (const k of keys) {
      if ((record[k] ?? "") !== (local[k] ?? "")) return true;
    }
    return false;
  }, [record, local]);

  async function save() {
    setErr(null); setSaving(true);
    try {
      const changes: Record<string, string> = {};
      const keys = new Set([...Object.keys(record), ...Object.keys(local)]);
      for (const k of keys) {
        if ((record[k] ?? "") !== (local[k] ?? "")) {
          changes[k] = local[k] ?? "";
        }
      }
      if (Object.keys(changes).length === 0) return;
      await onSave(path, changes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn(indented ? "" : "rounded-xl border border-border bg-card", "p-4")}>
      <div className="flex items-center justify-between mb-3">
        {toggle ? (
          <button type="button" onClick={toggle} className="flex items-center gap-2 text-left">
            {startOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className="text-sm font-semibold">{title}</span>
          </button>
        ) : (
          <span className="text-sm font-semibold">{title}</span>
        )}
        <span className="text-xs text-muted-foreground">{Object.keys(record).length} fields</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[200px,1fr] gap-x-3 gap-y-2">
        {Object.entries(local).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => {
          const sensitive = isSensitiveKey(k);
          const masked = sensitive && !revealed[k];
          return (
            <div key={k} className="contents">
              <label className="text-xs text-muted-foreground self-center font-mono">{k}</label>
              <div className="flex items-center gap-2">
                <input
                  type={masked ? "password" : "text"}
                  value={v ?? ""}
                  placeholder={record[k] ? "" : "(empty)"}
                  onChange={(e) => setLocal({ ...local, [k]: e.target.value })}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
                />
                {sensitive ? (
                  <button
                    type="button"
                    onClick={() => setRevealed({ ...revealed, [k]: !revealed[k] })}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={masked ? "Reveal" : "Hide"}
                  >
                    {masked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {err ? <p className="text-xs text-destructive mt-2">{err}</p> : null}
      <div className="flex justify-end mt-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium",
            dirty
              ? "bg-foreground text-background hover:opacity-90"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          {saving ? "Saving..." : dirty ? "Save changes" : "No changes"}
        </button>
      </div>
    </div>
  );
}

function BrandCard({
  brandId,
  data,
  onSave,
}: {
  brandId: string;
  data: Vault["brands"][string];
  onSave: (path: string, set: Record<string, string>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const refs = data.sub_account_refs ?? {};
  const portals = data.portals ?? {};
  const refsCount = Object.values(refs).filter(Boolean).length;
  const portalsCount = Object.keys(portals).length;

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="text-sm font-semibold">{brandId}</span>
        {data.source_excel_name ? (
          <span className="text-xs text-muted-foreground">({data.source_excel_name})</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {refsCount}/{Object.keys(refs).length || 10} refs · {portalsCount} portals
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-4 py-3 space-y-4">
          <FlatRecord
            title="sub_account_refs"
            path={`brands.${brandId}.sub_account_refs`}
            record={refs}
            onSave={onSave}
            indented
          />
          {Object.entries(portals).length > 0 ? (
            <div className="rounded-md bg-muted/30 px-3 py-2">
              <p className="text-xs font-semibold mb-2">Operational portals (brand-owned, from excel — read-only here)</p>
              <ul className="text-xs space-y-0.5 font-mono">
                {Object.entries(portals).map(([slug, rec]) => (
                  <li key={slug} className="text-muted-foreground">
                    {slug}: {rec.url || rec.login || "(no url)"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function InstanceVaultSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Vault" }]);
  }, [setBreadcrumbs]);

  const vaultQuery = useQuery({
    queryKey: VAULT_QK,
    queryFn: () => vaultApi.get(),
  });

  const patchMutation = useMutation({
    mutationFn: ({ path, set }: { path: string; set: Record<string, string> }) =>
      vaultApi.patch(path, set),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: VAULT_QK }),
  });

  const syncMutation = useMutation({
    mutationFn: () => vaultApi.sync(),
    onSuccess: (r) => {
      setActionMsg(r.ok ? "Synced + wired all agents." : "Sync ran but with non-zero exit; check logs.");
      queryClient.invalidateQueries({ queryKey: VAULT_QK });
    },
    onError: (e) => setActionMsg(e instanceof Error ? e.message : "sync failed"),
  });

  const rebuildMutation = useMutation({
    mutationFn: () => vaultApi.rebuild(),
    onSuccess: () => {
      setActionMsg("Vault rebuilt from sources.");
      queryClient.invalidateQueries({ queryKey: VAULT_QK });
    },
    onError: (e) => setActionMsg(e instanceof Error ? e.message : "rebuild failed"),
  });

  if (vaultQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading vault...</div>;
  }
  if (vaultQuery.error || !vaultQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {vaultQuery.error instanceof Error ? vaultQuery.error.message : "Failed to load vault."}
      </div>
    );
  }

  const vault = vaultQuery.data;
  const globals = vault.global ?? {};
  const brands = vault.brands ?? {};
  const onSave = async (path: string, set: Record<string, string>) => {
    await patchMutation.mutateAsync({ path, set });
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Credentials Vault</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Single source of truth for every platform credential — master agency tokens
          (Meta, Google Ads, TikTok, Shopify, Amazon) plus per-brand sub-account pointers.
          Changes here are committed to <code className="px-1">vault.yaml</code> on disk;
          click <strong>Sync</strong> to push to paperclip secrets and re-wire agent env-bindings.
        </p>
        {vault.generated ? (
          <p className="text-xs text-muted-foreground">
            Last generated: <code>{vault.generated}</code> · version {vault.vault_version ?? "?"}
          </p>
        ) : null}
      </div>

      {actionMsg ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">{actionMsg}</div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={rebuildMutation.isPending}
          onClick={() => rebuildMutation.mutate()}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 hover:bg-accent"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", rebuildMutation.isPending && "animate-spin")} />
          Rebuild from sources
        </button>
        <button
          type="button"
          disabled={syncMutation.isPending}
          onClick={() => syncMutation.mutate()}
          className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 hover:opacity-90"
        >
          <UploadCloud className={cn("h-3.5 w-3.5", syncMutation.isPending && "animate-pulse")} />
          Sync to paperclip + wire agents
        </button>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Global (shared across all brands)</h2>
        {Object.entries(globals).map(([section, data]) => (
          <GlobalSection key={section} section={section} data={data as VaultRecord | Record<string, VaultRecord>} onSave={onSave} />
        ))}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Brands ({Object.keys(brands).length}) — each inherits all globals
        </h2>
        {Object.entries(brands).sort(([a],[b]) => a.localeCompare(b)).map(([brandId, brandData]) => (
          <BrandCard key={brandId} brandId={brandId} data={brandData} onSave={onSave} />
        ))}
      </div>
    </div>
  );
}
