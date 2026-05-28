import { execSync, exec as execCb } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { logger } from '@modulewarden/shared/services/logger';

const execAsync = promisify(execCb);

export interface ContainerInputs {
  /** Run-scoped RPC token */
  rpcToken: string;
  /** RPC port inside container */
  rpcPort: number;
  /** Package tarball path (on host, to mount) */
  packageTarballPath?: string;
  /** Package workspace root */
  packageName: string;
  packageVersion: string;
  /** Last-known-good baseline tarball path (optional) */
  baselineTarballPath?: string;
  /** Path to prepared evidence files */
  evidenceDir?: string;
  /** Path to run instructions file */
  instructionsPath?: string;
  /** Path to diff/patch file (optional) */
  diffPath?: string;
}

export interface ContainerResult {
  /** Container ID */
  containerId: string;
  /** Temp workspace path on host */
  workspacePath: string;
  /** Evidence artifacts collected */
  evidenceArtifacts: string[];
  /** Exit code */
  exitCode: number | null;
  /** Signal that killed the container */
  signal: string | null;
  /** Error message if any */
  error?: string;
}

/**
 * ModuleWarden audit container runner.
 *
 * Creates disposable Docker containers for each audit job with:
 * - Isolated temp workspace
 * - Run-scoped RPC token
 * - Recorded-open egress (public internet only)
 * - No access to ModuleWarden internal services
 * - Automatic cleanup on completion/timeout/crash
 */
export class ContainerRunner {
  private readonly imageName: string;
  private readonly auditNetworkName: string;
  private readonly containerTimeoutMs: number;
  private readonly workspaceRoot: string;

  constructor(opts: {
    imageName: string;
    auditNetworkName?: string;
    containerTimeoutMs?: number;
    workspaceRoot?: string;
  }) {
    this.imageName = opts.imageName;
    this.auditNetworkName = opts.auditNetworkName ?? 'mw-audit-net';
    this.containerTimeoutMs = opts.containerTimeoutMs ?? 600_000; // 10 min
    this.workspaceRoot = opts.workspaceRoot ?? tmpdir();
  }

  /**
   * Ensure the audit network exists.
   * Created as a bridge network so containers get internet NAT access
   * but cannot reach other Compose services unless explicitly connected.
   */
  async ensureNetwork(): Promise<void> {
    try {
      execSync(`docker network inspect ${this.auditNetworkName}`, { stdio: 'ignore' });
    } catch {
      // Network doesn't exist — create it
      execSync(
        `docker network create ${this.auditNetworkName}`,
        { stdio: 'pipe' }
      );
    }
  }

  /**
   * Run an audit container and return the results.
   *
   * Steps:
   * 1. Create temp workspace directory
   * 2. Write run config and instructions
   * 3. Create and start the container
   * 4. Wait for completion or timeout
   * 5. Capture evidence artifacts
   * 6. Destroy the container
   * 7. Return collected results
   */
  async run(inputs: ContainerInputs): Promise<ContainerResult> {
    await this.ensureNetwork();

    // 1. Create temp workspace
    mkdirSync(this.workspaceRoot, { recursive: true });
    const workspacePath = mkdtempSync(join(this.workspaceRoot, 'mw-audit-'));
    const evidenceDir = join(workspacePath, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });

    // Create output directory in workspace
    const outputDir = join(workspacePath, 'output');
    mkdirSync(outputDir, { recursive: true });

    // 2. Write run configuration (S-4: rpcToken omitted — passed via MW_RPC_TOKEN env var)
    const configPath = join(workspacePath, 'run-config.json');
    writeFileSync(configPath, JSON.stringify({
      rpcPort: inputs.rpcPort,
      packageName: inputs.packageName,
      packageVersion: inputs.packageVersion,
    }, null, 2));

    // Write run instructions if provided
    if (inputs.instructionsPath) {
      const instructionsContent = inputs.instructionsPath;
      // Copy instructions file into workspace
      execSync(`cp "${instructionsContent}" "${workspacePath}/instructions.md"`, { stdio: 'pipe' });
    }

    // 3. Build docker run command
    const containerName = `mw-audit-${inputs.packageName}-${inputs.packageVersion}-${Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

    const envVars = [
      `MW_RPC_TOKEN=${inputs.rpcToken}`,
      `MW_RPC_PORT=${inputs.rpcPort}`,
      `MW_WORKSPACE=/workspace`,
      `MW_PACKAGE_NAME=${inputs.packageName}`,
      `MW_PACKAGE_VERSION=${inputs.packageVersion}`,
      // Pass through ModuleWarden API URL and model endpoint from worker env
      ...(process.env.MW_API_BASE ? [`MW_API_BASE=${process.env.MW_API_BASE}`] : []),
      ...(process.env.MW_MODEL_ENDPOINT_BASE_URL ? [`MW_MODEL_ENDPOINT_BASE_URL=${process.env.MW_MODEL_ENDPOINT_BASE_URL}`] : []),
      ...(process.env.MW_MODEL_ENDPOINT_API_KEY ? [`MW_MODEL_ENDPOINT_API_KEY=${process.env.MW_MODEL_ENDPOINT_API_KEY}`] : []),
      ...(process.env.MW_MODEL_ENDPOINT_MODEL ? [`MW_MODEL_ENDPOINT_MODEL=${process.env.MW_MODEL_ENDPOINT_MODEL}`] : []),
    ];

    const volumeMounts = [
      `${workspacePath}:/workspace`,
    ];

    if (inputs.packageTarballPath) {
      const targetDir = join(workspacePath, 'inputs');
      mkdirSync(targetDir, { recursive: true });
      execSync(`cp "${inputs.packageTarballPath}" "${targetDir}/package.tgz"`, { stdio: 'pipe' });
    }

    if (inputs.baselineTarballPath) {
      const targetDir = join(workspacePath, 'inputs');
      mkdirSync(targetDir, { recursive: true });
      execSync(`cp "${inputs.baselineTarballPath}" "${targetDir}/baseline.tgz"`, { stdio: 'pipe' });
    }

    if (inputs.evidenceDir) {
      execSync(`cp -r "${inputs.evidenceDir}/." "${workspacePath}/prepared-evidence/"`, { stdio: 'pipe' });
    }

    if (inputs.diffPath) {
      execSync(`cp "${inputs.diffPath}" "${workspacePath}/diff.patch"`, { stdio: 'pipe' });
    }

    // Build volume mount args
    const volumeArgs = volumeMounts.map(v => `-v "${v}"`).join(' ');
    const envArgs = envVars.map(e => `-e "${e}"`).join(' ');

    const runCommand = [
      'docker create',
      '--name', containerName,
      `--network ${this.auditNetworkName}`,
      volumeArgs,
      envArgs,
      '--cap-drop=ALL',                    // Drop all capabilities
      '--security-opt=no-new-privileges:true', // No privilege escalation
      '--read-only',                       // Read-only root filesystem
      `--tmpfs /tmp:rw,noexec,nosuid,size=100m`, // Writable temp
      '--label', `mw.audit=${inputs.packageName}@${inputs.packageVersion}`,
      this.imageName,
    ].join(' ');

    let containerId: string;
    try {
      // 4. Create container
      const createOutput = execSync(
        runCommand,
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      containerId = createOutput;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cleanup workspace
      rmSync(workspacePath, { recursive: true, force: true });
      throw new Error(`Failed to create audit container: ${message}`, { cause: err });
    }

    try {
      // 5. Start the container
      execSync(`docker start ${containerId}`, { stdio: 'pipe' });

      // 6. Wait for completion with timeout
      const startTime = Date.now();
      let exitCode: number | null = null;
      let signal: string | null = null;

      // Poll for completion — container stays around because we didn't use --rm
      while (Date.now() - startTime < this.containerTimeoutMs) {
        try {
          const { stdout } = await execAsync(
            `docker inspect ${containerId} --format='{{json .State}}'`
          );
          const inspectOutput = JSON.parse(stdout);

          if (inspectOutput.Status === 'exited') {
            exitCode = inspectOutput.ExitCode;
            signal = inspectOutput.Signal;
            break;
          }

          if (inspectOutput.Status === 'running') {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          // Unexpected state
          break;
        } catch {
          // Container inspect failed — may have crashed
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // Timeout check — kill if still running
      if (exitCode === null) {
        try {
          await execAsync(`docker kill ${containerId}`);
        } catch (err) {
          logger.warn('Container kill failed (best-effort)', { containerId, error: err instanceof Error ? err.message : String(err) });
        }
        // Get final state after kill
        try {
          const { stdout } = await execAsync(
            `docker inspect ${containerId} --format='{{json .State}}'`
          );
          const finalState = JSON.parse(stdout);
          exitCode = finalState.ExitCode;
          signal = finalState.Signal;
        } catch (err) {
          logger.warn('Container inspect failed (may have crashed)', { containerId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      try {
        const logs = execSync(`docker logs ${containerId} 2>&1`, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: 'pipe',
        });
        writeFileSync(join(outputDir, 'container.log'), logs);
      } catch (err) {
        logger.warn('Container log capture failed (preserving audit result)', { containerId, error: err instanceof Error ? err.message : String(err) });
      }

      // 7. Capture evidence artifacts from workspace/output
      const evidenceArtifacts: string[] = [];
      if (existsSync(outputDir)) {
        const files = execSync(
          `find "${outputDir}" -type f 2>/dev/null || true`,
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim().split('\n').filter(Boolean);

        for (const file of files) {
          const destPath = join(evidenceDir, file.replace(outputDir, '').replace(/^\//, ''));
          mkdirSync(join(evidenceDir, file.replace(outputDir, '').replace(/^[/\\]/, '')).replace(/[/\\][^/\\]+$/, ''), { recursive: true });
          try {
            execSync(`cp "${file}" "${destPath}"`, { stdio: 'pipe' });
            evidenceArtifacts.push(destPath);
          } catch (err) {
            logger.warn('Failed to copy artifact from container (file may have disappeared)', { containerId, path: file, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // 8. Destroy the container
      try {
        execSync(`docker rm -f ${containerId}`, { stdio: 'pipe' });
      } catch { /* ignore cleanup errors */ }

      const result: ContainerResult = {
        containerId,
        workspacePath,
        evidenceArtifacts,
        exitCode,
        signal,
      };

      if (exitCode !== 0) {
        result.error = `Container exited with code ${exitCode}${signal ? ` (signal: ${signal})` : ''}`;
      }

      return result;
    } catch (err) {
      // Ensure cleanup on any error
      try {
        execSync(`docker rm -f ${containerId}`, { stdio: 'pipe' });
      } catch { /* ignore */ }

      const message = err instanceof Error ? err.message : String(err);
      return {
        containerId,
        workspacePath,
        evidenceArtifacts: [],
        exitCode: null,
        signal: null,
        error: message,
      };
    }
  }

  /**
   * Preserve a completed audit workspace for post-run inspection.
   *
   * The archived copy intentionally redacts the run-scoped RPC token from
   * run-config.json. The live workspace is left untouched for evidence capture.
   */
  archiveWorkspace(workspacePath: string, archiveRoot: string, archiveName: string): string {
    const safeName = archiveName.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const archivePath = join(archiveRoot, safeName);
    mkdirSync(archiveRoot, { recursive: true });
    rmSync(archivePath, { recursive: true, force: true });
    cpSync(workspacePath, archivePath, { recursive: true, force: true });
    this.redactArchivedRunConfig(archivePath);
    return archivePath;
  }

  /**
   * Clean up a workspace directory.
   */
  cleanupWorkspace(workspacePath: string): void {
    try {
      rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  private redactArchivedRunConfig(archivePath: string): void {
    // S-4: rpcToken is no longer written to new run-config.json.
    // This function handles backward compatibility with archived workspaces
    // that may still contain the legacy token field.
    const configPath = join(archivePath, 'run-config.json');
    if (!existsSync(configPath)) return;

    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if ('rpcToken' in config) {
        config.rpcToken = '[redacted-after-run]';
        writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    } catch {
      // Preserve the session even if redaction cannot parse the config.
    }
  }
}
