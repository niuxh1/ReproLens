package domain

import "testing"

func TestHappyPathTransitions(t *testing.T) {
	steps := []struct {
		from   State
		action Action
		want   State
	}{
		{StateCreated, ActionInit, StateInitialized},
		{StateInitialized, ActionIngest, StateIngested},
		{StateIngested, ActionExtractClaims, StateAwaitingClaims},
		{StateAwaitingClaims, ActionSelectClaims, StateAwaitingPlan},
		{StateAwaitingPlan, ActionConfirmPlan, StateSandboxReady},
		{StateSandboxReady, ActionStartExecution, StateExecuting},
		{StateExecuting, ActionRunSucceeded, StateVerifying},
		{StateVerifying, ActionVerificationCompleted, StateReporting},
		{StateReporting, ActionReportCompleted, StateCompleted},
	}
	for _, step := range steps {
		got, ok := CanTransition(step.from, step.action)
		if !ok {
			t.Fatalf("CanTransition(%s, %s) rejected", step.from, step.action)
		}
		if got != step.want {
			t.Fatalf("transition = %s, want %s", got, step.want)
		}
	}
}

func TestPatchApprovalRequiresAwaitingPatch(t *testing.T) {
	if _, ok := CanTransition(StateAwaitingPlan, ActionApprovePatch); ok {
		t.Fatal("patch approval must be rejected outside AWAITING_PATCH")
	}
	got, ok := CanTransition(StateAwaitingPatch, ActionApprovePatch)
	if !ok || got != StateRetrying {
		t.Fatalf("approved patch transition = (%s, %v), want (RETRYING, true)", got, ok)
	}
}

func TestFailureAndStopTransitions(t *testing.T) {
	if got, ok := CanTransition(StateExecuting, ActionRunFailed); !ok || got != StateAwaitingPatch {
		t.Fatalf("run failure = (%s, %v)", got, ok)
	}
	if got, ok := CanTransition(StateAwaitingPatch, ActionRejectPatch); !ok || got != StateFailed {
		t.Fatalf("reject patch = (%s, %v)", got, ok)
	}
	if got, ok := CanTransition(StateExecuting, ActionStop); !ok || got != StateStopped {
		t.Fatalf("stop = (%s, %v)", got, ok)
	}
	if got, ok := CanTransition(StateCompleted, ActionStop); ok || got != "" {
		t.Fatalf("stop from terminal should be rejected: %s %v", got, ok)
	}
}

func TestValidateTransitionReturnsError(t *testing.T) {
	if err := ValidateTransition(StateAwaitingClaims, ActionApprovePatch); err == nil {
		t.Fatal("expected invalid transition error")
	}
	if err := ValidateTransition(StateAwaitingClaims, ActionSelectClaims); err != nil {
		t.Fatalf("unexpected transition error: %v", err)
	}
}