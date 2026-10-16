/** Independent product windows are withdrawn. Saved window records remain on
 * disk, but neither a label nor a route can boot an old content window or grant
 * it Main's services. This does not affect page-internal panes or layouts. */
export function nativeWorkspaceWindowRole(label: string): "main" {
  if (label === "main") return "main";
  throw new Error("workspace-unrecognized-window");
}
