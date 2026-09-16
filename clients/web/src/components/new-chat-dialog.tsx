import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function NewChatDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || title.trim().length === 0) return;
    setPending(true);
    setError(undefined);
    try {
      await onCreate(title.trim());
      setTitle("");
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create chat.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent className="group-dialog sm:max-w-[440px]">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New chat</DialogTitle>
            <DialogDescription>
              A separate conversation with your assistant, saved in Pinned.
            </DialogDescription>
          </DialogHeader>
          <div className="group-fields">
            <label className="field-label">
              <span>Name</span>
              <input
                autoFocus
                maxLength={80}
                placeholder="What are we working on?"
                value={title}
                disabled={pending}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || title.trim().length === 0}>
              {pending ? "Creating…" : "Create chat"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
