import { createContext, useContext, type ReactNode } from 'react';
const CanvasMotionContext = createContext(false);
/** React context crosses portals, unlike the editor's CSS ancestor class. */
export function CanvasMotionProvider({ reduced, children }: { reduced: boolean; children: ReactNode }) {
  return <CanvasMotionContext.Provider value={reduced}>{children}</CanvasMotionContext.Provider>;
}
export function useCanvasReducedMotion() { return useContext(CanvasMotionContext); }
