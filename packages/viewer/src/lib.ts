export type ViewerGraphNode = {
  id: string;
  type: string;
  label: string;
  sourceIds: string[];
};

export type ViewerGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: string;
};

export type ViewerGraphArtifact = {
  generatedAt: string;
  nodes: ViewerGraphNode[];
  edges: ViewerGraphEdge[];
};

export async function fetchGraphArtifact(input = "/api/graph", init?: RequestInit): Promise<ViewerGraphArtifact> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Failed to load graph artifact: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<ViewerGraphArtifact>;
}
