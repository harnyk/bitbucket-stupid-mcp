#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios, { AxiosRequestConfig } from 'axios';
import { z } from 'zod';

function fatal(...args: any[]): never {
    console.error(...args);
    process.exit(1);
}

const BB_BASE_URL = process.env.BB_BASE_URL || fatal('Missing BB_BASE_URL');
const BB_TOKEN = process.env.BB_TOKEN || fatal('Missing BB_TOKEN');

// --- Shared Types ---
type ToolOutput = { content: [{ type: 'text'; text: string }] };
type BitbucketError = { error: { status?: number; message: string } };
type BitbucketSuccess<T> = { data: T };
type BitbucketResponse<T> = BitbucketSuccess<T> | BitbucketError;

// --- Bitbucket API helpers ---
async function bitbucketGet<T>(
    url: string,
    config: AxiosRequestConfig = {}
): Promise<BitbucketResponse<T>> {
    try {
        const response = await axios.get<T>(`${BB_BASE_URL}${url}`, {
            headers: {
                Authorization: `Bearer ${BB_TOKEN}`,
                ...config.headers,
            },
            responseType: config.responseType || 'json',
        });
        return { data: response.data };
    } catch (error: any) {
        return {
            error: {
                status: error.response?.status,
                message: error.response?.data || error.message,
            },
        };
    }
}

function getOrThrow<T>(result: BitbucketResponse<T>): T {
    if ('error' in result) throw new Error(result.error.message);
    return result.data;
}

function format(data: unknown): ToolOutput {
    const text =
        typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text }] };
}

// --- Tool registration helper ---
function registerApiTool<Args extends z.ZodObject<any>>(
    name: string,
    schema: Args,
    title: string,
    description: string,
    logic: (args: z.infer<Args>) => Promise<unknown>
) {
    server.registerTool(
        name,
        { title, description, inputSchema: schema.shape },
        async (args: z.infer<Args>) => {
            try {
                const result = await logic(args);
                return format(result);
            } catch (e: any) {
                return format(`Unhandled error: ${e.message || e}`);
            }
        }
    );
}

const server = new McpServer({
    name: 'bitbucket-mcp',
    version: '0.1.0',
    logLevel: 'debug',
});

// --- Tool: List PRs ---
registerApiTool(
    'bitbucketlistprs',
    z.object({
        role: z.enum(['author', 'reviewer', 'all']).optional().default('all'),
    }),
    'List My PRs',
    'List pull requests where I am author or reviewer',
    async ({ role }) => {
        const username = getOrThrow(
            await bitbucketGet<string>('/plugins/servlet/applinks/whoami')
        );

        const userResp = getOrThrow(
            await bitbucketGet<{ values: any[] }>(
                `/rest/api/latest/users?filter=${username}`
            )
        );
        const user = userResp.values[0];
        if (!user?.slug) throw new Error('Failed to resolve current user slug');

        const roles =
            role === 'all' ? ['AUTHOR', 'REVIEWER'] : [role.toUpperCase()];
        const allPrs: any[] = [];

        for (const r of roles) {
            const prs = getOrThrow(
                await bitbucketGet<{ values: any[] }>(
                    `/rest/api/latest/inbox/pull-requests?state=OPEN&role=${r}`
                )
            );
            allPrs.push(...prs.values);
        }

        return allPrs
            .filter((pr, i, arr) => arr.findIndex((p) => p.id === pr.id) === i)
            .map((pr) => ({
                id: pr.id,
                title: pr.title,
                author: pr.author?.user?.displayName,
                reviewers: pr.reviewers?.map((r: any) => r.user?.displayName),
                state: pr.state,
                repository: pr.destination?.repository?.full_name,
                projectKey: pr.fromRef.repository.project.key,
                repositorySlug: pr.fromRef.repository.slug,
            }));
    }
);

// --- Tool: Get PR Info ---
registerApiTool(
    'bitbucketgetpr',
    z.object({
        projectKey: z.string(),
        repositorySlug: z.string(),
        prId: z.number(),
    }),
    'Get PR Info',
    'Retrieve information about a specific pull request',
    async ({ projectKey, repositorySlug, prId }) => {
        const d = getOrThrow(
            await bitbucketGet<any>(
                `/rest/api/latest/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${prId}`
            )
        );

        return {
            id: d.id,
            title: d.title,
            description: d.description,
            author: d.author?.user?.displayName,
            reviewers: d.reviewers?.map((r: any) => r.user?.displayName),
            state: d.state,
            created_on: new Date(d.createdDate).toISOString(),
            updated_on: new Date(d.updatedDate).toISOString(),
        };
    }
);

// --- Tool: Get PR Diff ---
registerApiTool(
    'bitbucketgetdiff',
    z.object({
        projectKey: z.string(),
        repositorySlug: z.string(),
        prId: z.number(),
    }),
    'Get PR Diff',
    'Get diff of a PR as plain text',
    async ({ projectKey, repositorySlug, prId }) => {
        return getOrThrow(
            await bitbucketGet<string>(
                `/rest/api/latest/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${prId}.diff`,
                { headers: { Accept: 'text/plain' }, responseType: 'text' }
            )
        );
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
