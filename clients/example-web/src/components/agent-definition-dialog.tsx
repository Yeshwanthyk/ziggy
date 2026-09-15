import { RefreshCw } from "lucide-react";
import { DefinitionEditor } from "@/components/definition-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentDefinitionDetail, AgentSummary } from "@/gateway";

interface AgentDefinitionDialogProps {
  readonly agent?: AgentSummary;
  readonly available: boolean;
  readonly detail?: AgentDefinitionDetail;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => void;
  readonly onSave: (source: string, expectedSource: string) => Promise<void>;
  readonly open: boolean;
}

export function AgentDefinitionDialog({
  agent,
  available,
  detail,
  onOpenChange,
  onRefresh,
  onSave,
  open,
}: AgentDefinitionDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="agent-definition-dialog sm:max-w-[680px]">
        <DialogHeader>
          <div className="automation-detail-heading">
            <span>
              <DialogTitle>Edit {agent?.id ?? "agent"}</DialogTitle>
              <DialogDescription>
                Saved configuration applies to new specialist sessions. Existing conversations keep
                their current runtime.
              </DialogDescription>
            </span>
            <Button
              aria-label="Refresh agent definition"
              disabled={!available || detail?.loading || agent === undefined}
              onClick={onRefresh}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw className={detail?.loading ? "is-spinning" : ""} />
            </Button>
          </div>
        </DialogHeader>
        <div className="agent-definition-body">
          {detail?.loading ? <p className="detail-loading">Loading agent definition…</p> : null}
          {detail?.error === undefined ? null : (
            <p className="detail-error" role="alert">
              {detail.error}
            </p>
          )}
          {detail?.document === undefined ? null : (
            <DefinitionEditor
              kind="agent"
              onCancel={() => onOpenChange(false)}
              onSave={onSave}
              source={detail.document.source}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
