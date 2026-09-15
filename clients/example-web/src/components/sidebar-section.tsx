import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

interface SidebarSectionProps {
  readonly action?: {
    readonly disabled?: boolean;
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: () => void;
  };
  readonly children: ReactNode;
  readonly empty?: string;
  readonly title: string;
}

export function SidebarSection({ action, children, empty, title }: SidebarSectionProps) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : children !== null;
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-heading">
        <span>{title}</span>
        {action === undefined ? null : (
          <Button
            aria-label={action.label}
            className="compact-icon"
            disabled={action.disabled}
            onClick={action.onClick}
            size="icon"
            type="button"
            variant="ghost"
          >
            {action.icon}
          </Button>
        )}
      </div>
      {hasChildren ? (
        children
      ) : empty === undefined ? null : (
        <p className="section-empty">{empty}</p>
      )}
    </section>
  );
}
