import { exec } from "child_process";
import * as path from "path";

export interface Commit {
  hash: string;
  message: string;
  diff: string;
  projectName: string;
}

export class GitService {
  /**
   * Executes a shell command and returns the stdout string.
   */
  private static runCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
          // Resolve empty stdout rather than crashing if git is missing or not a repo
          resolve("");
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * Retrieves commits from a repository path for a specific calendar date (YYYY-MM-DD).
   */
  public static async getCommitsForDay(
    repoPath: string,
    dateStr: string,
    projectName: string
  ): Promise<Commit[]> {
    // Check git status in directory
    const isGitRepo = await this.runCommand("git rev-parse --is-inside-work-tree", repoPath);
    if (isGitRepo !== "true") {
      console.log(`LogMyCode: Directory ${repoPath} is not a valid git repository.`);
      return [];
    }

    // Git log for specific date: since 00:00:00 to 23:59:59
    // Formatting: hash||message
    const logCommand = `git log --since="${dateStr}T00:00:00" --until="${dateStr}T23:59:59" --pretty=format:"%H||%s"`;
    const logOutput = await this.runCommand(logCommand, repoPath);

    if (!logOutput) {
      return [];
    }

    const lines = logOutput.split("\n").filter((line) => line.trim().length > 0);
    const commits: Commit[] = [];

    for (const line of lines) {
      const parts = line.split("||");
      if (parts.length < 2) continue;

      const hash = parts[0].trim();
      const message = parts.slice(1).join("||").trim();

      // Retrieve compact diff using: git show -U1 --no-color --pretty=format:"" <hash>
      const showCommand = `git show -U1 --no-color --pretty=format:"" ${hash}`;
      const diff = await this.runCommand(showCommand, repoPath);

      commits.push({
        hash,
        message,
        diff,
        projectName,
      });
    }

    return commits;
  }

  /**
   * Resolves a folder's display project name:
   * Returns user custom mapped name, or falls back to folder folder-name.
   */
  public static getProjectDisplayName(folderPath: string, mappings: Array<{ folder_path: string; project_name: string }>): string {
    const matched = mappings.find(
      (m) => path.resolve(m.folder_path) === path.resolve(folderPath)
    );
    if (matched) {
      return matched.project_name;
    }
    // Fallback to directory base name
    try {
      return path.basename(folderPath) || "General";
    } catch {
      return "General";
    }
  }
}
