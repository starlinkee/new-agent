# Patched contrabass

`install.sh` builds contrabass v0.5.1 with the patches in this folder, runs its
orchestrator tests, and installs it to `$(go env GOPATH)/bin/contrabass`. Use it
instead of `go install ...@latest`, then restart contrabass (`scripts/cb`).

- `release-paused.patch`: a run that ends "successful" with no change to the branch
  (e.g. the worker stopped because the ticket already has an open PR) gets paused and
  left In Progress. Upstream never clears the pause, so the ticket is not dispatched
  again until contrabass restarts, not even after a person moves it to Todo. With the
  patch, the pause is dropped as soon as the ticket leaves In Progress (Todo, Backlog,
  In Review, Done). `release_paused_test.go` covers it.
