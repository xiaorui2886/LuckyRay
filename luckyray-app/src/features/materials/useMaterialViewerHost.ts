import { useLayoutEffect, useState } from "react";
import {useMaterialViewScope} from './MaterialViewContext';

// A retained Activity hides its own DOM, but body portals need the same lifetime.
// Detach before paint on hide; React retains the contents for a safe reactivation.
export function useMaterialViewerHost() {
  const scope=useMaterialViewScope();
  const [host] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    if(!scope||scope.visible)document.body.appendChild(host);
    return () => host.remove();
  }, [host,scope?.visible]);
  return host;
}
