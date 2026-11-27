import type { Event, Operation, Project } from '../domain/types.js';
import { StoreBusyError, StoreConflictError, StoreDuplicateError, StoreNotFoundError, cloneProject, type Store } from './store.js';

export class MemoryStore implements Store {
  private readonly projects = new Map<string, Project>();
  private readonly events = new Map<string, Event[]>();
  private readonly operations = new Map<string, Operation>();

  async createProject(project: Project): Promise<void> {
    if (this.projects.has(project.id)) throw new StoreDuplicateError();
    this.projects.set(project.id, cloneProject({ ...project, revision: project.revision ?? 1 }));
  }

  async getProject(id: string): Promise<Project> {
    const project = this.projects.get(id);
    if (!project) throw new StoreNotFoundError();
    return cloneProject(project);
  }

  async saveProject(project: Project, expectedRevision?: number): Promise<Project> {
    const existing = this.projects.get(project.id);
    if (!existing) throw new StoreNotFoundError();
    const currentRevision = existing.revision ?? 1;
    const expected = expectedRevision ?? project.revision ?? currentRevision;
    if (expected !== currentRevision) throw new StoreConflictError();
    const next = cloneProject({
      ...project,
      revision: currentRevision + 1,
      updated_at: project.updated_at || new Date().toISOString(),
    });
    this.projects.set(project.id, next);
    Object.assign(project, cloneProject(next));
    return cloneProject(next);
  }

  async saveProjectAndEvent(project: Project, type: string, message: string, data?: Record<string, unknown>): Promise<{ project: Project; event: Event }> {
    const existing = this.projects.get(project.id);
    if (!existing) throw new StoreNotFoundError();
    const currentRevision = existing.revision ?? 1;
    const expected = project.revision ?? currentRevision;
    if (expected !== currentRevision) throw new StoreConflictError();
    const now = new Date().toISOString();
    const next = cloneProject({ ...project, revision: currentRevision + 1, updated_at: now });
    const events = this.events.get(project.id) ?? [];
    const event: Event = {
      id: events.length + 1, project_id: project.id, seq: events.length + 1, type, message,
      ...(data === undefined ? {} : { data: structuredClone(data) }), created_at: now,
    };
    this.projects.set(project.id, next);
    events.push(event);
    this.events.set(project.id, events);
    Object.assign(project, cloneProject(next));
    return { project: cloneProject(next), event: structuredClone(event) };
  }
  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()]
      .map(cloneProject)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event> {
    if (!this.projects.has(projectId)) throw new StoreNotFoundError();
    const events = this.events.get(projectId) ?? [];
    const event: Event = {
      id: events.length + 1,
      project_id: projectId,
      seq: events.length + 1,
      type,
      message,
      ...(data === undefined ? {} : { data: structuredClone(data) }),
      created_at: new Date().toISOString(),
    };
    events.push(event);
    this.events.set(projectId, events);
    return structuredClone(event);
  }

  async listEvents(projectId: string, after = 0, limit = 10_000): Promise<Event[]> {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    return (this.events.get(projectId) ?? [])
      .filter((event) => event.seq > after)
      .slice(0, boundedLimit)
      .map((event) => structuredClone(event));
  }

  async createOperation(operation: Operation): Promise<void> {
    if (this.operations.has(operation.id)) throw new StoreDuplicateError('operation already exists');
    if (operation.idempotency_key && [...this.operations.values()].some((item) => item.idempotency_key === operation.idempotency_key)) {
      throw new StoreDuplicateError('idempotency key already exists');
    }
    if (operation.status === 'running' && operation.kind !== 'stop'
      && [...this.operations.values()].some((item) => item.project_id === operation.project_id && item.status === 'running' && item.kind !== 'stop')) {
      throw new StoreBusyError();
    }
    this.operations.set(operation.id, structuredClone(operation));
  }

  async getOperation(id: string): Promise<Operation> {
    const operation = this.operations.get(id);
    if (!operation) throw new StoreNotFoundError('operation not found');
    return structuredClone(operation);
  }

  async saveOperation(operation: Operation): Promise<Operation> {
    if (!this.operations.has(operation.id)) throw new StoreNotFoundError('operation not found');
    const next = structuredClone({ ...operation, updated_at: operation.updated_at || new Date().toISOString() });
    this.operations.set(operation.id, next);
    return structuredClone(next);
  }

  async findOperationByIdempotencyKey(key: string): Promise<Operation | null> {
    const operation = [...this.operations.values()].find((item) => item.idempotency_key === key);
    return operation ? structuredClone(operation) : null;
  }

  async listOperations(projectId?: string): Promise<Operation[]> {
    return [...this.operations.values()]
      .filter((operation) => projectId === undefined || operation.project_id === projectId)
      .map((operation) => structuredClone(operation))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async renewOperationLease(id: string, owner: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const operation = this.operations.get(id);
    if (!operation || operation.status !== 'running' || operation.lease_owner !== owner) return false;
    this.operations.set(id, { ...operation, heartbeat_at: heartbeatAt, lease_expires_at: leaseExpiresAt, updated_at: heartbeatAt });
    return true;
  }

  async finishOperation(id: string, owner: string, status: 'succeeded' | 'failed', finishedAt: string, resultRevision?: number, error?: string): Promise<boolean> {
    const operation = this.operations.get(id);
    if (!operation || operation.status !== 'running' || operation.lease_owner !== owner) return false;
    this.operations.set(id, {
      ...operation, status, finished_at: finishedAt, updated_at: finishedAt,
      ...(resultRevision !== undefined ? { result_revision: resultRevision } : {}),
      ...(error ? { error } : {}),
    });
    return true;
  }

  async abandonExpiredOperations(now: string, reason: string): Promise<number> {
    let count = 0;
    for (const [id, operation] of this.operations) {
      if (operation.status !== 'running' || !operation.lease_expires_at || operation.lease_expires_at > now) continue;
      this.operations.set(id, { ...operation, status: 'abandoned', error: reason, finished_at: now, updated_at: now });
      count += 1;
    }
    return count;
  }

  async close(): Promise<void> {}
}