import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables on startup
dotenv.config(); // try process.cwd() first
const localEnvPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}

// Strict checks on startup for critical LLM api keys
const groqKey = process.env.GROQ_API_KEY;

if (!groqKey) {
  console.error("❌ CRITICAL ERROR: Missing LLM API keys on startup.");
  console.error("   - GROQ_API_KEY is not defined.");
  console.error("Please configure your .env file or environment variables.");
  process.exit(1);
}

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import {
  initDb,
  getUser,
  createUser,
  getProjectMappings,
  saveProjectMapping,
  getCommit,
  saveCommit,
  getDailySummary,
  saveDailySummary,
  CommitRow,
} from "./lib/db.js";
import { addMemory, cognify, searchMemory, deleteMemory } from "./lib/cognee.js";
import { processCommitsWithSCPP, CommitInput } from "./lib/scpp.js";
import { generateDailySummary, CommitSummaryInput } from "./lib/llm.js";

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-jwt-key";

// Middlewares
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Extend Express Request type for JWT auth user object
interface AuthenticatedRequest extends express.Request {
  user?: {
    id: string;
    email: string;
    name: string;
  };
}

// Authentication Middleware
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; name: string };
    (req as AuthenticatedRequest).user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
}

// --- Authentication Routes ---

/**
 * Demo Login Endpoint (Bypasses external APIs/DB and immediately returns a valid JWT for the Judge)
 */
app.post("/api/auth/demo", async (req, res) => {
  try {
    const demoUser = {
      id: "demo-judge",
      email: "judge@logmycode.com",
      name: "Demo Judge",
    };

    // Ensure the demo user is pre-seeded in the database
    await createUser(demoUser);

    // Sign the JWT token
    const token = jwt.sign(demoUser, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: demoUser });
  } catch (error: any) {
    console.error("Demo login error:", error);
    return res.status(500).json({ error: "Failed to perform demo login" });
  }
});

/**
 * GitHub OAuth Login Endpoint (Exchanges token, verifies with GitHub API, saves profile, returns JWT)
 */
app.post("/api/auth/github", async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) {
    return res.status(400).json({ error: "Missing GitHub accessToken" });
  }

  try {
    // 1. Fetch user profile from GitHub API
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: "Invalid GitHub access token" });
    }

    const ghUser = (await userRes.json()) as any;
    const userId = `github_${ghUser.id}`;

    // 2. Fetch email (GitHub profiles can hide emails)
    let email = ghUser.email;
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: "application/json",
        },
      });
      if (emailRes.ok) {
        const emails = (await emailRes.json()) as any[];
        const primaryEmail = emails.find((e) => e.primary && e.verified);
        if (primaryEmail) {
          email = primaryEmail.email;
        } else if (emails.length > 0) {
          email = emails[0].email;
        }
      }
    }

    if (!email) {
      email = `${ghUser.login}@users.noreply.github.com`;
    }

    const userData = {
      id: userId,
      email,
      name: ghUser.name || ghUser.login,
    };

    // Save/Update user in DB
    await createUser(userData);

    // Sign Backend JWT
    const token = jwt.sign(userData, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: userData });
  } catch (error: any) {
    console.error("GitHub Login error:", error);
    return res.status(500).json({ error: "Failed to authenticate with GitHub" });
  }
});

// --- Project Mapping Routes ---

app.post("/api/projects", authMiddleware, async (req, res) => {
  const { folderPath, projectName } = req.body;
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;

  if (!folderPath || !projectName) {
    return res.status(400).json({ error: "Missing folderPath or projectName" });
  }

  try {
    const mapping = await saveProjectMapping(userId, folderPath, projectName);
    return res.json(mapping);
  } catch (error: any) {
    console.error("Save project mapping error:", error);
    return res.status(500).json({ error: error.message || "Failed to save mapping" });
  }
});

app.get("/api/projects", authMiddleware, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;

  try {
    const mappings = await getProjectMappings(userId);
    return res.json(mappings);
  } catch (error: any) {
    console.error("Get project mappings error:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch mappings" });
  }
});

// --- Activity Pipeline Endpoint ---

app.post("/api/commits", authMiddleware, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;

  try {
    const {
      commits = [],
      manualLogs = [],
      date,
      customPrompt = "",
      forceRegenerate = false,
    } = req.body;

    if (!date) {
      return res.status(400).json({ error: "Missing date parameter" });
    }

    // 1. Check for cached summary in DB (Bypass generation unless forceRegenerate is true)
    const cached = await getDailySummary(userId, date);
    if (cached && !forceRegenerate) {
      console.log(`Returning cached daily summary for user ${userId} on date ${date}`);
      return res.json({ summary: cached.content, cached: true });
    }

    // 2. Separate new and existing commits (Deduplication)
    const newCommits: CommitInput[] = [];
    const enrichedCommits: CommitSummaryInput[] = [];

    for (const commit of commits) {
      const existing = await getCommit(commit.hash);
      if (existing) {
        enrichedCommits.push({
          hash: existing.hash,
          projectName: existing.project_name,
          message: existing.message,
          inferredIntent: !!existing.inferred_intent,
          confidenceScore: existing.confidence_score as any,
          summary: existing.summary,
          concepts: JSON.parse(existing.concepts),
          actions: [], // Retained in summary text
        });
      } else {
        newCommits.push(commit);
      }
    }

    // 3. Process new commits via SCPP and push to Cognee
    if (newCommits.length > 0) {
      console.log(`SCPP Processing ${newCommits.length} new commits...`);
      const scppResults = await processCommitsWithSCPP(newCommits);

      for (const result of scppResults) {
        const originalInput = newCommits.find((c) => c.hash === result.hash)!;

        // Save to cache database
        await saveCommit({
          hash: result.hash,
          userId,
          projectName: originalInput.projectName,
          message: originalInput.message,
          diff: originalInput.diff,
          inferredIntent: result.inferredIntent,
          confidenceScore: result.confidenceScore,
          summary: result.summary,
          concepts: result.concepts,
        });

        // Construct SCPP clean description text
        const cogneeIngestionText = `Commit Hash: ${result.hash}
Project Name: ${originalInput.projectName}
Original Message: "${originalInput.message}"
Inferred Developer Intent: ${result.inferredIntent}
Confidence Score: ${result.confidenceScore}
Actual Changes Summary: ${result.summary}
Concepts: ${result.concepts.join(", ")}
Actions Taken:
${result.actions.map((a) => `  - ${a}`).join("\n")}`;

        // Ingest into Cognee memory
        try {
          await addMemory(userId, originalInput.projectName, cogneeIngestionText);
        } catch (cogneeErr) {
          console.error(`Failed to add memory to Cognee for commit ${result.hash}:`, cogneeErr);
        }

        enrichedCommits.push({
          ...result,
          projectName: originalInput.projectName,
          message: originalInput.message,
        });
      }

      // Trigger Cognification for modified projects to build graph connections
      const modifiedProjects = Array.from(new Set(newCommits.map((c) => c.projectName)));
      for (const proj of modifiedProjects) {
        try {
          await cognify(userId, proj);
        } catch (cognifyErr) {
          console.error(`Cognify failed for project "${proj}":`, cognifyErr);
        }
      }
    }

    // 4. Generate daily summary report using Groq Llama 3.3 70B
    console.log(`Generating final report summary (Custom Prompt: "${customPrompt}")...`);
    const summaryMarkdown = await generateDailySummary(enrichedCommits, manualLogs, customPrompt);

    // 5. Save report to DB cache
    await saveDailySummary(userId, date, summaryMarkdown);

    return res.json({ summary: summaryMarkdown, cached: false });
  } catch (error: any) {
    console.error("Activity processing pipeline failed:", error);
    return res.status(500).json({ error: error.message || "Failed to process activities" });
  }
});

// --- Chat & Assistant Endpoint ---

app.post("/api/chat", authMiddleware, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const { query, projectName } = req.body;

  if (!query || !projectName) {
    return res.status(400).json({ error: "Missing query or projectName" });
  }

  try {
    // 1. Query Cognee hybrid database
    let memoryContext = "No relevant context found in local memory database.";
    try {
      const cogneeRes = await searchMemory(userId, projectName, query);
      if (cogneeRes) {
        memoryContext = typeof cogneeRes === "string" ? cogneeRes : JSON.stringify(cogneeRes, null, 2);
      }
    } catch (cogneeErr) {
      console.warn("Cognee search failed, proceeding with empty context:", cogneeErr);
    }

    // 2. Synthesize conversational response via Llama 3.3 70B
    const systemPrompt = `You are LogMyCode's Intelligent Memory Assistant.
Your task is to answer user questions about their development work for the project "${projectName}".
You must ground your answers strictly on the retrieved context from Cognee (a graph-vector knowledge base of their SCPP commits).
Be direct, developer-focused, precise, and format your response in clean Markdown.
If the context does not contain enough information, explain what is missing.`;

    const userPrompt = `Retrieved Memory Context:
"""
${memoryContext}
"""

Developer's Question: "${query}"

Synthesize your reply:`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq synthesis request failed: ${errorText}`);
    }

    const result = (await response.json()) as any;
    const reply = result.choices?.[0]?.message?.content || "Could not synthesize response.";

    return res.json({ reply });
  } catch (error: any) {
    console.error("Chat routing error:", error);
    return res.status(500).json({ error: error.message || "Failed to execute chat query" });
  }
});

// --- Admin Endpoints ---

/**
 * DELETE /api/memory (Clears a project's Cognee dataset)
 * Guarded by ADMIN_MASTER_KEY verification
 */
app.delete("/api/memory", authMiddleware, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const { projectName } = req.body;
  const adminKey = req.headers["x-admin-key"];

  if (!projectName) {
    return res.status(400).json({ error: "Missing projectName in body" });
  }

  const masterKey = process.env.ADMIN_MASTER_KEY || "super-admin-key";
  if (adminKey !== masterKey) {
    return res.status(403).json({ error: "Forbidden: Invalid ADMIN_MASTER_KEY" });
  }

  try {
    await deleteMemory(userId, projectName);
    return res.json({ message: `Successfully deleted Cognee memory for project "${projectName}"` });
  } catch (error: any) {
    console.error("Delete memory endpoint error:", error);
    return res.status(500).json({ error: error.message || "Failed to clear project dataset" });
  }
});

// Initialize database schemas, then start listening
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`🚀 LogMyCode Express Server is running on port ${PORT}`);
    });
  } catch (dbErr) {
    console.error("❌ Failed to initialize database:", dbErr);
    process.exit(1);
  }
}

startServer();
