import { SCPPCommitResult } from "./scpp.js";

export interface CommitSummaryInput extends SCPPCommitResult {
  projectName: string;
  message: string;
}

export async function generateDailySummary(
  commits: CommitSummaryInput[],
  manualLogs: string[],
  customPrompt: string,
  apiKeyOverride?: string
): Promise<string> {
  const groqApiKey = apiKeyOverride || process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY is not defined in environment variables and no custom API key was provided");
  }

  // System Prompt for Daily Summary
  const systemPrompt = `You are a professional software engineering logger. Your task is to generate a clean, executive daily development summary in Markdown format.
You will be provided with:
1. A list of SCPP-enriched Git commits (containing project names, messages, semantic summaries, and actions).
2. A list of manual activity logs written by the developer.

Guidelines for formatting and content:
- Group ALL items by Project Name (use markdown headers, e.g. "## Project Name").
- Merge commits and manual logs under their corresponding project header. If a manual log mentions a project (either directly by name or contextually), place it in that project's section.
- If a manual log does not map to any active Git repository project, create a new project section for it (e.g. if it mentions "Project Phoenix" planning, create a "## Project Phoenix" section).
- Place unassigned or generic manual logs in a "## General / Unassigned" section.
- Use professional, active voice.
- Synthesize multiple related commits into bulleted actions to avoid redundant entries.
- DO NOT just repeat the raw commit messages or low-level technical code details. Translate them into a clear async status update format that a non-technical reader (like a product manager, client, or stakeholder) can easily understand. Focus on the feature's value and user impact (e.g. "Improved checkout page interface to prevent duplicate order submissions" rather than "Refactored onClick handler in checkout button component").
- Keep technical jargon and low-level code terms to a bare minimum.
- Format the output beautifully in clean Markdown (no raw JSON in output, use bullet points, bold tags, etc.).`;

  // Constructing user input details
  const commitsData = commits.map((c) => ({
    hash: c.hash,
    projectName: c.projectName,
    developerMessage: c.message,
    scppSummary: c.summary,
    actionsTaken: c.actions,
    semanticConcepts: c.concepts,
  }));

  const userContent = `Here is the developer's work data for the day:

### Git Commits:
${JSON.stringify(commitsData, null, 2)}

### Manual Activity Logs:
${manualLogs.map((log) => `- ${log}`).join("\n")}

### User Custom Instructions:
${customPrompt ? customPrompt : "Summarize the progress at a high level. Group by project, translate technical actions into clear user-facing features or goals achieved, and keep technical code terminology to an absolute minimum so a product manager can read it."}

Please output the final daily summary in Markdown now.`;

  console.log("Generating daily summary using Groq Llama 3.3 70B...");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API daily summary request failed with status ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as any;
  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Invalid response received from Groq API");
  }

  return content.trim();
}
