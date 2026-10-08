import { useState, type ReactNode } from "react";
export type AdminTab = { id: string; label: string };
export function useAdminTabs(initial: string) {
  return useState(initial);
}
export function AdminTabNav({
  scope,
  tabs,
  active,
  onChange,
}: {
  scope: string;
  tabs: AdminTab[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav
      className="admin-section-tabs"
      role="tablist"
      aria-label="页面内容分区"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`admin-tab-${scope}-${tab.id}`}
          aria-controls={`admin-section-${scope}-${tab.id}`}
          aria-selected={active === tab.id}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            let next;
            const index = tabs.findIndex((t) => t.id === active);
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft")
              next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = tabs.length - 1;
            else return;
            event.preventDefault();
            onChange(tabs[next].id);
            (
              event.currentTarget.parentElement?.children[next] as HTMLElement
            )?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
// Keep panels mounted so switching tabs never resets forms or unsaved edits.
export function AdminTabPanel({
  scope,
  id,
  active,
  children,
}: {
  scope: string;
  id: string;
  active: string;
  children: ReactNode;
}) {
  return (
    <div
      className="admin-section-panel"
      id={`admin-section-${scope}-${id}`}
      role="tabpanel"
      aria-labelledby={`admin-tab-${scope}-${id}`}
      hidden={active !== id}
    >
      {children}
    </div>
  );
}
