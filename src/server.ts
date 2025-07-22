#!/usr/bin/env node



import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const BITBUCKET_BASE_URL = 'https://git.namecheap.net';

interface ErrorResponse {
    error: { status?: number; message: string };
}

interface SuccessResponse<T> {
    data: T;
}

async function bitbucketApiRequest<T>(
    url: string,
    config?: { headers?: Record<string, string>; responseType?: string }
): Promise<SuccessResponse<T> | ErrorResponse> {
    try {
        const response = await axios.get<T>(`${BITBUCKET_BASE_URL}${url}`, {
            headers: {
                Authorization: `Bearer ${process.env.BB_TOKEN}`,
                ...config?.headers,
            },
            responseType: config?.responseType as 'json' | 'text' | 'arraybuffer' | 'blob' | 'document' | 'stream' | undefined,
        });
        return { data: response.data };
    } catch (error: any) {
        console.error(
            `Error fetching from ${url}:`,
            error.response?.status,
            error.response?.data || error.message
        );
        return {
            error: {
                status: error.response?.status,
                message: error.response?.data || error.message,
            },
        };
    }
}

function formatToolResponse(data: any): { content: [{ type: 'text'; text: string }] } {
    let textContent: string;
    if (typeof data === 'string') {
        textContent = data;
    } else if (typeof data === 'object' && data !== null && 'error' in data) {
        textContent = `Error: ${data.error.message}`;
    } else if (typeof data === 'object' && data !== null && 'data' in data) {
        textContent = JSON.stringify(data.data, null, 2);
    } else {
        textContent = JSON.stringify(data, null, 2);
    }
    return {
        content: [
            {
                type: 'text',
                text: textContent,
            },
        ],
    };
}

const server = new McpServer({
    name: 'bitbucket-mcp',
    version: '0.1.0',
    logLevel: 'debug',
});

server.registerTool(
    'bitbucketlistprs',
    {
        title: 'List My PRs',
        description:
            "Get a list of PRs where you are the author or reviewer. By default returns all PRs.",
        inputSchema: {
            role: z
                .enum(['author', 'reviewer', 'all'])
                .optional()
                .default('all'),
        },
    },
    async ({ role }: { role?: 'author' | 'reviewer' | 'all' }) => {
        
        let user:
            | { name: string; slug: string; displayName: string }
            | undefined;
        const whoamiResponse = await bitbucketApiRequest<string>(
            '/plugins/servlet/applinks/whoami'
        );
        if ('error' in whoamiResponse) {
            return formatToolResponse(
                `Error fetching user: ${whoamiResponse.error.message}`
            );
        }
        const username = whoamiResponse.data;
        

        if (username) {
            const userDetailsResponse = await bitbucketApiRequest<{ values: any[] }>(
                `/rest/api/latest/users?filter=${username}`
            );
            if ('error' in userDetailsResponse) {
                return formatToolResponse(
                    `Error fetching user details: ${userDetailsResponse.error.message}`
                );
            }
            if (userDetailsResponse.data.values && userDetailsResponse.data.values.length > 0) {
                user = userDetailsResponse.data.values[0];
            }
        }
        

        if (!user || !user.slug) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Could not determine the current user.',
                    },
                ],
            };
        }

        const prs: any[] = [];

        if (role === 'author' || role === 'all') {
            const response = await bitbucketApiRequest<{ values: any[] }>(
                `/rest/api/latest/inbox/pull-requests?state=OPEN&role=AUTHOR`
            );
            if (!('error' in response) && response.data.values) {
                prs.push(...response.data.values);
            }
        }

        if (role === 'reviewer' || role === 'all') {
            const response = await bitbucketApiRequest<{ values: any[] }>(
                `/rest/api/latest/inbox/pull-requests?state=OPEN&role=REVIEWER`
            );
            if (!('error' in response) && response.data.values) {
                prs.push(...response.data.values);
            }
        }

        const uniquePrs = prs.filter(
            (pr, index, self) => index === self.findIndex((t) => t.id === pr.id)
        );

        return formatToolResponse(
            uniquePrs.map((pr: any) => {
                return {
                    id: pr.id,
                    title: pr.title,
                    author: pr.author?.user?.displayName,
                    reviewers: pr.reviewers?.map(
                        (r: any) => r.user?.displayName
                    ),
                    state: pr.state,
                    repository: pr.destination?.repository?.full_name,
                    projectKey: pr.fromRef.repository.project.key,
                    repositorySlug: pr.fromRef.repository.slug,
                };
            })
        );
    }
);

server.registerTool(
    'bitbucketgetpr',
    {
        title: 'Get PR Info',
        description: 'Get information about a Pull Request',
        inputSchema: {
            projectKey: z.string(),
            repositorySlug: z.string(),
            prId: z.number(),
        },
    },
    async ({
        projectKey,
        repositorySlug,
        prId,
    }: {
        projectKey: string;
        repositorySlug: string;
        prId: number;
    }) => {
        const data = await bitbucketApiRequest<any>(
            `/rest/api/latest/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${prId}`
        );

        if ('error' in data) {
            return formatToolResponse(
                `Error fetching PR info: ${data.error.message}`
            );
        }

        return formatToolResponse({
            id: data.data.id,
            title: data.data.title,
            description: data.data.description,
            author: data.data.author?.user?.displayName,
            reviewers: data.data.reviewers?.map((r: any) => r.user?.displayName),
            state: data.data.state,
            created_on: new Date(data.data.createdDate).toISOString(),
            updated_on: new Date(data.data.updatedDate).toISOString(),
        });
    }
);

server.registerTool(
    'bitbucketgetdiff',
    {
        title: 'Get PR Diff',
        description: 'Get the diff of a Pull Request',
        inputSchema: {
            projectKey: z.string(),
            repositorySlug: z.string(),
            prId: z.number(),
        },
    },
    async ({
        projectKey,
        repositorySlug,
        prId,
    }: {
        projectKey: string;
        repositorySlug: string;
        prId: number;
    }) => {
        const data = await bitbucketApiRequest<string>(
            `/rest/api/latest/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${prId}.diff`,
            {
                headers: {
                    Accept: 'text/plain',
                },
                responseType: 'text',
            }
        );

        if ('error' in data) {
            return formatToolResponse(
                `Error fetching PR diff: ${data.error.message}`
            );
        }

        return {
            content: [
                {
                    type: 'text',
                    text: data.data,
                },
            ],
        };
    }
);

server.registerPrompt(
    'list-my-prs-to-review',
    {
        title: 'List my PRs to review',
        description: 'List the PRs where I am the reviewer',
    },
    () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `List the PRs where I am the reviewer`,
                },
            },
        ],
    })
);

server.registerPrompt(
    'list-my-prs-to-author',
    {
        title: 'List my PRs to author',
        description: 'List the PRs where I am the author',
    },
    () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `List the PRs where I am the author`,
                },
            },
        ],
    })
);

const transport = new StdioServerTransport();

await server.connect(transport);

