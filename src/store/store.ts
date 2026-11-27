import type { Event, Operation, Project } from '../domain/types.js';

export class StoreNotFoundError extends Error {
  constructor(message = 'project not found') {
    super(message);
    this.name = 'StoreNotFoundError';
  }
}

export class StoreDuplicateError extends Error {
  constructor(message = 'project already exists') {
    super(message);
    this.name = 'StoreDuplicateError';
  }
}

export class StoreBusyError extends Error {
  constructor(message = 'project already has an exclusive running operation') {
    super(message);
    this.name = 'StoreBusyError';
  }
}

export class StoreConflictError extends Error {
  constructor(message = 'project was modified by another operation') {
    super(message);
    this.name = 'StoreConflictError';
  }
}

export interface Store {
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project>;
  saveProject(project: Project, expectedRevision?: number): Promise<Project>;
  saveProjectAndEvent(project: Project, type: string, message: string, data?: Record<string, unknown>): Promise<{ project: Project; event: Event }>;
  listProjects(): Promise<Project[]>;
  appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event>;
  listEvents(projectId: string, after?: number, limit?: number): Promise<Event[]>;
  createOperation(operation: Operation): Promise<void>;
  getOperation(id: string): Promise<Operation>;
  saveOperation(operation: Operation): Promise<Operation>;
  findOperationByIdempotencyKey(key: string): Promise<Operation | null>;
  listOperations(projectId?: string): Promise<Operation[]>;
  renewOperationLease(id: string, owner: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean>;
  finishOperation(id: string, owner: string, status: 'succeeded' | 'failed', finishedAt: string, resultRevision?: number, error?: string): Promise<boolean>;
  abandonExpiredOperations(now: string, reason: string): Promise<number>;
  close(): Promise<void>;
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}