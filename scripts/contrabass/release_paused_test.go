package orchestrator

import (
	"testing"

	"github.com/junhoyeo/contrabass/internal/agent"
	"github.com/junhoyeo/contrabass/internal/types"
	"github.com/junhoyeo/contrabass/internal/workspace"
	"github.com/stretchr/testify/assert"
)

func TestReleasePausedIssues(t *testing.T) {
	orch := NewOrchestrator(newObservingTracker(nil), workspace.NewMockManager(t.TempDir()),
		&agent.MockRunner{}, &staticConfig{cfg: testConfig()}, nil)
	orch.mu.Lock()
	for _, id := range []string{"IN-PROGRESS", "BACK-TO-TODO", "IN-REVIEW"} {
		orch.paused[id] = "success_unverified_branch_unchanged"
	}
	orch.mu.Unlock()

	orch.releasePausedIssues(map[string]types.Issue{
		"IN-PROGRESS":  {ID: "IN-PROGRESS", State: types.Claimed},
		"BACK-TO-TODO": {ID: "BACK-TO-TODO", State: types.Unclaimed},
		// IN-REVIEW is in a completed state, so the tracker no longer returns it.
	})

	assert.True(t, orch.isManagedIssue("IN-PROGRESS"), "still In Progress: stays paused")
	assert.False(t, orch.isManagedIssue("BACK-TO-TODO"), "moved to Todo: dispatchable again")
	assert.False(t, orch.isManagedIssue("IN-REVIEW"), "left the active states: pause forgotten")
}
