# Treat non-ignored Git worktree content as protected

The cleaner will not mutate any artifact inside a Git worktree unless Git classifies it as ignored, even when force is requested. Skills committed to or merely present as unignored project source belong to the repository's normal change workflow, while `skill-cleaner` is responsible for installed or generated capabilities rather than editing source code.
