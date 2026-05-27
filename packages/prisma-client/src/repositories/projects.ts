import { getPrisma } from '../index.js';
import type { Project } from '@prisma/client';

export async function createProject(name: string, description?: string): Promise<Project> {
  return getPrisma().project.create({
    data: { name, description },
  });
}

export async function getProject(id: string): Promise<Project | null> {
  return getPrisma().project.findUnique({ where: { id } });
}

export async function getProjectByName(name: string): Promise<Project | null> {
  return getPrisma().project.findUnique({ where: { name } });
}

export async function listProjects(): Promise<Project[]> {
  return getPrisma().project.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function updateProjectGraphState(
  id: string,
  graphState: 'IMPORTING' | 'AUDITING' | 'READY'
): Promise<Project> {
  return getPrisma().project.update({
    where: { id },
    data: { graphState },
  });
}

export async function enableProjectRegistry(id: string): Promise<Project> {
  return getPrisma().project.update({
    where: { id },
    data: { registryEnabled: true, graphState: 'READY' },
  });
}

export async function isProjectRegistryReady(id: string): Promise<boolean> {
  const project = await getPrisma().project.findUnique({
    where: { id },
    select: { registryEnabled: true },
  });
  return project?.registryEnabled ?? false;
}
