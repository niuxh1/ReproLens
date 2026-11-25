import type { CodeAgent, CodeAgentResult, CodeAgentTask } from './code-agent.js';

export class MockCodeAgent implements CodeAgent {
  calls = 0;
  result: CodeAgentResult | null = null;
  error: Error | null = null;

  name(): string { return 'mock-code-agent'; }

  async propose(_task: CodeAgentTask): Promise<CodeAgentResult> {
    this.calls += 1;
    if (this.error) throw this.error;
    if (!this.result) throw new Error('mock code agent has no result');
    return this.result;
  }
}
