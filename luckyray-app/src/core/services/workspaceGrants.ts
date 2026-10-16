import { invoke as invokeTauri } from "@tauri-apps/api/core";

export type WorkspaceGrant = {
  managementRef: string;
  label: string;
  rootName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceFolderSelection = {
  managementRef: string;
  label: string;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createWorkspaceGrantClient(invoke: Invoke = invokeTauri) {
  return {
    list: () => invoke<WorkspaceGrant[]>("agent_workspace_list"),
    selectFolder: () => invoke<WorkspaceFolderSelection | null>("agent_workspace_select_folder"),
    add: (selectionManagementRef: string) => invoke<WorkspaceGrant>("agent_workspace_add", { selectionManagementRef }),
    setEnabled: (managementRef: string, enabled: boolean) => invoke<WorkspaceGrant>("agent_workspace_set_enabled", { managementRef, enabled }),
    remove: (managementRef: string) => invoke<void>("agent_workspace_remove", { managementRef }),
  };
}
