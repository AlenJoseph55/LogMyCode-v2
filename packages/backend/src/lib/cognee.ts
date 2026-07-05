function getCogneeUrl(): string {
  return process.env.COGNEE_API_URL || "http://localhost:8000";
}

function getCogneeHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  const key = process.env.COGNEE_API_KEY || "";
  if (key) {
    if (key.startsWith("Bearer ") || key.includes(".")) {
      headers["Authorization"] = key.startsWith("Bearer ") ? key : `Bearer ${key}`;
    } else {
      headers["X-Api-Key"] = key;
    }
  }
  return headers;
}

import { getCogneeDataset, saveCogneeDataset } from "./db.js";

// Helper to format dataset name safely for Cognee
export async function getDatasetName(userId: string, projectName: string): Promise<string> {
  const safeProject = projectName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  const safeUser = userId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  
  let datasetName = await getCogneeDataset(userId, projectName);
  if (!datasetName) {
    datasetName = `user_${safeUser}_project_${safeProject}`;
    await saveCogneeDataset(userId, projectName, datasetName);
  }
  return datasetName;
}

export interface MemoryInput {
  hash: string;
  content: string;
}

/**
 * Adds multiple raw text contents (such as SCPP commit summaries) into Cognee for a user project dataset in a single batch request.
 */
export async function addMemories(userId: string, projectName: string, memories: MemoryInput[]): Promise<void> {
  if (memories.length === 0) return;
  const datasetName = await getDatasetName(userId, projectName);
  console.log(`Ingesting ${memories.length} memories into Cognee for dataset: ${datasetName} using URL: ${getCogneeUrl()}...`);

  const formData = new FormData();
  for (const memory of memories) {
    const blob = new Blob([memory.content], { type: "text/plain" });
    formData.append("data", blob, `commit_${memory.hash}.txt`);
  }
  formData.append("datasetName", datasetName);
  formData.append("run_in_background", "false");

  const response = await fetch(`${getCogneeUrl()}/api/v1/add`, {
    method: "POST",
    headers: getCogneeHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cognee add failed with status ${response.status}: ${errorText}`);
  }

  console.log(`Successfully added ${memories.length} memories to Cognee dataset: ${datasetName}`);
}

/**
 * Runs the Cognify pipeline to process recently added raw data into the hybrid graph-vector database.
 */
export async function cognify(userId: string, projectName: string): Promise<void> {
  const datasetName = await getDatasetName(userId, projectName);
  console.log(`Running Cognify pipeline on dataset: ${datasetName}...`);

  const response = await fetch(`${getCogneeUrl()}/api/v1/cognify`, {
    method: "POST",
    headers: getCogneeHeaders("application/json"),
    body: JSON.stringify({
      datasets: [datasetName],
      run_in_background: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cognee cognify failed with status ${response.status}: ${errorText}`);
  }

  console.log(`Cognify pipeline finished successfully for dataset: ${datasetName}`);
}

/**
 * Searches the Cognee graph-vector database for relevant context.
 * Falls back to RAG_COMPLETION or other search types if GRAPH_COMPLETION fails.
 */
export async function searchMemory(
  userId: string,
  projectName: string,
  query: string,
  searchType: string = "RAG_COMPLETION"
): Promise<any> {
  const datasetName = await getDatasetName(userId, projectName);
  console.log(`Searching Cognee dataset "${datasetName}" for query: "${query}" using ${searchType}...`);

  const attemptSearch = async (type: string) => {
    return await fetch(`${getCogneeUrl()}/api/v1/search`, {
      method: "POST",
      headers: getCogneeHeaders("application/json"),
      body: JSON.stringify({
        query,
        search_type: type,
        datasets: [datasetName],
      }),
    });
  };

  let response = await attemptSearch(searchType);

  // If the preferred search type is not supported or fails, try falling back to other standard search types
  if (!response.ok && searchType !== "RAG_COMPLETION") {
    console.warn(`Search type ${searchType} failed, falling back to RAG_COMPLETION...`);
    response = await attemptSearch("RAG_COMPLETION");
  }

  if (!response.ok && searchType !== "GRAPH_COMPLETION") {
    console.warn(`RAG_COMPLETION failed, trying fallback GRAPH_COMPLETION...`);
    response = await attemptSearch("GRAPH_COMPLETION");
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cognee search failed with status ${response.status}: ${errorText}`);
  }

  const results = await response.json();
  return results;
}

/**
 * Deletes a specific Cognee dataset by matching its name.
 */
export async function deleteMemory(userId: string, projectName: string): Promise<void> {
  const datasetName = await getDatasetName(userId, projectName);
  console.log(`Attempting to delete Cognee dataset: ${datasetName}...`);

  // Step 1: List all datasets to find matching ID
  const listResponse = await fetch(`${getCogneeUrl()}/api/v1/datasets`, {
    method: "GET",
    headers: getCogneeHeaders(),
  });

  if (!listResponse.ok) {
    const errorText = await listResponse.text();
    throw new Error(`Failed to list Cognee datasets: ${errorText}`);
  }

  const datasets = (await listResponse.json()) as any[];
  const targetDataset = datasets.find(
    (d: any) => d.name === datasetName || d.datasetName === datasetName || d.id === datasetName
  );

  if (targetDataset) {
    const datasetId = targetDataset.id || targetDataset.datasetId;
    if (datasetId) {
      // Step 2: Delete by ID
      try {
        const deleteResponse = await fetch(`${getCogneeUrl()}/api/v1/datasets/${datasetId}`, {
          method: "DELETE",
          headers: getCogneeHeaders(),
        });
        if (!deleteResponse.ok) {
          const errorText = await deleteResponse.text();
          console.warn(`Failed to delete Cognee dataset ${datasetId} on server: ${errorText}`);
        } else {
          console.log(`Successfully deleted Cognee dataset on server: ${datasetName} (${datasetId})`);
        }
      } catch (deleteErr) {
        console.warn(`Failed to execute DELETE request on Cognee server:`, deleteErr);
      }
    }
  }

  // Rotate to a new unique dataset name using a timestamp to bypass processing_errored locks
  const safeProject = projectName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  const safeUser = userId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  const newDatasetName = `user_${safeUser}_project_${safeProject}_${Date.now()}`;
  
  await saveCogneeDataset(userId, projectName, newDatasetName);
  console.log(`Successfully rotated to new dataset name for project "${projectName}": ${newDatasetName}`);
}

