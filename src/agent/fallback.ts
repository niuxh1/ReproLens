import type { Analyzer } from './analyzer.js';
import type { Claim, Diagnosis, ExperimentPlan, Paper, RepoSummary, Run } from '../domain/types.js';

export class FallbackAnalyzer implements Analyzer {
  constructor(
    private readonly primary: Analyzer | null,
    private readonly secondary: Analyzer | null,
    private readonly onFallback: (error: Error) => void = () => undefined,
  ) {}

  async extractClaims(paper: Paper, repo: RepoSummary): Promise<Claim[]> {
    if (this.primary) {
      try {
        const claims = await this.primary.extractClaims(paper, repo);
        if (claims.length > 0) return claims;
        this.onFallback(new Error('primary analyzer returned no claims'));
      } catch (error) {
        this.onFallback(error as Error);
      }
    }
    if (!this.secondary) throw new Error('no analyzer available');
    return this.secondary.extractClaims(paper, repo);
  }

  async buildPlan(claim: Claim, paper: Paper, repo: RepoSummary): Promise<ExperimentPlan> {
    if (this.primary) {
      try {
        const plan = await this.primary.buildPlan(claim, paper, repo);
        if (plan?.command) return plan;
        this.onFallback(new Error('primary analyzer returned no usable plan'));
      } catch (error) {
        this.onFallback(error as Error);
      }
    }
    if (!this.secondary) throw new Error('no analyzer available');
    return this.secondary.buildPlan(claim, paper, repo);
  }

  async diagnose(run: Run, repo: RepoSummary, workspace: string): Promise<Diagnosis> {
    if (this.primary) {
      try {
        const diagnosis = await this.primary.diagnose(run, repo, workspace);
        if (diagnosis?.failure_class) {
          if (!diagnosis.patch_diff && this.secondary) {
            try {
              const secondary = await this.secondary.diagnose(run, repo, workspace);
              if (secondary.patch_diff) {
                this.onFallback(new Error('primary diagnosis had no safe patch'));
                return secondary;
              }
            } catch {
              // Keep the primary diagnosis if the optional secondary diagnosis fails.
            }
          }
          return diagnosis;
        }
        this.onFallback(new Error('primary analyzer returned no diagnosis'));
      } catch (error) {
        this.onFallback(error as Error);
      }
    }
    if (!this.secondary) throw new Error('no analyzer available');
    return this.secondary.diagnose(run, repo, workspace);
  }
}
