-- Explicit provider selection and card-wide caps. NULL modes retain old
-- callers' board-default behavior; 'none' never silently invents a cap.
ALTER TABLE dispatches ADD COLUMN ai TEXT CHECK (ai IN ('claude', 'codex'));
ALTER TABLE dispatches ADD COLUMN budget_mode TEXT CHECK (budget_mode IN ('none', 'cap'));
ALTER TABLE dispatches ADD COLUMN budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0);
ALTER TABLE runs ADD COLUMN ai TEXT CHECK (ai IN ('claude', 'codex'));
ALTER TABLE runs ADD COLUMN budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents >= 0);
ALTER TABLE runs ADD COLUMN terminal_reason TEXT CHECK (terminal_reason IN ('budget', 'budget_device'));
