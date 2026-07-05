export interface CommitInput {
  hash: string;
  message: string;
  diff: string;
  projectName: string;
}

export interface SCPPCommitResult {
  hash: string;
  inferredIntent: boolean;
  confidenceScore: "High" | "Medium" | "Low";
  summary: string;
  concepts: string[];
  actions: string[];
}

export async function processCommitsWithSCPP(
  commits: CommitInput[],
  apiKeyOverride?: string
): Promise<SCPPCommitResult[]> {
  if (commits.length === 0) return [];

  const groqApiKey = apiKeyOverride || process.env.GROQ_API_KEY;

  // TEMPORARILY SKIPPING SCPP API CALLS
  console.log("SCPP API call is temporarily skipped. Returning fallback results.");
  return commits.map((c) => ({
    hash: c.hash,
    inferredIntent: false,
    confidenceScore: "Low",
    summary: c.message || "No commit message provided",
    concepts: ["Git Commit"],
    actions: ["Analyzed commit hash " + c.hash],
  }));

  const maxDiffChars = parseInt(process.env.MAX_DIFF_CHARS || "1200", 10);

  // Format and truncate commits for the prompt
  const formattedCommits = commits.map((c) => {
    const truncatedDiff = c.diff ? c.diff.slice(0, maxDiffChars) : "(No diff details)";
    return {
      hash: c.hash,
      projectName: c.projectName,
      message: c.message,
      diff: truncatedDiff,
    };
  });

  const prompt = `You are a Semantic Commit Pre-Processor (SCPP). Your task is to analyze a batch of git commits (including their messages and code diffs) and output structured semantic information for each commit.

For each commit in the list:
1. Examine the diff to see what changes were made.
2. Determine if the developer's original message is vague (e.g. "wip", "fix", "update", "test", "done", "check", etc.) where intent is unclear, forcing you to infer intent solely from the diff. Set "inferredIntent" to true if you had to infer the developer's goal from the diff, and false if the developer's original message was already clear, descriptive, and explained the "why" behind the changes.
3. Rate your confidence in this analysis ("High", "Medium", or "Low") as "confidenceScore".
4. Generate a concise "summary" of the actual changes (e.g. "Refactored database pooling").
5. Extract a list of "concepts" (semantic tags like "Database connection", "OAuth authentication", "Token validation", "JWT").
6. Provide a list of specific "actions" taken in the diff (e.g. "Replaced pg.Client with pg.Pool", "Added SSL rejection configurations").

Here is the JSON list of commits to process:
${JSON.stringify(formattedCommits, null, 2)}

Provide your output strictly in JSON format. The root object MUST have a "results" key which is an array of objects.
Each object in the "results" array MUST strictly follow this structure:
{
  "hash": string (matching the input commit hash),
  "inferredIntent": boolean,
  "confidenceScore": "High" | "Medium" | "Low",
  "summary": string,
  "concepts": string[],
  "actions": string[]
}`;

  try {
    const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: groqModel,
        messages: [
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API SCPP request failed with status ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as any;
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Invalid response received from Groq API");
    }

    const parsed = JSON.parse(content);

    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("Invalid output format from Groq SCPP model");
    }

    return parsed.results as SCPPCommitResult[];
  } catch (error: any) {
    console.error("Error running SCPP pipeline:", error);
    // Return a safe fallback if the API fails or returns invalid output
    return commits.map((c) => ({
      hash: c.hash,
      inferredIntent: false,
      confidenceScore: "Low",
      summary: c.message || "No commit message provided",
      concepts: ["Git Commit"],
      actions: ["Analyzed commit hash " + c.hash],
    }));
  }
}

