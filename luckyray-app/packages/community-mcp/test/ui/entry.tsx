import React from "react";
import { createRoot } from "react-dom/client";
import OfficialMcpCard from "../../../../src/features/community/mcp/OfficialMcpCard";
import { CommunityDrawerBoundary } from "../../../../src/features/community/CommunityPresentation";
import {
  ApplicationModalIsolationProvider,
  createApplicationModalIsolationStore,
} from "../../../../src/app/applicationModalIsolation";
import { I18nProvider } from "../../../../src/core/i18n/index";
import "../../../../src/core/theme/themeTokens.css";
import "../../../../src/features/community/community.css";
const store = createApplicationModalIsolationStore();
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale="zh-CN">
    <ApplicationModalIsolationProvider store={store}>
      <div
        className="react-nav-shell"
        style={{
          height: "100vh",
          display: "flex",
          background: "var(--bg-base)",
          color: "var(--text-primary)",
        }}
      >
        <CommunityDrawerBoundary>
          <main className="community-page">
            <header className="page-header">
              <div>
                <h1 className="page-title">社区</h1>
                <p className="page-sub">找到顺手的扩展，让创作更自在。</p>
              </div>
            </header>
            <div className="community-tabs">
              <button className="community-tab is-active">插件</button>
              <button className="community-tab">主题</button>
              <button className="community-tab">模板 / 工作流</button>
            </div>
            <OfficialMcpCard />
          </main>
        </CommunityDrawerBoundary>
      </div>
    </ApplicationModalIsolationProvider>
  </I18nProvider>,
);
