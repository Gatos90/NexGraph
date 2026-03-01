# Index Your First Repo

This tutorial walks through indexing a GitHub repository and exploring the results.

## Prerequisites

- NexGraph running locally (see [Installation](/guide/installation))
- Database migrations applied

## Step 1: Create a Project

```bash
export API_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "tutorial-project"}')

echo $API_RESPONSE | jq .

# Save the API key
export API_KEY=$(echo $API_RESPONSE | jq -r '.apiKey')
```

## Step 2: Add a Repository

```bash
export REPO_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/repositories \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/expressjs/express.git",
    "source_type": "git_url",
    "name": "express"
  }')

export REPO_ID=$(echo $REPO_RESPONSE | jq -r '.id')
```

## Step 3: Start Indexing

```bash
curl -X POST http://localhost:3000/api/v1/repositories/$REPO_ID/index \
  -H "Authorization: Bearer $API_KEY"
```

## Step 4: Monitor Progress

```bash
# Check job status (replace JOB_ID)
curl -s http://localhost:3000/api/v1/indexing/jobs/<jobId> \
  -H "Authorization: Bearer $API_KEY" | jq '{status, phase, progress}'
```

## Step 5: Explore the Results

Once indexing completes, you can search for symbols:

```bash
curl -s "http://localhost:3000/api/v1/search?q=Router" \
  -H "Authorization: Bearer $API_KEY" | jq '.results[:3]'
```

## Next Steps

- [Query the Graph](/tutorials/query-graph) — Run Cypher queries
- [Cross-Repo Connections](/tutorials/multi-repo) — Link frontend and backend repos with cross-repo analysis
