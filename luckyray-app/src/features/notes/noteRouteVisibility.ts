import {createContext} from "react";

// Retain editor ownership while route-local portals stop owning input/focus.
// Standalone/native note surfaces keep their existing visible default.
export const NoteRouteVisibilityContext = createContext(true);
