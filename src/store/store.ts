import type { Event, Project } from '../domain/types.js';

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

export interface Store {
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project>;
  saveProject(project: Project): Promise<void>;
  listProjects(): Promise<Project[]>;
  appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event>;
  listEvents(projectId: string, after?: number): Promise<Event[]>;
  close(): Promise<void>;
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}
