# LogMyCode v2: Hybrid Graph-Vector Memory & Semantic Commit Logger

LogMyCode v2 is an intelligent developer work-logging platform and memory assistant. Built as a monorepo, it combines a **VS Code extension** and an **Express.js backend** to track, analyze, and build a persistent semantic database of your coding activities using **Cognee** (a hybrid graph-vector memory engine) and a **Semantic Commit Pre-Processor (SCPP)**.

---

## 🚀 Key Features

*   **🔑 Dual Authentication Flow:** Login natively with **GitHub OAuth** or instantly bypass external setups with a hardcoded **"Login as Judge" (Demo Mode)** returning a signed JWT.
*   **🧠 SCPP (Semantic Commit Pre-Processor):** Converts noisy commits (e.g., `"wip"`, `"fix"`) into rich semantic descriptions, modifications, and action summaries using **Gemini Flash**.
*   **📊 Unified Activity Grouping:** Maps local folder paths to custom project names and aggregates git commits with manual logs.
*   **🕸️ Cognee Integration:** Ingests SCPP summaries into local Cognee (Docker port `8000`), building a queryable knowledge graph-vector store.
*   **💬 Memory Assistant Chat:** Chat interface inside VS Code to query your codebase history (e.g., *"What database changes did I make this week?"*).
*   **💡 Dynamic Daily Summaries:** Generates clean daily summary reports using **Groq Llama 3.3 70B** with custom instruction inputs.
*   **💾 Flexible Data Cache:** Auto-configured local **SQLite** fallback (zero-config startup) with full support for **Postgres** when a database URL is provided.

---

## 📁 Repository Structure

```
LogMyCode-v2/
├── package.json
├── pnpm-workspace.yaml
├── README.md                 # Project Overview & Setup
├── CLAUDE.md                 # Development Reference & Commands
└── packages/
    ├── backend/              # Node/Express API Server
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── server.ts     # Server entrypoint & route handlers
    │       └── lib/
    │           ├── db.ts     # Database (SQLite & Postgres caching layer)
    │           ├── cognee.ts # Local Cognee REST API helper client
    │           ├── scpp.ts   # SCPP analyzer (Gemini Flash interface)
    │           └── llm.ts    # Daily Summary Generator (Groq Llama 70B interface)
    └── vscode-extension/     # VS Code extension source
        ├── package.json
        ├── tsconfig.json
        ├── src/
        │   ├── extension.ts  # Extension registration and commands
        │   ├── GitService.ts # Local repository git command client
        │   └── DailySummaryWebview.ts # Multi-tab Webview controller
        └── media/
            ├── style.css     # Premium, adaptive glassmorphism stylesheet
            └── script.js     # Webview interface event handlers
```

---

## ⚙️ Environment Configuration

Create a `.env` file inside `packages/backend/` with the following variables:

```env
# Server Configuration
PORT=3000
JWT_SECRET=super-secret-jwt-key

# LLM Providers (Strictly required on startup)
GEMINI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key

# Cognee Engine
COGNEE_API_URL=http://localhost:8000
COGNEE_API_KEY=your_cognee_api_key_if_auth_enabled

# Database Target (Optional - Defaults to local SQLite logmycode.db if empty)
DATABASE_URL=postgresql://user:password@localhost:5432/logmycode

# Token/Model configurations (Optional)
MAX_DIFF_CHARS=1200
GEMINI_MODEL=gemini-2.0-flash
```

---

## 🛠️ Quick Start Guide

### 1. Prerequisites
*   **Node.js:** `v18.x` or higher (tested on `v22.x`)
*   **pnpm:** `v9.x` or higher
*   **Cognee:** Ensure a local Cognee instance is running (usually via Docker: `docker run -d -p 8000:8000 cognee/cognee`).

### 2. Installation
Install all dependencies for the workspace packages:
```bash
pnpm install
```

### 3. Running the Backend
From the workspace root, compile and start the backend:
```bash
pnpm --filter backend run build
pnpm --filter backend run dev
```

### 4. Running the VS Code Extension
1. Open the workspace root directory in VS Code.
2. Press `F5` or select **Run and Debug > Launch Extension** from the sidebar.
3. This opens a new Extension Development Host window.
4. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for **LogMyCode: Show Dashboard**.

---

## 🧪 Demo Verification Queries

Once seeded or when commits are added, test the **Memory Assistant** inside the extension:
*   `"What database changes did I make this week?"` (Tests SCPP concept mapping and vector retrieval)
*   `"Why did we switch from Client to Pool in db.ts?"` (Tests graph-vector connection reasoning)
*   `"What was I working on before the last release?"` (Tests temporal query resolution)