package codeagent

import (
	"context"
	"sync"
)

type Mock struct {
	mu     sync.Mutex
	Result *Result
	Err    error
	Calls  int
}

func (m *Mock) Name() string { return "mock-code-agent" }

func (m *Mock) Propose(_ context.Context, _ Task) (*Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Calls++
	if m.Err != nil {
		return nil, m.Err
	}
	return m.Result, nil
}
