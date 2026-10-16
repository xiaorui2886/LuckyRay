import { createContext, useContext, type ReactNode } from "react";

/**
 * Transient shell-only coordination for compact navigation and the two AI
 * drawers. It deliberately carries no route, run, approval, or persisted
 * product state: AppShell owns the global-navigation preference for the
 * current viewport, while the mounted route keeps ownership of its existing drawer
 * reducer.
 */
export type CompactSurfaceCoordinator = Readonly<{
  compact: boolean;
  compactNavigationExpanded: boolean;
  toggleCompactNavigation: () => void;
  closeCompactNavigation: () => void;
  registerAiDrawerCloser: (closer: () => void) => () => void;
}>;

const inertCoordinator: CompactSurfaceCoordinator = Object.freeze({
  compact: false,
  compactNavigationExpanded: false,
  toggleCompactNavigation: () => undefined,
  closeCompactNavigation: () => undefined,
  registerAiDrawerCloser: () => () => undefined,
});

const CompactSurfaceCoordinatorContext = createContext<CompactSurfaceCoordinator>(inertCoordinator);

export function CompactSurfaceCoordinatorProvider({
  value,
  children,
}: Readonly<{
  value: CompactSurfaceCoordinator;
  children: ReactNode;
}>) {
  return (
    <CompactSurfaceCoordinatorContext.Provider value={value}>
      {children}
    </CompactSurfaceCoordinatorContext.Provider>
  );
}

export function useCompactSurfaceCoordinator(): CompactSurfaceCoordinator {
  return useContext(CompactSurfaceCoordinatorContext);
}
