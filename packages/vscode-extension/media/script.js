(function () {
  const vscode = acquireVsCodeApi();

  // Keep local reference to state
  let state = {
    activeTab: "summary",
    user: null,
    token: null,
    backendUrl: "http://localhost:3000",
    projectMappings: [], // list of { folder_path, project_name }
    workspaceFolders: [], // list of folder paths
    customFolders: [], // list of custom folder paths
    selectedFolders: [], // list of folders checked for scanning
    manualLogs: [],
    commits: [], // active list of commits
    chatHistory: [], // list of { role: 'user'|'bot', text: string }
  };

  // DOM Elements
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  // Summary Tab elements
  const dateInput = document.getElementById("summary-date");
  const customPromptInput = document.getElementById("custom-prompt");
  const repoMappingContainer = document.getElementById("repo-mappings");
  const commitListContainer = document.getElementById("commit-list");
  const manualLogInput = document.getElementById("manual-log-input");
  const addManualLogBtn = document.getElementById("add-manual-log-btn");
  const manualLogsList = document.getElementById("manual-logs-list");
  const btnScanCommits = document.getElementById("btn-scan-commits");
  const btnGenerateSummary = document.getElementById("btn-generate-summary");
  const btnRegenerateSummary = document.getElementById("btn-regenerate-summary");
  const summaryOutputContainer = document.getElementById("summary-output-container");

  // Chat Tab elements
  const chatContainer = document.getElementById("chat-container");
  const chatProjectSelect = document.getElementById("chat-project-select");
  const chatInput = document.getElementById("chat-input");
  const btnSendChat = document.getElementById("btn-send-chat");
  const btnClearChat = document.getElementById("btn-clear-chat");

  // Settings Tab elements
  const authStatus = document.getElementById("auth-status");
  const userProfile = document.getElementById("user-profile");
  const backendUrlInput = document.getElementById("backend-url");
  const btnSaveSettings = document.getElementById("btn-save-settings");
  const btnLoginDemo = document.getElementById("btn-login-demo");
  const btnLoginGithub = document.getElementById("btn-login-github");
  const btnLogout = document.getElementById("btn-logout");

  // Set Today as default date
  const today = new Date().toISOString().split("T")[0];
  dateInput.value = today;

  // Initialize
  const oldState = vscode.getState();
  if (oldState) {
    state = { ...state, ...oldState };
    applyState();
  }

  // Handle messages from Extension
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.command) {
      case "initWebview":
        state.workspaceFolders = message.state.workspaceFolders;
        state.customFolders = message.state.customFolders || [];
        state.projectMappings = message.state.projectMappings || [];
        state.selectedFolders = message.state.selectedFolders || message.state.workspaceFolders;
        state.backendUrl = message.state.backendUrl || "http://localhost:3000";
        state.user = message.state.user;
        state.token = message.state.token;
        applyState();
        autoScanCommits();
        break;

      case "authSuccess":
        state.user = message.user;
        state.token = message.token;
        saveState();
        applyState();
        break;

      case "authFailed":
        alert(`Authentication failed: ${message.error}`);
        break;

      case "commitsScanned":
        state.commits = message.commits;
        saveState();
        renderCommits();
        break;

      case "summaryGenerated":
        hideLoadingState();
        renderSummary(message.summary);
        break;

      case "assistantReply":
        removeTypingIndicator();
        addChatMessage("bot", message.reply);
        break;

      case "error":
        hideLoadingState();
        removeTypingIndicator();
        if (message.message && message.message.includes("Memory Assistant")) {
          addChatMessage("bot", `<span style="color: #ff5252; font-weight: bold;">⚠️ ${message.message}</span>`);
        } else {
          alert(`Error: ${message.message}`);
        }
        break;
    }
  });

  // --- State Application & Rendering ---

  function saveState() {
    vscode.setState(state);
  }

  function applyState() {
    // 1. Backend URL
    backendUrlInput.value = state.backendUrl;

    // 2. Active Tab
    switchTab(state.activeTab);

    // 3. Auth UI
    const overlay = document.getElementById("auth-overlay");
    const upgradeSection = document.getElementById("upgrade-tier-section");
    if (state.token && state.user) {
      if (overlay) overlay.style.display = "none";
      authStatus.className = "status-dot online";
      userProfile.innerHTML = `Signed in as: <strong>${state.user.name}</strong> (${state.user.email})`;
      btnLoginDemo.style.display = "none";
      btnLoginGithub.style.display = "none";
      btnLogout.style.display = "inline-block";

      if (state.user.tier === "free") {
        if (upgradeSection) upgradeSection.style.display = "block";
      } else {
        if (upgradeSection) upgradeSection.style.display = "none";
      }
    } else {
      if (overlay) overlay.style.display = "flex";
      authStatus.className = "status-dot offline";
      userProfile.innerHTML = "Not authenticated";
      btnLoginDemo.style.display = "inline-block";
      btnLoginGithub.style.display = "inline-block";
      btnLogout.style.display = "none";
      if (upgradeSection) upgradeSection.style.display = "none";
    }

    // 4. Render Repository mappings
    renderRepoMappings();

    // 5. Render Commits list
    renderCommits();

    // 6. Render Manual log items
    renderManualLogs();

    // 7. Render Chat History
    renderChatHistory();

    // 8. Update Chat Project Select options
    updateChatProjectSelect();
  }

  function autoScanCommits() {
    const dateVal = dateInput.value;
    if (!dateVal) return;

    const scanFolders = [];
    document.querySelectorAll(".repo-checkbox").forEach((cb) => {
      if (cb.checked) {
        const fPath = cb.getAttribute("data-path");
        const row = cb.closest(".repo-mapping-row");
        const inputVal = row.querySelector(".repo-input").value.trim();
        scanFolders.push({ folderPath: fPath, projectName: inputVal });
      }
    });

    if (scanFolders.length > 0) {
      vscode.postMessage({
        command: "scanCommits",
        date: dateVal,
        folders: scanFolders,
      });
    }
  }

  function switchTab(tabId) {
    state.activeTab = tabId;
    saveState();

    tabButtons.forEach((btn) => {
      if (btn.getAttribute("data-tab") === tabId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    tabContents.forEach((content) => {
      if (content.id === `${tabId}-tab`) {
        content.classList.add("active");
      } else {
        content.classList.remove("active");
      }
    });
  }

  function renderRepoMappings() {
    repoMappingContainer.innerHTML = "";
    if (state.workspaceFolders.length === 0) {
      repoMappingContainer.innerHTML = `<div style="color: var(--vscode-descriptionForeground)">No folders open in VS Code.</div>`;
      return;
    }

    state.workspaceFolders.forEach((folderPath) => {
      // Find custom mapping
      const mapping = state.projectMappings.find((m) => m.folder_path === folderPath);
      // Fallback name is folder name
      const folderName = folderPath.split("/").pop() || folderPath;
      const projectName = mapping ? mapping.project_name : folderName;

      const isCustom = state.customFolders.includes(folderPath);
      const isChecked = state.selectedFolders.includes(folderPath);

      const row = document.createElement("div");
      row.className = "repo-mapping-row";
      row.innerHTML = `
        <input type="checkbox" class="repo-checkbox" ${isChecked ? "checked" : ""} data-path="${folderPath}">
        <span class="repo-path" title="${folderPath}">${folderName}</span>
        <input type="text" class="repo-input" value="${projectName}" data-path="${folderPath}" placeholder="Project Name">
        ${isCustom ? `<button class="btn-remove-folder" data-path="${folderPath}" style="background: transparent; border: none; color: #ff5252; cursor: pointer; font-size: 16px; font-weight: bold; margin-left: 8px;">&times;</button>` : ""}
      `;

      // Event listener for Checkbox
      row.querySelector(".repo-checkbox").addEventListener("change", (e) => {
        const checked = e.target.checked;
        if (checked) {
          if (!state.selectedFolders.includes(folderPath)) {
            state.selectedFolders.push(folderPath);
          }
        } else {
          state.selectedFolders = state.selectedFolders.filter((f) => f !== folderPath);
        }
        saveState();
      });

      // Event listener for custom folder removal button
      if (isCustom) {
        row.querySelector(".btn-remove-folder").addEventListener("click", () => {
          vscode.postMessage({
            command: "removeRepositoryFolder",
            folderPath: folderPath,
          });
        });
      }

      // Event listener for project name text edit (with blur to trigger save)
      row.querySelector(".repo-input").addEventListener("blur", (e) => {
        const value = e.target.value.trim();
        if (value) {
          vscode.postMessage({
            command: "saveProjectMapping",
            folderPath: folderPath,
            projectName: value,
          });
        }
      });

      repoMappingContainer.appendChild(row);
    });
  }

  function renderCommits() {
    commitListContainer.innerHTML = "";
    if (state.commits.length === 0) {
      commitListContainer.innerHTML = `<div style="color: var(--vscode-descriptionForeground); padding: 10px;">No commits found on this date. Click "Scan Commits" to search.</div>`;
      return;
    }

    state.commits.forEach((commit) => {
      const item = document.createElement("div");
      item.className = "commit-item";
      item.innerHTML = `
        <div class="commit-header">
          <div class="commit-info">
            <span class="commit-hash">${commit.hash.slice(0, 7)}</span>
            <span class="commit-msg">${commit.message}</span>
          </div>
          <span class="diff-toggle">View Diff ▼</span>
        </div>
        <div class="commit-diff-container">
          <pre class="diff-text"></pre>
        </div>
      `;

      // Click header to toggle diff visibility
      const header = item.querySelector(".commit-header");
      const diffContainer = item.querySelector(".commit-diff-container");
      const toggleBtn = item.querySelector(".diff-toggle");
      const diffTextNode = item.querySelector(".diff-text");

      header.addEventListener("click", () => {
        const active = diffContainer.classList.toggle("active");
        toggleBtn.textContent = active ? "Hide Diff ▲" : "View Diff ▼";

        if (active && diffTextNode.innerHTML === "") {
          // Format diff lines with colors
          const formattedDiff = formatDiffText(commit.diff);
          diffTextNode.innerHTML = formattedDiff;
        }
      });

      commitListContainer.appendChild(item);
    });
  }

  function formatDiffText(diff) {
    if (!diff) return "(No diff content)";
    return diff
      .split("\n")
      .map((line) => {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          return `<span class="diff-addition">${escapeHtml(line)}</span>`;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          return `<span class="diff-deletion">${escapeHtml(line)}</span>`;
        } else {
          return escapeHtml(line);
        }
      })
      .join("\n");
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderManualLogs() {
    manualLogsList.innerHTML = "";
    state.manualLogs.forEach((log, index) => {
      const item = document.createElement("li");
      item.className = "manual-log-item";
      item.innerHTML = `
        <span>${log}</span>
        <button class="manual-log-delete" data-index="${index}">&times;</button>
      `;

      item.querySelector(".manual-log-delete").addEventListener("click", () => {
        state.manualLogs.splice(index, 1);
        saveState();
        renderManualLogs();
      });

      manualLogsList.appendChild(item);
    });
  }

  function renderSummary(summary) {
    const htmlOutput = parseMarkdown(summary);
    summaryOutputContainer.innerHTML = `<div class="summary-output">${htmlOutput}</div>`;
  }

  function showLoadingState(msg = "Generating Daily Summary...") {
    btnGenerateSummary.disabled = true;
    btnRegenerateSummary.disabled = true;
    summaryOutputContainer.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; color: var(--accent-cyan)">
        <div class="typing-indicator" style="margin-bottom: 12px;">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
        <div>${msg}</div>
      </div>
    `;
  }

  function hideLoadingState() {
    btnGenerateSummary.disabled = false;
    btnRegenerateSummary.disabled = false;
  }

  // --- Simple Markdown Formatter ---
  function parseMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);
    
    // Headers
    html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
    html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
    html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>");
    
    // Unordered lists
    html = html.replace(/^\s*[-*]\s+(.*$)/gim, "<li>$1</li>");
    
    // Wrap lists in ul
    html = html.replace(/(<li>.*<\/li>)/gim, "<ul>$1</ul>");
    // Deduplicate nested ul tags
    html = html.replace(/<\/ul>\s*<ul>/gim, "");

    // Clean paragraph formatting and line splits (avoiding double breaks)
    const lines = html.split("\n");
    const processedLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (
        trimmed.startsWith("<h2>") ||
        trimmed.startsWith("<h3>") ||
        trimmed.startsWith("<h1>") ||
        trimmed.startsWith("<ul>") ||
        trimmed.startsWith("</ul>") ||
        trimmed.startsWith("<li>") ||
        trimmed.startsWith("</h")
      ) {
        return trimmed;
      }
      return `<p>${trimmed}</p>`;
    });
    
    return processedLines.filter((l) => l !== "").join("\n");
  }

  // --- Chat/Assistant Methods ---

  function updateChatProjectSelect() {
    // Collect all distinct active project names
    const projects = new Set();
    state.workspaceFolders.forEach((folderPath) => {
      const mapping = state.projectMappings.find((m) => m.folder_path === folderPath);
      const folderName = folderPath.split("/").pop() || folderPath;
      projects.add(mapping ? mapping.project_name : folderName);
    });

    chatProjectSelect.innerHTML = "";
    if (projects.size === 0) {
      chatProjectSelect.innerHTML = `<option value="">No Active Projects</option>`;
      return;
    }

    projects.forEach((projName) => {
      const opt = document.createElement("option");
      opt.value = projName;
      opt.textContent = projName;
      chatProjectSelect.appendChild(opt);
    });
  }

  function renderChatHistory() {
    chatContainer.innerHTML = "";
    state.chatHistory.forEach((msg) => {
      const bubble = document.createElement("div");
      bubble.className = `chat-message ${msg.role}`;
      bubble.innerHTML = parseMarkdown(msg.text);
      chatContainer.appendChild(bubble);
    });
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function addChatMessage(role, text) {
    state.chatHistory.push({ role, text });
    saveState();
    renderChatHistory();
  }

  function showTypingIndicator() {
    const indicator = document.createElement("div");
    indicator.id = "chat-typing-indicator";
    indicator.className = "chat-message bot typing-indicator";
    indicator.innerHTML = `
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    `;
    chatContainer.appendChild(indicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function removeTypingIndicator() {
    const indicator = document.getElementById("chat-typing-indicator");
    if (indicator) {
      indicator.remove();
    }
  }

  // --- DOM Event Listeners ---

  // Tab switcher
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.getAttribute("data-tab"));
    });
  });

  // Settings: Save URL
  btnSaveSettings.addEventListener("click", () => {
    const url = backendUrlInput.value.trim();
    if (url) {
      state.backendUrl = url;
      saveState();
      vscode.postMessage({
        command: "updateSettings",
        backendUrl: url,
      });
      alert("Settings saved successfully!");
    }
  });

  // Settings Auth buttons
  btnLoginDemo.addEventListener("click", () => {
    vscode.postMessage({ command: "loginDemo" });
  });

  btnLoginGithub.addEventListener("click", () => {
    vscode.postMessage({ command: "loginGitHub" });
  });

  // Overlay Auth buttons
  const overlayLoginDemo = document.getElementById("overlay-btn-login-demo");
  const overlayLoginGithub = document.getElementById("overlay-btn-login-github");
  if (overlayLoginDemo) {
    overlayLoginDemo.addEventListener("click", () => {
      vscode.postMessage({ command: "loginDemo" });
    });
  }
  if (overlayLoginGithub) {
    overlayLoginGithub.addEventListener("click", () => {
      vscode.postMessage({ command: "loginGitHub" });
    });
  }

  btnLogout.addEventListener("click", () => {
    vscode.postMessage({ command: "logout" });
  });

  const btnUpgradeAccount = document.getElementById("btn-upgrade-account");
  if (btnUpgradeAccount) {
    btnUpgradeAccount.addEventListener("click", () => {
      vscode.postMessage({ command: "upgradeAccount" });
    });
  }

  // Daily Summary: Add Manual Log
  addManualLogBtn.addEventListener("click", () => {
    const logVal = manualLogInput.value.trim();
    if (logVal) {
      state.manualLogs.push(logVal);
      manualLogInput.value = "";
      saveState();
      renderManualLogs();
    }
  });

  manualLogInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addManualLogBtn.click();
    }
  });

  // Daily Summary: Scan Commits
  btnScanCommits.addEventListener("click", () => {
    const dateVal = dateInput.value;
    if (!dateVal) {
      alert("Please select a date first");
      return;
    }

    // Pack currently checked folders with their mapped names
    const scanFolders = [];
    document.querySelectorAll(".repo-checkbox").forEach((cb) => {
      if (cb.checked) {
        const fPath = cb.getAttribute("data-path");
        const row = cb.closest(".repo-mapping-row");
        const inputVal = row.querySelector(".repo-input").value.trim();
        scanFolders.push({ folderPath: fPath, projectName: inputVal });
      }
    });

    if (scanFolders.length === 0) {
      alert("Please check at least one folder to scan");
      return;
    }

    vscode.postMessage({
      command: "scanCommits",
      date: dateVal,
      folders: scanFolders,
    });
  });

  // Daily Summary: Generate
  btnGenerateSummary.addEventListener("click", () => {
    triggerGenerate(false);
  });

  // Daily Summary: Regenerate
  btnRegenerateSummary.addEventListener("click", () => {
    triggerGenerate(true);
  });

  function triggerGenerate(forceRegenerate) {
    if (!state.token) {
      alert("You must login on the Settings tab before generating a summary.");
      switchTab("settings");
      return;
    }

    const dateVal = dateInput.value;
    if (!dateVal) {
      alert("Please select a date");
      return;
    }

    showLoadingState(forceRegenerate ? "Force Regenerating Daily Summary..." : "Generating Daily Summary...");
    vscode.postMessage({
      command: "generateSummary",
      date: dateVal,
      commits: state.commits,
      manualLogs: state.manualLogs,
      customPrompt: customPromptInput.value.trim(),
      forceRegenerate: forceRegenerate,
    });
  }

  // Assistant: Chat
  btnSendChat.addEventListener("click", () => {
    const query = chatInput.value.trim();
    const projName = chatProjectSelect.value;

    if (!state.token) {
      alert("Please login on the Settings tab first");
      return;
    }

    if (!query) return;
    if (!projName) {
      alert("Please select an active project to query");
      return;
    }

    // Add user question to UI
    addChatMessage("user", query);
    chatInput.value = "";

    // Show typing bubble
    showTypingIndicator();

    // Request answer from Extension
    vscode.postMessage({
      command: "askAssistant",
      query: query,
      projectName: projName,
    });
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      btnSendChat.click();
    }
  });

  if (btnClearChat) {
    btnClearChat.addEventListener("click", () => {
      state.chatHistory = [];
      renderChatHistory();
      saveState();
    });
  }

  // Add Local Folder button trigger
  const btnAddFolder = document.getElementById("btn-add-folder");
  if (btnAddFolder) {
    btnAddFolder.addEventListener("click", () => {
      vscode.postMessage({ command: "addRepositoryFolder" });
    });
  }

})();
