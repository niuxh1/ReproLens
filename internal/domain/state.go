package domain

import "fmt"

var transitions = map[State]map[Action]State{
	StateCreated: {
		ActionInit: StateInitialized,
	},
	StateInitialized: {
		ActionIngest: StateIngested,
	},
	StateIngested: {
		ActionExtractClaims: StateAwaitingClaims,
	},
	StateAwaitingClaims: {
		ActionSelectClaims: StateAwaitingPlan,
	},
	StateAwaitingPlan: {
		ActionConfirmPlan: StateSandboxReady,
	},
	StateSandboxReady: {
		ActionStartExecution: StateExecuting,
	},
	StateExecuting: {
		ActionRunSucceeded: StateVerifying,
		ActionRunFailed:    StateAwaitingPatch,
	},
	StateAwaitingPatch: {
		ActionApprovePatch: StateRetrying,
		ActionRejectPatch:  StateFailed,
	},
	StateRetrying: {
		ActionRetryStart: StateExecuting,
	},
	StateVerifying: {
		ActionVerificationCompleted: StateReporting,
	},
	StateReporting: {
		ActionReportCompleted: StateCompleted,
	},
}

func CanTransition(from State, action Action) (State, bool) {
	if from.Terminal() {
		return "", false
	}
	if action == ActionStop {
		return StateStopped, true
	}
	if action == ActionFail {
		return StateFailed, true
	}
	byAction, ok := transitions[from]
	if !ok {
		return "", false
	}
	to, ok := byAction[action]
	return to, ok
}

func ValidateTransition(from State, action Action) error {
	if _, ok := CanTransition(from, action); !ok {
		return fmt.Errorf("invalid transition: state %s cannot perform action %s", from, action)
	}
	return nil
}

func (s State) Terminal() bool {
	return s == StateCompleted || s == StateFailed || s == StateStopped
}

func (s State) Label() string {
	switch s {
	case StateCreated:
		return "Created"
	case StateInitialized:
		return "Workspace initialized"
	case StateIngested:
		return "Paper and repository ingested"
	case StateAwaitingClaims:
		return "Awaiting claim selection"
	case StateAwaitingPlan:
		return "Awaiting plan confirmation"
	case StateSandboxReady:
		return "Sandbox ready"
	case StateExecuting:
		return "Executing experiment"
	case StateAwaitingPatch:
		return "Awaiting patch approval"
	case StateRetrying:
		return "Applying approved patch"
	case StateVerifying:
		return "Verifying observed value"
	case StateReporting:
		return "Generating evidence report"
	case StateCompleted:
		return "Completed"
	case StateFailed:
		return "Failed"
	case StateStopped:
		return "Stopped"
	default:
		return string(s)
	}
}
