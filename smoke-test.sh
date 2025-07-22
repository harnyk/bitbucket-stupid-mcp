#!/bin/bash

# This is a simple smoke test for the bitbucket-stupid-mcp server.
# It sends a JSON-RPC request to the server to list pull requests
# and captures all output to a temporary file for inspection.

# The JSON-RPC request payload (single line).
JSON_RPC_REQUEST='{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "bitbucketgetdiff", "arguments": {"projectKey": "SPAC", "repositorySlug": "ecosystem.go", "prId": 123}}}'

# Create a temporary file for server output
TEMP_FILE=$(mktemp)

# Run the server and pipe the request to it, capturing all output to the temp file
echo "$JSON_RPC_REQUEST" | npx bitbucket-stupid-mcp &> "$TEMP_FILE"

# Read the content of the temporary file
SERVER_FULL_OUTPUT=$(cat "$TEMP_FILE")

# Clean up the temporary file
rm "$TEMP_FILE"

echo "Full Server Output:"
echo "$SERVER_FULL_OUTPUT"