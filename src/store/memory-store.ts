import type { Event, Project } from '../domain/types.js';
import { StoreDuplicateError, StoreNotFoundError, cloneProject, type Store } from './store.js';

export class MemoryStore implements Store {
  private readonly projects = new Map<string, Project>();
  private readonly events = new Map<string, Event[]>();

  async createProject(project: Project): Promise<void> {
    if (this.projects.has(project.id)) throw new StoreDuplicateError();
    this.projects.set(project.id, cloneProject(project));
  }

  async getProject(id: string): Promise<Project> {
    const project = this.projects.get(id);
    if (!project) throw new StoreNotFoundError();
    return cloneProject(project);
  }

  async saveProject(project: Project): Promise<void> {
    if (!this.projects.has(project.id)) throw new StoreNotFoundError();
    this.projects.set(project.id, cloneProject(project));
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

  async listEvents(projectId: string, after = 0): Promise<Event[]> {
    return (this.events.get(projectId) ?? [])
      .filter((event) => event.seq > after)
      .map((event) => structuredClone(event));
  }

  async close(): Promise<void> {}
}
