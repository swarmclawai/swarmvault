import type { ReactNode } from "react";

type TabDef = { id: string; label: string; count?: number };

type TabsProps = {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  children: ReactNode;
};

export function Tabs({ tabs, activeTab, onTabChange, children }: TabsProps) {
  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    onTabChange(tabs[nextIndex].id);
    const nextButton = event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined;
    nextButton?.focus();
  };

  return (
    <div className="tabs">
      <div className="tab-bar" role="tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`tab-btn${activeTab === tab.id ? " is-active" : ""}`}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 ? <span className="tab-count">{tab.count}</span> : null}
          </button>
        ))}
      </div>
      <div id={`tabpanel-${activeTab}`} className="tab-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {children}
      </div>
    </div>
  );
}
