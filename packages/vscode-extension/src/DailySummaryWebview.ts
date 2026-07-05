import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { GitService, Commit } from "./GitService.js";

export class DailySummaryWebview {
  public static currentPanel: DailySummaryWebview | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DailySummaryWebview.currentPanel) {
      DailySummaryWebview.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "logmycodeDashboard",
      "LogMyCode Dashboard",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
      }
    );

    DailySummaryWebview.currentPanel = new DailySummaryWebview(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = context.extensionUri;
    this._context = context;

    // Set HTML content
    this._updateHtml();

    // Listen for panel closure
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );

    // Sync initial state
    this._syncState();
  }

  private _updateHtml() {
    const webview = this._panel.webview;
    
    // Local path to main script and style run in webview
    const scriptPathOnDisk = vscode.Uri.file(
      path.join(this._context.extensionPath, "media", "script.js")
    );
    const stylePathOnDisk = vscode.Uri.file(
      path.join(this._context.extensionPath, "media", "style.css")
    );

    // URI conversions
    const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
    const styleUri = webview.asWebviewUri(stylePathOnDisk);

    // Content Security Policy
    const cspSource = webview.cspSource;
    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https:; connect-src *;">
  <link rel="stylesheet" href="${styleUri}">
  <title>LogMyCode Dashboard</title>
</head>
<body>
  <!-- Authentication Overlay (Force Login) -->
  <div id="auth-overlay" class="auth-overlay" style="display: none;">
    <div class="auth-overlay-content">
      <div style="font-size: 28px; font-weight: bold; margin-bottom: 8px; color: var(--vscode-button-background); background: linear-gradient(90deg, var(--accent-indigo), var(--accent-cyan)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">LogMyCode</div>
      <div style="font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 24px; text-align: center; line-height: 1.5;">
        Track development history, generate product-ready daily updates, and query your semantic memory graph.
      </div>
      <button id="overlay-btn-login-demo" class="btn-primary" style="width: 100%; margin-bottom: 12px; padding: 10px 0; font-size: 13px; font-weight: 600;">Login as Judge (Demo Mode)</button>
      <button id="overlay-btn-login-github" class="btn-secondary" style="width: 100%; padding: 10px 0; font-size: 13px; font-weight: 600;">Login with GitHub</button>
    </div>
  </div>

  <!-- Header Title -->
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
    <h1 style="margin: 0; font-size: 20px; font-weight: 700; background: linear-gradient(90deg, var(--accent-indigo), var(--accent-cyan)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
      LogMyCode Dashboard
    </h1>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground)">Version 2.0.0</div>
  </div>

  <!-- Navigation Tabs -->
  <div class="tabs-header">
    <button class="tab-btn active" data-tab="summary">Daily Summary</button>
    <button class="tab-btn" data-tab="assistant">Memory Assistant</button>
    <button class="tab-btn" data-tab="settings">Settings</button>
  </div>

  <!-- TAB 1: Daily Summary -->
  <div id="summary-tab" class="tab-content active">
    <!-- Repos and custom mappings -->
    <div class="card-panel">
      <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
        <span>📂 Tracked Repositories</span>
        <button id="btn-add-folder" class="btn-secondary" style="padding: 6px 12px; font-size: 11px;">+ Add Local Folder</button>
      </div>
      <div id="repo-mappings">
        <!-- Rendered dynamically -->
      </div>
    </div>

    <!-- Date, prompts configuration -->
    <div class="card-panel">
      <div class="card-title">📝 Summary Configuration</div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label" for="summary-date">Log Date</label>
          <input type="date" id="summary-date">
        </div>
        <div class="form-group">
          <label class="form-label" for="custom-prompt">Custom Summary Directives</label>
          <input type="text" id="custom-prompt" placeholder="e.g. List technical details only, avoid corporate speak">
        </div>
      </div>
    </div>

    <!-- Commit Logs Scanner -->
    <div class="card-panel">
      <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
        <span>💻 Scanned Commits</span>
        <button id="btn-scan-commits" class="btn-secondary" style="padding: 6px 12px; font-size: 11px;">Scan Commits</button>
      </div>
      <div id="commit-list" style="margin-top: 12px; max-height: 250px; overflow-y: auto;">
        <!-- Rendered dynamically -->
      </div>
    </div>

    <!-- Manual Activities logs -->
    <div class="card-panel">
      <div class="card-title">✍️ Manual Log Activities</div>
      <div style="display: flex; gap: 8px;">
        <input type="text" id="manual-log-input" placeholder="e.g. Conducted architectural review with judges" style="flex: 1;">
        <button id="add-manual-log-btn" class="btn-secondary" style="padding: 0 16px;">+ Add</button>
      </div>
      <ul id="manual-logs-list" class="manual-logs-list">
        <!-- Rendered dynamically -->
      </ul>
    </div>

    <!-- Summary Pipeline Action triggers -->
    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
      <button id="btn-generate-summary" class="btn-primary">Generate Daily Summary</button>
      <button id="btn-regenerate-summary" class="btn-secondary">Regenerate</button>
    </div>

    <!-- Summary output report -->
    <div class="card-panel">
      <div class="card-title">📊 Generated Summary</div>
      <div id="summary-output-container">
        <div style="color: var(--vscode-descriptionForeground); text-align: center; padding: 20px;">
          Summary has not been generated yet. Set up configurations and click "Generate Daily Summary".
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 2: Memory Assistant Chat -->
  <div id="assistant-tab" class="tab-content">
    <div class="card-panel">
      <div class="card-title">
        <span>🧠 Query Cognee Memory Graph</span>
        <button id="btn-clear-chat" class="btn-secondary" style="margin-left: auto; padding: 4px 12px; font-size: 12px; height: auto;">Clear Chat</button>
      </div>
      <div class="form-group" style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <label class="form-label" style="margin: 0; white-space: nowrap;">Target Project Context:</label>
        <select id="chat-project-select" style="background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; border-radius: 4px;">
          <!-- Dynamically populated options -->
        </select>
      </div>
      
      <!-- Conversation threads -->
      <div id="chat-container" class="chat-container">
        <!-- Message bubbles -->
      </div>

      <!-- User input -->
      <div style="display: flex; gap: 8px;">
        <textarea id="chat-input" placeholder="Ask questions about your commits, e.g., 'What changes did I make to database pooling?'" style="flex: 1; min-height: 50px;"></textarea>
        <button id="btn-send-chat" class="btn-primary" style="padding: 0 20px;">Send</button>
      </div>
    </div>
  </div>

  <!-- TAB 3: Settings -->
  <div id="settings-tab" class="tab-content">
    <div class="card-panel">
      <div class="card-title">⚙️ API Server Settings</div>
      <div class="form-group">
        <label class="form-label" for="backend-url">Backend URL</label>
        <input type="text" id="backend-url" value="http://localhost:3000">
      </div>
      <button id="btn-save-settings" class="btn-primary">Save Config</button>
    </div>

    <div class="card-panel">
      <div class="card-title">🔒 User Authentication</div>
      <div class="auth-status-container">
        <span id="auth-status" class="status-dot offline"></span>
        <span id="user-profile">Checking authentication...</span>
      </div>
      <div class="auth-button-grid">
        <button id="btn-login-demo" class="btn-primary">Login as Judge (Demo Mode)</button>
        <button id="btn-login-github" class="btn-secondary">Login with GitHub</button>
        <button id="btn-logout" class="btn-secondary" style="display: none; border-color: #ff5252; color: #ff5252;">Logout</button>
      </div>
      <div id="upgrade-tier-section" style="display: none; margin-top: 16px; border-top: 1px solid var(--glass-border); padding-top: 16px;">
        <div style="font-size: 12px; margin-bottom: 8px; color: var(--vscode-descriptionForeground)">Redeem the hackathon passcode to unlock server-side LLM summaries and Memory Chat.</div>
        <button id="btn-upgrade-account" class="btn-primary" style="width: auto; padding: 6px 12px; font-size: 12px;">Upgrade to Paid Tier</button>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async _syncState() {
    const workspaceFolders = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath)
      : [];
    const customFolders = this._context.globalState.get<string[]>("logmycode.customTrackedFolders", []);
    let allFolders = Array.from(new Set([...workspaceFolders, ...customFolders]));

    let projectMappings = this._context.globalState.get<any[]>("logmycode.projectMappings", []);
    const backendUrl = vscode.workspace.getConfiguration("logmycode").get<string>("backendUrl") || "http://localhost:3000";
    const user = this._context.globalState.get<any>("logmycode.user", null);
    const token = await this._context.secrets.get("logmycode.token");

    // Inject mock demo projects for evaluation
    if (user && user.id === "demo-judge") {
      const demoProjects = [
        { path: "/Users/demo/Projects/EventsPlug-Frontend", name: "EventsPlug-Frontend" },
        { path: "/Users/demo/Projects/EventsPlug-Backend", name: "EventsPlug-Backend" },
        { path: "/Users/demo/Projects/EventsPlug-Docs", name: "EventsPlug-Docs" },
      ];
      
      let mappingUpdated = false;
      for (const dp of demoProjects) {
        if (!allFolders.includes(dp.path)) {
          allFolders.push(dp.path);
        }
        const exists = projectMappings.some((m) => m.folder_path === dp.path);
        if (!exists) {
          projectMappings.push({ folder_path: dp.path, project_name: dp.name });
          mappingUpdated = true;
        }
      }
      if (mappingUpdated) {
        await this._context.globalState.update("logmycode.projectMappings", projectMappings);
      }
    }

    let mappingsChanged = false;
    for (const folderPath of allFolders) {
      const exists = projectMappings.some((m) => m.folder_path === folderPath);
      if (!exists) {
        const folderName = path.basename(folderPath) || folderPath;
        projectMappings.push({ folder_path: folderPath, project_name: folderName });
        mappingsChanged = true;

        if (token) {
          try {
            await fetch(`${backendUrl}/api/projects`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                folderPath,
                projectName: folderName,
              }),
            });
          } catch (e) {
            console.error(`Failed to automatically sync project mapping for ${folderPath}:`, e);
          }
        }
      }
    }

    if (mappingsChanged) {
      await this._context.globalState.update("logmycode.projectMappings", projectMappings);
    }

    this._panel.webview.postMessage({
      command: "initWebview",
      state: {
        workspaceFolders: allFolders,
        customFolders,
        projectMappings,
        backendUrl,
        user,
        token,
      },
    });
  }

  private async _handleMessage(message: any) {
    const backendUrl = vscode.workspace.getConfiguration("logmycode").get<string>("backendUrl") || "http://localhost:3000";
    const token = await this._context.secrets.get("logmycode.token");

    switch (message.command) {
      case "addRepositoryFolder":
        try {
          const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            title: "Select Git Repository Folder(s) to Track",
          });

          if (selected && selected.length > 0) {
            const customFolders = this._context.globalState.get<string[]>("logmycode.customTrackedFolders", []);
            selected.forEach((uri) => {
              if (!customFolders.includes(uri.fsPath)) {
                customFolders.push(uri.fsPath);
              }
            });
            await this._context.globalState.update("logmycode.customTrackedFolders", customFolders);
            this._syncState();
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to add custom folder: ${err.message}`);
        }
        break;

      case "removeRepositoryFolder":
        try {
          let customFolders = this._context.globalState.get<string[]>("logmycode.customTrackedFolders", []);
          customFolders = customFolders.filter((f) => f !== message.folderPath);
          await this._context.globalState.update("logmycode.customTrackedFolders", customFolders);
          
          let mappings = this._context.globalState.get<any[]>("logmycode.projectMappings", []);
          mappings = mappings.filter((m) => m.folder_path !== message.folderPath);
          await this._context.globalState.update("logmycode.projectMappings", mappings);

          this._syncState();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to remove custom folder: ${err.message}`);
        }
        break;

      case "updateSettings":
        await vscode.workspace.getConfiguration("logmycode").update("backendUrl", message.backendUrl, vscode.ConfigurationTarget.Global);
        break;

      case "saveProjectMapping":
        // Save local setting cache
        let mappings = this._context.globalState.get<any[]>("logmycode.projectMappings", []);
        mappings = mappings.filter((m) => m.folder_path !== message.folderPath);
        mappings.push({ folder_path: message.folderPath, project_name: message.projectName });
        await this._context.globalState.update("logmycode.projectMappings", mappings);

        // Sync mapping to backend DB if authenticated
        if (token) {
          try {
            await fetch(`${backendUrl}/api/projects`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                folderPath: message.folderPath,
                projectName: message.projectName,
              }),
            });
          } catch (err) {
            console.error("Failed to sync project mapping to backend:", err);
          }
        }
        this._syncState();
        break;

      case "loginDemo":
        try {
          const code = await vscode.window.showInputBox({
            title: "Hackathon Demo Authentication",
            prompt: "Enter the passcode from the project description in the Google Form",
            placeHolder: "Access Code",
            password: true,
            ignoreFocusOut: true,
          });

          if (code === undefined) {
            return; // User cancelled
          }

          const res = await fetch(`${backendUrl}/api/auth/demo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });

          if (!res.ok) {
            const errorMsg = await res.text();
            let parsedError = errorMsg;
            try {
              parsedError = JSON.parse(errorMsg).error;
            } catch (e) {}
            throw new Error(parsedError || "Demo credentials refused by server");
          }

          const data = (await res.json()) as any;
          await this._context.secrets.store("logmycode.token", data.token);
          await this._context.globalState.update("logmycode.user", data.user);

          // Get projects mapping from backend DB on login
          await this._fetchProjectMappingsFromBackend(backendUrl, data.token);

          // Sync state to update folder list and user context in the webview
          await this._syncState();
        } catch (error: any) {
          this._panel.webview.postMessage({ command: "authFailed", error: error.message });
        }
        break;

      case "loginGitHub":
        try {
          // Native VS Code GitHub OAuth authentication trigger
          const session = await vscode.authentication.getSession(
            "github",
            ["read:user", "user:email"],
            { createIfNone: true }
          );

          if (!session) {
            throw new Error("GitHub login was cancelled by the user.");
          }

          const res = await fetch(`${backendUrl}/api/auth/github`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: session.accessToken }),
          });

          if (!res.ok) throw new Error("Backend authentication failed with GitHub token");

          const data = (await res.json()) as any;
          await this._context.secrets.store("logmycode.token", data.token);
          await this._context.globalState.update("logmycode.user", data.user);

          // Fetch mappings from DB
          await this._fetchProjectMappingsFromBackend(backendUrl, data.token);

          // Sync state to update folder list and user context in the webview
          await this._syncState();
        } catch (error: any) {
          this._panel.webview.postMessage({ command: "authFailed", error: error.message });
        }
        break;

      case "upgradeAccount":
        try {
          const code = await vscode.window.showInputBox({
            title: "Upgrade Account to Paid Tier",
            prompt: "Enter the passcode provided in the project description in the Google Form",
            placeHolder: "Passcode",
            password: true,
            ignoreFocusOut: true,
          });

          if (code === undefined) {
            return; // User cancelled
          }

          const res = await fetch(`${backendUrl}/api/auth/upgrade`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ code }),
          });

          if (!res.ok) {
            const errorMsg = await res.text();
            let parsedError = errorMsg;
            try {
              parsedError = JSON.parse(errorMsg).error;
            } catch (e) {}
            throw new Error(parsedError || "Upgrade code refused by server");
          }

          const data = (await res.json()) as any;
          await this._context.secrets.store("logmycode.token", data.token);
          await this._context.globalState.update("logmycode.user", data.user);

          vscode.window.showInformationMessage("Success! Your account has been upgraded to the Paid Tier.");

          // Sync state to update folder list and user context in the webview
          await this._syncState();
        } catch (error: any) {
          vscode.window.showErrorMessage(`Upgrade failed: ${error.message}`);
        }
        break;

      case "logout":
        await this._context.secrets.delete("logmycode.token");
        await this._context.globalState.update("logmycode.user", null);
        
        // Clean up demo project mappings on logout
        let currentMappings = this._context.globalState.get<any[]>("logmycode.projectMappings", []);
        currentMappings = currentMappings.filter((m) => !m.folder_path.startsWith("/Users/demo/Projects/"));
        await this._context.globalState.update("logmycode.projectMappings", currentMappings);

        this._syncState();
        break;

      case "scanCommits":
        try {
          let commitsList: Commit[] = [];
          const user = this._context.globalState.get<any>("logmycode.user", null);

          if (user && user.id === "demo-judge") {
            // Return mock commits for the Demo Judge evaluation
            commitsList = [
              {
                hash: "a1b2c3d4e5f67890123456789012345678901234",
                message: "feat: implement unified portal UI with My Tickets tab and attendee registrations",
                diff: "Created Portal page and integrated MyTicketsTab component.",
                projectName: "EventsPlug-Frontend",
              },
              {
                hash: "f6e5d4c3b2a10987654321098765432109876543",
                message: "feat: implement NestJS backend endpoints and Prisma validation schemas for portal registration",
                diff: "Created NestJS controllers and validation logic for attendee registration.",
                projectName: "EventsPlug-Backend",
              },
              {
                hash: "55f7b032c90d28a70bd4fb06f93a778e29f66554",
                message: "docs: add OpenSpec proposals and system architecture specifications for B2B/B2C dashboard integration",
                diff: "Added B2B architecture design and spec sheets.",
                projectName: "EventsPlug-Docs",
              },
              {
                hash: "748674102a1c2ada2d64511ac293a9022c8c8aa4",
                message: "refactor: optimize database query performance and add Prisma connection pool configuration",
                diff: "Increased prisma pool size and added connection limits.",
                projectName: "EventsPlug-Backend",
              }
            ];
          } else {
            for (const folder of message.folders) {
              const folderCommits = await GitService.getCommitsForDay(
                folder.folderPath,
                message.date,
                folder.projectName
              );
              commitsList.push(...folderCommits);
            }
          }

          this._panel.webview.postMessage({
            command: "commitsScanned",
            commits: commitsList,
          });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: "error", message: err.message });
        }
        break;

      case "generateSummary":
        try {
          const customApiKey = vscode.workspace.getConfiguration("logmycode").get<string>("llmApiKey") || "";
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          };

          let encryptionKey = this._context.globalState.get<string>("logmycode.encryptionKey");
          if (!encryptionKey) {
            encryptionKey = crypto.randomBytes(32).toString("hex");
            await this._context.globalState.update("logmycode.encryptionKey", encryptionKey);
            if (this._context.globalState.setKeysForSync) {
              this._context.globalState.setKeysForSync(["logmycode.encryptionKey"]);
            }
          }

          if (encryptionKey) {
            headers["X-Encryption-Key"] = encryptionKey;
          }
          if (customApiKey) {
            headers["X-LLM-Api-Key"] = customApiKey;
          }

          const res = await fetch(`${backendUrl}/api/commits`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              commits: message.commits,
              manualLogs: message.manualLogs,
              date: message.date,
              customPrompt: message.customPrompt,
              forceRegenerate: message.forceRegenerate,
            }),
          });

          if (!res.ok) {
            const errorDetails = await res.text();
            throw new Error(`Server returned error: ${errorDetails}`);
          }

          const data = (await res.json()) as any;
          this._panel.webview.postMessage({
            command: "summaryGenerated",
            summary: data.summary,
          });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: "error", message: err.message });
        }
        break;

      case "askAssistant":
        try {
          const res = await fetch(`${backendUrl}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              query: message.query,
              projectName: message.projectName,
            }),
          });

          if (!res.ok) {
            const errorDetails = await res.text();
            throw new Error(`Server returned error: ${errorDetails}`);
          }

          const data = (await res.json()) as any;
          this._panel.webview.postMessage({
            command: "assistantReply",
            reply: data.reply,
          });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: "error", message: err.message });
        }
        break;
    }
  }

  private async _fetchProjectMappingsFromBackend(backendUrl: string, token: string) {
    try {
      const res = await fetch(`${backendUrl}/api/projects`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const mappings = (await res.json()) as any[];
        // Sync local settings with backend mapping rows
        const formattedMappings = mappings.map((m) => ({
          folder_path: m.folder_path,
          project_name: m.project_name,
        }));
        await this._context.globalState.update("logmycode.projectMappings", formattedMappings);
      }
    } catch (err) {
      console.error("Failed to fetch project mappings from backend on login:", err);
    }
  }

  public dispose() {
    DailySummaryWebview.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
