package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"reprolens/internal/domain"
)

func TestOpenAIExtractClaimsUsesCompatibleChatEndpoint(t *testing.T) {
	var called bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization = %q", got)
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req["model"] != "deepseek-v4.1-flash" {
			t.Errorf("model = %v", req["model"])
		}
		content := `{"claims":[{"claim_id":"C1","text":"accuracy 0.81","metric":"accuracy","expected_value":0.81,"tolerance":{"abs":0.01},"source":{"line":2,"quote":"accuracy 0.81"}}]}`
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chat_1", "object": "chat.completion", "model": "deepseek-v4.1-flash",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": content}, "finish_reason": "stop"}},
		})
	}))
	defer server.Close()

	a, err := NewOpenAICompatible(server.URL+"/v1", "test-key", "deepseek-v4.1-flash", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	paper := domain.Paper{SourcePath: "paper.md", Text: "# Paper\naccuracy = 0.81\n"}
	claims, err := a.ExtractClaims(context.Background(), paper, domain.RepoSummary{})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("server was not called")
	}
	if len(claims) != 1 || claims[0].ID != "C1" || claims[0].ExpectedValue != 0.81 {
		t.Fatalf("claims = %+v", claims)
	}
	if claims[0].Source.Path != "paper.md" || claims[0].Source.Line != 2 {
		t.Fatalf("source = %+v", claims[0].Source)
	}
}

func TestOpenAIRejectsMalformedClaimsJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "not json"}}},
		})
	}))
	defer server.Close()
	a, err := NewOpenAICompatible(server.URL+"/v1", "test-key", "deepseek-v4.1-flash", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.ExtractClaims(context.Background(), domain.Paper{Text: "accuracy=0.8"}, domain.RepoSummary{}); err == nil {
		t.Fatal("expected malformed JSON to be rejected")
	}
}
