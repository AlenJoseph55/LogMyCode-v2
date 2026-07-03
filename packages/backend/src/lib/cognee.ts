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

// Helper to format dataset name safely for Cognee
export function getDatasetName(userId: string, projectName: string): string {
  // Cognee dataset names should be alphanumeric or underscores
  return `user_${userId}_project_${projectName}`.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

/**
 * Adds raw text content (such as SCPP commit summaries) into Cognee for a user project dataset.
 */
export async function addMemory(userId: string, projectName: string, content: string): Promise<void> {
  const datasetName = getDatasetName(userId, projectName);
  console.log(`Ingesting content into Cognee for dataset: ${datasetName} using URL: ${getCogneeUrl()}...`);

  const formData = new FormData();
  // Wrap text in a Blob with a filename so FastAPI parses it as an UploadFile
  const blob = new Blob([content], { type: "text/plain" });
  formData.append("data", blob, "commit_memory.txt");
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

  console.log(`Successfully added data to Cognee dataset: ${datasetName}`);
}

/**
 * Runs the Cognify pipeline to process recently added raw data into the hybrid graph-vector database.
 */
export async function cognify(userId: string, projectName: string): Promise<void> {
  const datasetName = getDatasetName(userId, projectName);
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
  searchType: string = "GRAPH_COMPLETION"
): Promise<any> {
  const datasetName = getDatasetName(userId, projectName);
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

  // If the preferred search type is not supported or fails, try falling back to standard GRAPH_COMPLETION or RAG_COMPLETION
  if (!response.ok && searchType !== "GRAPH_COMPLETION") {
    console.warn(`Search type ${searchType} failed, falling back to GRAPH_COMPLETION...`);
    response = await attemptSearch("GRAPH_COMPLETION");
  }

  if (!response.ok) {
    console.warn(`GRAPH_COMPLETION failed, trying final fallback RAG_COMPLETION...`);
    response = await attemptSearch("RAG_COMPLETION");
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
  const datasetName = getDatasetName(userId, projectName);
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

  if (!targetDataset) {
    console.log(`No dataset found matching name "${datasetName}". Skipping deletion.`);
    return;
  }

  const datasetId = targetDataset.id || targetDataset.datasetId;
  if (!datasetId) {
    throw new Error(`Dataset matched name but had no valid ID`);
  }

  // Step 2: Delete by ID
  const deleteResponse = await fetch(`${getCogneeUrl()}/api/v1/datasets/${datasetId}`, {
    method: "DELETE",
    headers: getCogneeHeaders(),
  });

  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text();
    throw new Error(`Failed to delete Cognee dataset ${datasetId}: ${errorText}`);
  }

  console.log(`Successfully deleted Cognee dataset: ${datasetName} (${datasetId})`);
}

