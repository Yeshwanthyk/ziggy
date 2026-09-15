import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useState, type FormEvent } from "react";

interface GroupAgent {
  readonly id: string;
  readonly description: string;
}

interface GroupDraft {
  readonly groupId: string;
  readonly memberAgentIds: ReadonlyArray<string>;
  readonly title: string;
}

interface GroupDialogProps {
  readonly agents: ReadonlyArray<GroupAgent>;
  readonly error?: string;
  readonly onCreate: (draft: GroupDraft) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly pending: boolean;
}

const toGroupId = (title: string): string =>
  title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);

export function GroupDialog({
  agents,
  error,
  onCreate,
  onOpenChange,
  open,
  pending,
}: GroupDialogProps) {
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setMembers(agents.slice(0, 2).map((agent) => agent.id));
  }, [agents, open]);

  const groupId = toGroupId(title);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (groupId.length === 0 || members.length === 0) return;
    await onCreate({ groupId, memberAgentIds: members, title: title.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="group-dialog sm:max-w-[440px]">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New group conversation</DialogTitle>
            <DialogDescription>
              Choose the local specialists who should join this conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="group-fields">
            <label className="field-label">
              <span>Name</span>
              <input
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Launch review"
                value={title}
              />
            </label>
            <fieldset>
              <legend>Members</legend>
              {agents.map((agent) => (
                <label className="member-option" key={agent.id}>
                  <input
                    checked={members.includes(agent.id)}
                    onChange={(event) =>
                      setMembers((current) =>
                        event.target.checked
                          ? current.length < 4
                            ? [...current, agent.id]
                            : current
                          : current.filter((member) => member !== agent.id),
                      )
                    }
                    type="checkbox"
                  />
                  <span>
                    <strong>{agent.id}</strong>
                    <small>{agent.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="field-hint">Choose up to four specialists.</p>
            {agents.length === 0 ? (
              <p className="form-error" role="alert">
                Add a Profile specialist before creating a group.
              </p>
            ) : null}
            {error === undefined ? null : (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={pending || groupId.length === 0 || members.length === 0}
              type="submit"
            >
              {pending ? "Opening…" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
