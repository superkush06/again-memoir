# Project workflow

## Keep GitHub current after every improvement

The user requires every completed project improvement to be committed and pushed
to GitHub promptly. This applies to every chat and worktree working on this
repository. Do not wait until the end of a larger task to publish finished steps.

- After each coherent improvement, review its diff, run the relevant checks,
  commit the completed changes with a descriptive message, and push immediately
  to the matching branch on `origin`.
- For a new branch, set its upstream with `git push -u origin <branch>`. For a
  detached worktree, create a descriptive `codex/` branch before publishing.
- Verify that the published remote branch contains the commit. Include the
  branch and commit in completion reports; distinguish published branch work
  from work merged into `main`.
- When several chats share a checkout, stage only files or hunks belonging to
  your completed improvement. Preserve other chats' edits and staged work.
- Publish completed worktree commits even when longer acceptance tests are still
  running, while clearly reporting that validation status. Do not merge changes
  into `main` merely to synchronize GitHub.
- Preserve frozen test versions and the user's existing data exclusions. Do not
  add local media, generated models, caches, credentials, or `.local` artifacts
  merely to make the working tree clean.
- Never force-push, discard someone else's work, or rewrite shared history to
  resolve a rejected push. Fetch and reconcile safely in an isolated checkout
  when needed, or report the specific conflict or authentication blocker.
- A change is not fully delivered until its push succeeds. If blocked, retain
  the local commit and report what prevented publication.

## Validation

Use focused tests for the changed behavior. For application changes, use the
relevant project checks (`npm test`, `npm run typecheck`, and `npm run build` as
appropriate). Documentation-only changes need a diff review, not a full build.
Do not start duplicate native inference jobs or change frozen runtime files
while another chat is testing a pinned version.
