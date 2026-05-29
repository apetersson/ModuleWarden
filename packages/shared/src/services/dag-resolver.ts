/**
 * DAG resolver for dependency-aware audit ordering.
 *
 * Given a root package name + version, recursively resolves the full transitive
 * dependency tree from upstream npm packuments, detects and breaks circular
 * dependencies, and returns a topologically sorted list of audit steps.
 *
 * Leaf packages (those with no further dependencies) are ordered first so they
 * are audited before their dependents.
 */

import type { NpmPackument } from '../npm-types.js';

/** One step in the linearised audit pipeline. */
export interface DagStep {
  packageName: string;
  packageVersion: string;
  tarballHash: string;
  depth: number;
  /** package@version references this step depends on. */
  dependsOn: string[];
  /** Position in the topological sort (0 = first leaf). */
  linearOrder: number;
}

/** Result of resolving a dependency DAG. */
export interface DagResolution {
  /** Steps in topological order (leaf deps first). */
  steps: DagStep[];
  /** Detected back-edges that were broken to make the graph acyclic. */
  cycles: Array<{ from: string; to: string }>;
}

function identity(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Parse a semver string into major.minor.patch parts.
 */
function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const cleaned = v.replace(/^[vV]/, '').split('-')[0]!; // strip pre-release
  const parts = cleaned.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

/**
 * Sort versions descending.
 */
function semverSortDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  return pb.patch - pa.patch;
}

/**
 * Resolve the latest stable version from a packument.
 * Falls back to the highest version if no dist-tags.latest exists.
 */
function resolveLatestVersion(packument: NpmPackument): string | null {
  const latestTag = packument['dist-tags']?.latest;
  if (latestTag && packument.versions[latestTag]) return latestTag;

  const versions = Object.keys(packument.versions);
  const stable = versions.filter(
    (v) => !v.includes('-') && !v.includes('rc') && !v.includes('alpha') && !v.includes('beta')
  );
  return stable.sort(semverSortDesc)[0] ?? versions.sort(semverSortDesc)[0] ?? null;
}

/**
 * Resolve the full transitive dependency DAG for a package.
 *
 * Algorithm:
 * 1. Fetch upstream packument for the root package
 * 2. Get the latest stable version
 * 3. For each dependency (dependencies + peerDependencies), recursively resolve
 * 4. Track visited nodes as `name@version` to detect and break cycles
 * 5. Topologically sort (Kahn's algorithm) ignoring back-edges
 * 6. Assign linear order based on position in sorted list
 *
 * @param rootPackage  Package name to resolve (e.g. "vite")
 * @param rootVersion  Specific version to resolve, or "latest" for auto-resolve
 * @param upstreamFetch  Function to fetch upstream packuments (injectable for testing)
 * @param maxDepth  Maximum recursion depth (prevents runaway on pathological trees)
 */
export async function resolveDependencyDag(
  rootPackage: string,
  rootVersion: string,
  upstreamFetch: (name: string) => Promise<NpmPackument | null>,
  maxDepth = 6
): Promise<DagResolution> {
  // ── Step 1: Recursive DFS to build the full graph ──────────────

  /** Visited nodes during recursion — keyed by `name@version`. */
  const visited = new Set<string>();
  /** Nodes on the current DFS path (for cycle detection). */
  const inPath = new Set<string>();
  /** Detected back-edges (cycles). */
  const cycles: Array<{ from: string; to: string }> = [];
  /** Adjacency list: node -> set of dependency node ids. */
  const edges = new Map<string, Set<string>>();
  /** Reverse adjacency: node -> set of dependent node ids. */
  const reverseEdges = new Map<string, Set<string>>();
  /** Collected step metadata. */
  const nodeMeta = new Map<string, { packageName: string; packageVersion: string; tarballHash: string; depth: number }>();

  async function dfs(
    packageName: string,
    version: string,
    depth: number
  ): Promise<void> {
    if (depth > maxDepth) return;

    // Resolve the actual version from the packument
    const packument = await upstreamFetch(packageName);
    if (!packument) return;

    const resolvedVersion = version === 'latest' ? resolveLatestVersion(packument) : version;
    if (!resolvedVersion) return;

    const nodeId = identity(packageName, resolvedVersion);
    if (visited.has(nodeId)) return;

    const versionData = packument.versions[resolvedVersion];
    if (!versionData) return;

    const tarballHash = versionData.dist?.integrity ?? versionData.dist?.shasum;
    if (!tarballHash) return;

    visited.add(nodeId);
    inPath.add(nodeId);

    nodeMeta.set(nodeId, {
      packageName,
      packageVersion: resolvedVersion,
      tarballHash,
      depth,
    });

    // Collect dependency names from all relevant dep types
    const depNames = new Set<string>();
    for (const depType of ['dependencies', 'peerDependencies'] as const) {
      const deps = versionData[depType] as Record<string, string> | undefined;
      if (deps) {
        for (const depName of Object.keys(deps)) {
          // Skip bundled, optional, and internal packages
          if (depName.startsWith('@modulewarden/') || depName.startsWith('@types/')) continue;
          depNames.add(depName);
        }
      }
    }

    if (!edges.has(nodeId)) edges.set(nodeId, new Set());
    if (!reverseEdges.has(nodeId)) reverseEdges.set(nodeId, new Set());

    for (const depName of depNames) {
      // Resolve each dependency's latest version
      const depPackument = await upstreamFetch(depName);
      if (!depPackument) continue;

      const depVersion = resolveLatestVersion(depPackument);
      if (!depVersion) continue;

      const depId = identity(depName, depVersion);

      if (inPath.has(depId)) {
        // Cycle detected — record back-edge and skip
        cycles.push({ from: nodeId, to: depId });
        continue;
      }

      // Add forward edge
      edges.get(nodeId)!.add(depId);
      if (!reverseEdges.has(depId)) reverseEdges.set(depId, new Set());
      reverseEdges.get(depId)!.add(nodeId);

      // Recurse
      await dfs(depName, depVersion, depth + 1);
    }

    inPath.delete(nodeId);
  }

  // Start DFS from root
  await dfs(rootPackage, rootVersion, 0);

  // ── Step 2: Topological sort (Kahn's algorithm) ────────────────

  const allNodes = new Set([...edges.keys(), ...reverseEdges.keys()]);
  // Include any nodes that appear only as dependencies
  for (const [_, deps] of edges) {
    for (const dep of deps) allNodes.add(dep);
  }
  for (const [_, dependents] of reverseEdges) {
    for (const dep of dependents) allNodes.add(dep);
  }

  // In-degree count (number of dependencies this node has)
  const inDegree = new Map<string, number>();
  for (const node of allNodes) {
    inDegree.set(node, edges.get(node)?.size ?? 0);
  }

  // Start with nodes that have no dependencies (leaf packages)
  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    // Sort queue to ensure deterministic ordering for nodes at same level
    queue.sort();
    const node = queue.shift()!;
    sorted.push(node);

    // Decrease in-degree for all dependents
    const dependents = reverseEdges.get(node);
    if (dependents) {
      for (const dependent of dependents) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }
  }

  // Any remaining nodes with in-degree > 0 are in a cycle
  const remaining = [...inDegree.entries()].filter(([_, deg]) => deg > 0);
  if (remaining.length > 0) {
    // These are nodes in cycles that couldn't be resolved.
    // Add them at the end in arbitrary order.
    for (const [node] of remaining) {
      if (!sorted.includes(node)) {
        sorted.push(node);
      }
    }
  }

  // ── Step 3: Build step array in topological order ──────────────

  const steps: DagStep[] = [];
  const nodeDepMap = new Map<string, string[]>();

  for (let i = 0; i < sorted.length; i++) {
    const nodeId = sorted[i]!;
    const meta = nodeMeta.get(nodeId);
    if (!meta) continue;

    const deps = edges.get(nodeId);
    const depList = deps ? [...deps].filter((d) => nodeMeta.has(d)) : [];
    nodeDepMap.set(nodeId, depList);

    steps.push({
      packageName: meta.packageName,
      packageVersion: meta.packageVersion,
      tarballHash: meta.tarballHash,
      depth: meta.depth,
      dependsOn: depList,
      linearOrder: i,
    });
  }

  return { steps, cycles };
}
