// Synthetic data only; use the real production titlebar, graph store and canvases.
import React, { Activity, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/core/i18n/index';
import { AppTitlebar } from '../../src/app/AppSidebar';
import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from '../../src/app/applicationModalIsolation';
import GraphPage from '../../src/features/graph/GraphPage';
import { graphSessionStore } from '../../src/features/graph/graphSessionStore';
import { graphDataProvider } from '../../src/core/services/graph';
import '../../src/core/theme/themeTokens.css';
import '../../src/app/appShell.css';
const nodes = Array.from({length: 80}, (_, id) => ({ id, key: `fixture-${id}`, entityId: `fixture-${id}`, label: `Fixture document ${id}`, type: 'note' as const, timelineAt: id * 1000 }));
graphDataProvider.buildSeed = async () => ({ nodes, edges: nodes.slice(1).map(node => [node.id, Math.floor((node.id - 1) / 3)]), source: 'real' });
(window as any).graphStore = graphSessionStore;
const modal = createApplicationModalIsolationStore();
function App() {
  const [visible, setVisible] = useState(true);
  (window as any).setGraphVisible = setVisible;
  return <I18nProvider locale="en-US"><ApplicationModalIsolationProvider store={modal}><main style={{display:'flex',height:'100vh',flexDirection:'column',minWidth:0}}>
    <AppTitlebar route="graph" onOpenSearch={() => {}} />
    <Activity mode={visible ? 'visible' : 'hidden'}><GraphPage /></Activity>
  </main></ApplicationModalIsolationProvider></I18nProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
