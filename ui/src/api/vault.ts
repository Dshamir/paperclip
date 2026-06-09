import { api } from "./client";

export type VaultRecord = Record<string, string>;
export type Vault = {
  vault_version?: number;
  generated?: string;
  sources?: Record<string, string>;
  global: Record<string, VaultRecord | Record<string, VaultRecord>>;
  brands: Record<string, {
    source_excel_name?: string;
    sub_account_refs?: VaultRecord;
    portals?: Record<string, VaultRecord>;
  }>;
};

export const vaultApi = {
  get: () => api.get<Vault>("/instance/vault"),
  patch: (path: string, set: Record<string, string>) =>
    api.patch<Vault>("/instance/vault", { path, set }),
  rebuild: () => api.post<{ ok: boolean; log: string }>("/instance/vault/rebuild", {}),
  sync:    () => api.post<{ ok: boolean; sync: { code: number; log: string }; wire: { code: number; log: string } }>("/instance/vault/sync", {}),
};
