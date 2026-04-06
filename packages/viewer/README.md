# @swarmvaultai/viewer

`@swarmvaultai/viewer` is the graph UI package for SwarmVault.

It is the frontend used by `swarmvault graph serve` to visualize `state/graph.json` as an interactive graph of sources, concepts, and entities.

## What It Does

The viewer loads graph data from `/api/graph` and renders:

- source nodes
- concept nodes
- entity nodes
- extracted, inferred, and conflicted edges

Its primary use is as part of the SwarmVault runtime, but the package also exports lightweight graph types and a fetch helper for custom integrations.

## Package Use

```ts
import { fetchGraphArtifact } from "@swarmvaultai/viewer";

const graph = await fetchGraphArtifact("/api/graph");
console.log(graph.nodes.length);
```

## Development

```bash
pnpm build
pnpm lint
pnpm test
```
