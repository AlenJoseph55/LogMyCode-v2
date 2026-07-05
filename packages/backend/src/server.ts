import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dns from "dns";

// Force IPv4 DNS resolution first to bypass EC2 IPv6 network routing limitations (ENETUNREACH)
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

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
  updateUserTier,
  getProjectMappings,
  saveProjectMapping,
  getCommit,
  saveCommit,
  getDailySummary,
  saveDailySummary,
  saveCogneeDataset,
  CommitRow,
} from "./lib/db.js";
import { addMemories, cognify, searchMemory, deleteMemory } from "./lib/cognee.js";
import { processCommitsWithSCPP, CommitInput } from "./lib/scpp.js";
import { generateDailySummary, CommitSummaryInput } from "./lib/llm.js";
import { encrypt, decrypt, isEncrypted } from "./lib/crypto.js";

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
    tier?: string;
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
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; name: string; tier?: string };
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
  const { code } = req.body;
  const expectedCode = process.env.DEMO_ACCESS_CODE || "judge2026";

  if (code !== expectedCode) {
    return res.status(401).json({ error: "Invalid Demo Access Code" });
  }

  try {
    const demoUser = {
      id: "demo-judge",
      email: "judge@logmycode.com",
      name: "Demo Judge",
      tier: "paid",
    };

    // Ensure the demo user is pre-seeded in the database
    await createUser(demoUser);

    // Seed Demo commits and Cognee memories in the background
    seedDemoData(demoUser.id).catch((err) => {
      console.error("Failed to seed demo data in background:", err);
    });

    // Sign the JWT token
    const token = jwt.sign(demoUser, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: demoUser });
  } catch (error: any) {
    console.error("Demo login error:", error);
    return res.status(500).json({ error: "Failed to perform demo login" });
  }
});

/**
 * Account Upgrade Endpoint (Allows judges to upgrade their GitHub account using the demo passcode)
 */
app.post("/api/auth/upgrade", authMiddleware, async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user!.id;
  const { code } = req.body;
  const expectedCode = process.env.DEMO_ACCESS_CODE || "judge2026";

  if (code !== expectedCode) {
    return res.status(400).json({ error: "Invalid Promo Code" });
  }

  try {
    const updatedUser = await updateUserTier(userId, "paid");
    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Sign a new token with updated tier
    const token = jwt.sign(updatedUser, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: updatedUser });
  } catch (error: any) {
    console.error("Upgrade error:", error);
    return res.status(500).json({ error: error.message || "Failed to upgrade account" });
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
    const userRow = await createUser(userData);

    const userPayload = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      tier: userRow.tier || "free",
    };

    // Sign Backend JWT
    const token = jwt.sign(userPayload, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: userPayload });
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
  const userTier = authReq.user!.tier || "free";
  const encryptionKey = req.headers["x-encryption-key"] as string | undefined;
  const customApiKey = req.headers["x-llm-api-key"] as string | undefined;

  // Enforce LLM key requirement for Free tier users
  if (userTier === "free" && !customApiKey) {
    return res.status(403).json({
      error: "Free Tier users must supply their own LLM API key in settings. Please configure your API key in the extension settings tab or upgrade to the Paid SaaS Tier."
    });
  }

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
      const content = (encryptionKey && isEncrypted(cached.content)) ? decrypt(cached.content, encryptionKey) : cached.content;
      return res.json({ summary: content, cached: true });
    }

    // 2. Separate new and existing commits (Deduplication)
    const newCommits: CommitInput[] = [];
    const enrichedCommits: CommitSummaryInput[] = [];

    for (const commit of commits) {
      const existing = await getCommit(commit.hash);
      if (existing) {
        let msg = existing.message;
        let sum = existing.summary;
        let conc = existing.concepts;
        if (encryptionKey) {
          try {
            if (isEncrypted(existing.message)) msg = decrypt(existing.message, encryptionKey);
            if (isEncrypted(existing.summary)) sum = decrypt(existing.summary, encryptionKey);
            if (isEncrypted(existing.concepts)) conc = decrypt(existing.concepts, encryptionKey);
          } catch (err) {
            console.error(`Failed to decrypt cached commit ${commit.hash}:`, err);
          }
        }
        enrichedCommits.push({
          hash: existing.hash,
          projectName: existing.project_name,
          message: msg,
          inferredIntent: !!existing.inferred_intent,
          confidenceScore: existing.confidence_score as any,
          summary: sum,
          concepts: JSON.parse(conc),
          actions: [], // Retained in summary text
        });
      } else {
        newCommits.push(commit);
      }
    }

    // 3. Process new commits via SCPP and push to Cognee
    if (newCommits.length > 0) {
      console.log(`SCPP Processing ${newCommits.length} new commits...`);
      const scppResults = await processCommitsWithSCPP(newCommits, customApiKey);

      for (const result of scppResults) {
        const originalInput = newCommits.find((c) => c.hash === result.hash)!;

        const savedMessage = encryptionKey ? encrypt(originalInput.message, encryptionKey) : originalInput.message;
        const savedDiff = originalInput.diff 
          ? (encryptionKey ? encrypt(originalInput.diff, encryptionKey) : originalInput.diff) 
          : "";
        const savedSummary = encryptionKey ? encrypt(result.summary, encryptionKey) : result.summary;
        const savedConcepts = encryptionKey ? encrypt(JSON.stringify(result.concepts), encryptionKey) : JSON.stringify(result.concepts);

        // Save to cache database
        await saveCommit({
          hash: result.hash,
          userId,
          projectName: originalInput.projectName,
          message: savedMessage,
          diff: savedDiff,
          inferredIntent: result.inferredIntent,
          confidenceScore: result.confidenceScore,
          summary: savedSummary,
          concepts: savedConcepts,
        });

        enrichedCommits.push({
          ...result,
          projectName: originalInput.projectName,
          message: originalInput.message,
        });
      }

      // Ingest into Cognee memory asynchronously in the background
      const runCogneePipelineInBackground = async () => {
        console.log(`Starting background Cognee pipeline for ${newCommits.length} commits...`);

        // Group SCPP results by project
        const resultsByProject: Record<string, Array<{ hash: string; content: string }>> = {};

        for (const result of scppResults) {
          const originalInput = newCommits.find((c) => c.hash === result.hash)!;
          const cogneeIngestionText = `Commit Hash: ${result.hash}
Project Name: ${originalInput.projectName}
Original Message: "${originalInput.message}"
Inferred Developer Intent: ${result.inferredIntent}
Confidence Score: ${result.confidenceScore}
Actual Changes Summary: ${result.summary}
Concepts: ${result.concepts.join(", ")}
Actions Taken:
${result.actions.map((a) => `  - ${a}`).join("\n")}`;

          if (!resultsByProject[originalInput.projectName]) {
            resultsByProject[originalInput.projectName] = [];
          }
          resultsByProject[originalInput.projectName].push({
            hash: result.hash,
            content: cogneeIngestionText,
          });
        }

        // Upload and cognify each project
        for (const [projName, memories] of Object.entries(resultsByProject)) {
          try {
            await addMemories(userId, projName, memories);
            await cognify(userId, projName);
          } catch (err) {
            console.error(`Background Cognee pipeline failed for project "${projName}":`, err);

            // Self-healing: Automatically rotate dataset name on failure so the next scan is clean
            try {
              const safeProject = projName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
              const safeUser = userId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
              const newDatasetName = `user_${safeUser}_project_${safeProject}_${Date.now()}`;
              
              await saveCogneeDataset(userId, projName, newDatasetName);
              console.log(`Automatically rotated dataset name for project "${projName}" to: ${newDatasetName}`);
            } catch (rotateErr) {
              console.error("Failed to automatically rotate dataset name:", rotateErr);
            }
          }
        }

        console.log("Background Cognee pipeline completed.");
      };

      // Trigger background pipeline execution (fire-and-forget)
      runCogneePipelineInBackground().catch((err) => {
        console.error("Critical error in background Cognee pipeline:", err);
      });
    }

    // 4. Generate daily summary report using Groq Llama 3.3 70B
    console.log(`Generating final report summary (Custom Prompt: "${customPrompt}")...`);
    const summaryMarkdown = await generateDailySummary(enrichedCommits, manualLogs, customPrompt, customApiKey);

    // 5. Save report to DB cache
    const savedDailySummaryText = encryptionKey ? encrypt(summaryMarkdown, encryptionKey) : summaryMarkdown;
    await saveDailySummary(userId, date, savedDailySummaryText);

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
  const userTier = authReq.user!.tier || "free";

  // Enforce Paid tier check for Memory Assistant Chat
  if (userTier === "free") {
    return res.status(403).json({ 
      error: "Memory Assistant Chat is a Paid Tier feature. Please upgrade to SaaS Paid Tier or host the backend yourself to enable it." 
    });
  }

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

async function seedDemoData(userId: string) {
  console.log("Seeding demo data for Demo Judge...");
  
  const mockCommits = [
    {
      hash: "a1b2c3d4e5f67890123456789012345678901234",
      projectName: "EventsPlug-Frontend",
      message: "feat: implement unified portal UI with My Tickets tab and attendee registrations",
      diff: "Created Portal page and integrated MyTicketsTab component.",
      inferredIntent: true,
      confidenceScore: "High",
      summary: "Created the Portal landing interface with tabbed layout for attendee tickets.",
      concepts: ["Frontend", "React", "User Interface"],
    },
    {
      hash: "f6e5d4c3b2a10987654321098765432109876543",
      projectName: "EventsPlug-Backend",
      message: "feat: implement NestJS backend endpoints and Prisma validation schemas for portal registration",
      diff: "Created NestJS controllers and validation logic for attendee registration.",
      inferredIntent: true,
      confidenceScore: "High",
      summary: "Implemented registration service, validating inputs with class-validator and saving them with Prisma.",
      concepts: ["NestJS", "Database Schema", "Validation"],
    },
    {
      hash: "55f7b032c90d28a70bd4fb06f93a778e29f66554",
      projectName: "EventsPlug-Docs",
      message: "docs: add OpenSpec proposals and system architecture specifications for B2B/B2C dashboard integration",
      diff: "Added B2B architecture design and spec sheets.",
      inferredIntent: false,
      confidenceScore: "High",
      summary: "Drafted specs for the unified portal architecture.",
      concepts: ["Documentation", "System Architecture"],
    },
    {
      hash: "748674102a1c2ada2d64511ac293a9022c8c8aa4",
      projectName: "EventsPlug-Backend",
      message: "refactor: optimize database query performance and add Prisma connection pool configuration",
      diff: "Increased prisma pool size and added connection limits.",
      inferredIntent: true,
      confidenceScore: "High",
      summary: "Optimized DB connection limits to scale concurrent attendee transactions.",
      concepts: ["Prisma", "Database Tuning"],
    }
  ];

  // Group by project name to call addMemories per project
  const memoriesByProject: Record<string, Array<{ hash: string; content: string }>> = {};

  for (const c of mockCommits) {
    // 1. Save to local SQLite cache database so they are immediately loaded as cached on scan
    const existing = await getCommit(c.hash);
    if (!existing) {
      await saveCommit({
        hash: c.hash,
        userId,
        projectName: c.projectName,
        message: c.message,
        diff: c.diff,
        inferredIntent: c.inferredIntent,
        confidenceScore: c.confidenceScore,
        summary: c.summary,
        concepts: c.concepts,
      });
    }

    const ingestionText = `Commit Hash: ${c.hash}
Project Name: ${c.projectName}
Original Message: "${c.message}"
Actual Changes Summary: ${c.summary}
Concepts: ${c.concepts.join(", ")}`;

    if (!memoriesByProject[c.projectName]) {
      memoriesByProject[c.projectName] = [];
    }
    memoriesByProject[c.projectName].push({
      hash: c.hash,
      content: ingestionText,
    });

    // Also ingest into the unified "EventsPlug" project context to support root-level queries
    if (!memoriesByProject["EventsPlug"]) {
      memoriesByProject["EventsPlug"] = [];
    }
    memoriesByProject["EventsPlug"].push({
      hash: c.hash,
      content: ingestionText,
    });
  }

  // 2. Ingest into Cognee in the background so search queries work
  for (const [proj, memories] of Object.entries(memoriesByProject)) {
    try {
      await addMemories(userId, proj, memories);
      await cognify(userId, proj);
    } catch (err) {
      console.error(`Failed to ingest demo memory into Cognee for project "${proj}":`, err);
    }
  }
  
  console.log("Demo data seeding completed.");
}

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
